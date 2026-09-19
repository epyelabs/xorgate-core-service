import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The transfer engine (transfer-device-ownership Phase 2).
 *
 * What these tests are actually defending is ORDER. A transfer writes three
 * facts that cannot be one transaction — `devices.workspace_id`, the retained
 * config's `scope`, and the IoT thing's tenancy attributes — and putting the
 * attribute write ahead of the publish is what caused the ~50-minute outage on
 * 2026-09-18. So the load-bearing assertions here are:
 *
 *   - the publish happens BEFORE the attribute write, with nothing between them;
 *   - the publish goes out at the device's UNCHANGED `config_rev` (bumping it
 *     arms the reconciler's republish loop);
 *   - a failed publish ROLLS BACK the workspace and never reaches the attribute
 *     write, because attributes ahead of config is the unrecoverable direction;
 *   - a failed ATTRIBUTE write does not roll back, because by then the device
 *     has already been instructed and the DB is the authority.
 *
 * The db is faked rather than mocked per call: `select` is a per-table FIFO of
 * scripted result sets (the engine's reads are deterministic in order), and
 * every write is recorded so the assertions can read the sequence back.
 */

// ---- AWS ------------------------------------------------------------------

const iotSend = vi.fn();
class DescribeThingCommand {
  constructor(public input: unknown) {}
}
class UpdateThingCommand {
  constructor(public input: unknown) {}
}
vi.mock('@aws-sdk/client-iot', () => ({
  IoTClient: class {
    send = iotSend;
  },
  DescribeThingCommand,
  UpdateThingCommand,
}));

const dataSend = vi.fn(async () => ({}));
class PublishCommand {
  constructor(public input: unknown) {}
}
vi.mock('@aws-sdk/client-iot-data-plane', () => ({ PublishCommand }));
vi.mock('../src/services/iot-data', () => ({ iotDataClient: async () => ({ send: dataSend }) }));

const ensureChannelTags = vi.fn(async () => 2);
vi.mock('../src/services/live-credentials', () => ({ ensureChannelTags }));

// ---- db -------------------------------------------------------------------

type Row = Record<string, unknown>;
interface Write {
  op: 'insert' | 'update' | 'delete';
  table: string;
  values?: Row;
}

/** Scripted SELECT results, FIFO per table name. */
const selectQueue = new Map<string, Row[][]>();
/** Every write, in order, so ordering can be asserted against the AWS calls. */
const writes: Write[] = [];
/** Interleaved log of writes and AWS calls — the actual sequence under test. */
const timeline: string[] = [];

function queueSelect(table: string, rows: Row[]): void {
  const existing = selectQueue.get(table) ?? [];
  existing.push(rows);
  selectQueue.set(table, existing);
}

function nextSelect(table: string): Row[] {
  const queue = selectQueue.get(table);
  if (!queue || queue.length === 0) return [];
  return queue.shift()!;
}

vi.mock('../src/db/index', async () => {
  const schema = await import('../src/db/schema');
  /** drizzle tables carry their SQL name on a well-known symbol; read it by value instead. */
  const nameOf = (table: unknown): string => {
    for (const [key, value] of Object.entries(schema)) {
      if (value === table) return key;
    }
    return 'unknown';
  };

  const thenable = <T>(resolve: () => T) => {
    const self: Record<string, unknown> = {};
    for (const k of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy', 'returning']) {
      self[k] = (...args: unknown[]) => {
        if (k === 'from' && args[0] !== undefined) self.__table = nameOf(args[0]);
        return self;
      };
    }
    self.then = (onFulfilled: (v: T) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => resolve())
        .then(onFulfilled, onRejected);
    self.catch = (onRejected: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => resolve())
        .catch(onRejected);
    return self;
  };

  const db = {
    select: () => {
      const chain = thenable(() => nextSelect(chain.__table as string)) as Record<
        string,
        unknown
      > & { __table?: string };
      return chain;
    },
    insert: (table: unknown) => ({
      values: (values: Row) => {
        const row = { id: `${nameOf(table)}-row-1`, ...values };
        return thenable(() => {
          writes.push({ op: 'insert', table: nameOf(table), values });
          timeline.push(`insert:${nameOf(table)}`);
          return [row];
        });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) =>
        thenable(() => {
          writes.push({ op: 'update', table: nameOf(table), values });
          timeline.push(`update:${nameOf(table)}`);
          return nextSelect(`${nameOf(table)}:update`);
        }),
    }),
    delete: (table: unknown) =>
      thenable(() => {
        writes.push({ op: 'delete', table: nameOf(table) });
        timeline.push(`delete:${nameOf(table)}`);
        return [];
      }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { schema, db };
});

const { transferDevice, previewTransfer, reconcileStaleTransfers, TransferError, transferAdoption } =
  await import(
  '../src/services/device-transfer'
);

// ---- fixtures -------------------------------------------------------------

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const WS_OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_NEW = 'bbbbbbbb-0000-4000-8000-000000000001';
const ORG_A = 'cccccccc-0000-4000-8000-00000000000a';
const ORG_B = 'cccccccc-0000-4000-8000-00000000000b';

function deviceRow(over: Row = {}): Row {
  return {
    id: DEVICE,
    name: 'Tacloban 01',
    serial: 'xg-abc123',
    status: 'online',
    workspaceId: WS_OLD,
    workspaceName: 'Epye',
    organizationId: ORG_A,
    organizationName: 'Alocate',
    config: {},
    configRev: 42,
    reportedConfig: null,
    ...over,
  };
}

function targetRow(organizationId = ORG_A): Row {
  return {
    id: WS_NEW,
    name: 'RJD Transport',
    organizationId,
    organizationName: organizationId === ORG_A ? 'Alocate' : 'CaingTrucking',
  };
}

/**
 * Queue the reads `previewTransfer` makes, in order, for a transfer that is
 * allowed to proceed. `attachments` is only read on a cross-org move.
 */
function scriptPreflight(opts: {
  device?: Row;
  target?: Row;
  collision?: boolean;
  attachments?: Row[];
  runningRuns?: number;
  openSessions?: number;
  staleTokens?: number;
  channels?: number;
} = {}): void {
  const device = opts.device ?? deviceRow();
  const target = opts.target ?? targetRow();
  queueSelect('devices', [device]); // deviceTenancy
  queueSelect('workspaces', [target]); // workspaceTenancy
  queueSelect('devices', opts.collision ? [{ id: 'other' }] : []); // serial collision
  queueSelect('deviceTransfers', []); // reconcileStaleTransfers: nothing stale
  queueSelect('deviceTransfers', []); // transferInProgress
  if (device.organizationId !== target.organizationId) {
    queueSelect('workflowAttachments', opts.attachments ?? []);
  }
  queueSelect('workflowRuns', [{ n: opts.runningRuns ?? 0 }]);
  queueSelect('mediaSessions', [{ n: opts.openSessions ?? 0 }]);
  queueSelect('sessionTokens', [{ n: opts.staleTokens ?? 0 }]);
  queueSelect('kvsChannels', [{ n: opts.channels ?? 2 }]);
}

/** Queue the reads `transferDevice` makes AFTER the pre-flight. */
function scriptTransferTail(opts: { device?: Row; moved?: boolean } = {}): void {
  const device = opts.device ?? deviceRow({ workspaceId: WS_NEW });
  // The guarded UPDATE devices ... RETURNING
  queueSelect('devices:update', opts.moved === false ? [] : [device]);
  // publishDeviceConfigOnly -> deviceScope (devices join workspaces)
  queueSelect('devices', [{ workspaceId: WS_NEW, organizationId: device.organizationId }]);
  // publishRetainedConfig -> deviceHardwareBlock
  queueSelect('devices', []);
  // currentReportedConfig
  queueSelect('devices', [{ reportedConfig: device.reportedConfig ?? null }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.clear();
  writes.length = 0;
  timeline.length = 0;
  dataSend.mockImplementation(async () => {
    timeline.push('publish');
    return {};
  });
  iotSend.mockImplementation(async (cmd: unknown) => {
    timeline.push(cmd instanceof UpdateThingCommand ? 'updateThing' : 'describeThing');
    return {};
  });
  ensureChannelTags.mockResolvedValue(2);
});

// ---------------------------------------------------------------------------

describe('transferDevice: same-org', () => {
  it('moves the workspace, publishes, then writes the attributes — in that order', async () => {
    scriptPreflight();
    scriptTransferTail();

    const summary = await transferDevice({
      deviceId: DEVICE,
      toWorkspaceId: WS_NEW,
      actor: { userId: 'user-1' },
    });

    expect(summary.from).toEqual({ workspaceId: WS_OLD, organizationId: ORG_A });
    expect(summary.to).toEqual({ workspaceId: WS_NEW, organizationId: ORG_A });
    expect(summary.crossOrg).toBe(false);
    expect(summary.scopeAttributes).toBe('written');
    expect(summary.detachedWorkflowAttachments).toEqual([]);

    // THE assertion this whole plan exists for: instruction before enforcement,
    // and nothing between them.
    const publishAt = timeline.indexOf('publish');
    const attrAt = timeline.indexOf('updateThing');
    expect(publishAt).toBeGreaterThan(-1);
    expect(attrAt).toBeGreaterThan(publishAt);
    expect(timeline.slice(publishAt + 1, attrAt)).toEqual([]);

    // The device row moved before either of them.
    expect(timeline.indexOf('update:devices')).toBeLessThan(publishAt);
  });

  it('publishes at the UNCHANGED config_rev — never bumps it to force a republish', async () => {
    scriptPreflight();
    scriptTransferTail();
    await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });

    const payload = JSON.parse(
      (dataSend.mock.calls[0][0] as PublishCommand & { input: { payload: Buffer } }).input
        .payload.toString(),
    );
    expect(payload.rev).toBe(42);
    expect(payload.scope).toEqual({ organizationId: ORG_A, workspaceId: WS_NEW });
    expect(payload.retain).toBeUndefined();

    // And the devices UPDATE carried no configRev at all.
    const deviceUpdate = writes.find((w) => w.op === 'update' && w.table === 'devices');
    expect(Object.keys(deviceUpdate!.values!)).toEqual(['workspaceId', 'updatedAt']);
  });

  it('skips the DescribeThing precheck on the transfer path only', async () => {
    scriptPreflight();
    scriptTransferTail();
    await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });
    expect(iotSend.mock.calls.some((c) => c[0] instanceof DescribeThingCommand)).toBe(false);
  });

  it('re-tags the KVS channels of BOTH workspaces eagerly', async () => {
    scriptPreflight();
    scriptTransferTail();
    const summary = await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });
    expect(ensureChannelTags).toHaveBeenCalledWith([WS_OLD, WS_NEW]);
    expect(summary.kvsChannelsRetagged).toBe(2);
  });

  it('writes an audit row and closes it as completed', async () => {
    scriptPreflight();
    scriptTransferTail();
    const summary = await transferDevice({
      deviceId: DEVICE,
      toWorkspaceId: WS_NEW,
      actor: { apiKeyId: 'key-1' },
    });

    const inserted = writes.find((w) => w.op === 'insert' && w.table === 'deviceTransfers');
    expect(inserted!.values).toMatchObject({
      deviceId: DEVICE,
      fromWorkspaceId: WS_OLD,
      toWorkspaceId: WS_NEW,
      fromOrganizationId: ORG_A,
      toOrganizationId: ORG_A,
      actorUserId: null,
      actorApiKeyId: 'key-1',
    });
    const closed = writes.filter((w) => w.op === 'update' && w.table === 'deviceTransfers').pop();
    expect(closed!.values).toMatchObject({ status: 'completed', stage: 'swept' });
    expect(summary.transferId).toBe('deviceTransfers-row-1');
  });
});

describe('transferDevice: offline devices are a success', () => {
  it('transfers an offline device and says so in warnings rather than refusing', async () => {
    scriptPreflight({ device: deviceRow({ status: 'offline' }) });
    scriptTransferTail({ device: deviceRow({ workspaceId: WS_NEW, status: 'offline' }) });

    const summary = await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });

    expect(summary.warnings.some((w) => w.includes('not currently online'))).toBe(true);
    expect(summary.warnings.some((w) => w.includes('next connects'))).toBe(true);
    // It still did the full sequence — the retained message waits on the broker.
    expect(dataSend).toHaveBeenCalledTimes(1);
    expect(iotSend.mock.calls.some((c) => c[0] instanceof UpdateThingCommand)).toBe(true);
  });
});

describe('transferDevice: cross-org', () => {
  it('detaches attachments pointing at templates the destination cannot see, and names them', async () => {
    scriptPreflight({
      target: targetRow(ORG_B),
      attachments: [
        { id: 'att-1', templateId: 'tpl-1', templateName: 'Harsh braking alert' },
        { id: 'att-2', templateId: 'tpl-2', templateName: 'Nightly summary' },
      ],
    });
    scriptTransferTail({ device: deviceRow({ workspaceId: WS_NEW, organizationId: ORG_B }) });

    const summary = await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });

    expect(summary.crossOrg).toBe(true);
    expect(summary.detachedWorkflowAttachments).toEqual([
      'Harsh braking alert',
      'Nightly summary',
    ]);
    expect(writes.some((w) => w.op === 'delete' && w.table === 'workflowAttachments')).toBe(true);
    expect(
      summary.warnings.some((w) => w.includes('historical telemetry') && w.includes('move with it')),
    ).toBe(true);
  });

  it('does not touch workflow attachments on a same-org move', async () => {
    scriptPreflight();
    scriptTransferTail();
    await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });
    expect(writes.some((w) => w.table === 'workflowAttachments')).toBe(false);
  });

  it('writes both tenancy attributes when the organization changes', async () => {
    scriptPreflight({ target: targetRow(ORG_B) });
    scriptTransferTail({ device: deviceRow({ workspaceId: WS_NEW, organizationId: ORG_B }) });
    await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });

    const update = iotSend.mock.calls.find((c) => c[0] instanceof UpdateThingCommand);
    expect((update![0] as UpdateThingCommand).input).toMatchObject({
      thingName: DEVICE,
      attributePayload: {
        attributes: { xgOrgId: ORG_B, xgWorkspaceId: WS_NEW },
        merge: true,
      },
    });
  });
});

describe('transferDevice: pre-flight refusals', () => {
  it('404s an unknown device', async () => {
    queueSelect('devices', []);
    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(writes).toEqual([]);
  });

  it('404s a missing target workspace', async () => {
    queueSelect('devices', [deviceRow()]);
    queueSelect('workspaces', []);
    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('400s a transfer to the workspace the device is already in', async () => {
    scriptPreflight({ target: { ...targetRow(), id: WS_OLD } });
    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_OLD, actor: {} }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SAME_WORKSPACE' });
    expect(writes).toEqual([]);
  });

  it('409s a serial collision in the destination rather than letting the unique index 500', async () => {
    scriptPreflight({ collision: true });
    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SERIAL_COLLISION' });
    expect(dataSend).not.toHaveBeenCalled();
    expect(iotSend).not.toHaveBeenCalled();
  });

  it('409s while another transfer of the same device is in flight', async () => {
    queueSelect('devices', [deviceRow()]);
    queueSelect('workspaces', [targetRow()]);
    queueSelect('devices', []);
    queueSelect('deviceTransfers', []); // nothing stale
    queueSelect('deviceTransfers', [{ id: 'in-flight' }]); // one pending
    queueSelect('workflowRuns', [{ n: 0 }]);
    queueSelect('mediaSessions', [{ n: 0 }]);
    queueSelect('sessionTokens', [{ n: 0 }]);
    queueSelect('kvsChannels', [{ n: 0 }]);
    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TRANSFER_IN_PROGRESS' });
  });
});

describe('transferDevice: partial failure', () => {
  it('rolls the workspace back when the publish fails, and never writes the attributes', async () => {
    scriptPreflight();
    scriptTransferTail();
    dataSend.mockImplementation(async () => {
      timeline.push('publish');
      throw new Error('iot unavailable');
    });

    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} }),
    ).rejects.toThrow('iot unavailable');

    // Attributes ahead of config is the unrecoverable direction — it must not happen.
    expect(iotSend.mock.calls.some((c) => c[0] instanceof UpdateThingCommand)).toBe(false);

    const deviceUpdates = writes.filter((w) => w.op === 'update' && w.table === 'devices');
    expect(deviceUpdates).toHaveLength(2);
    expect(deviceUpdates[0].values).toMatchObject({ workspaceId: WS_NEW });
    expect(deviceUpdates[1].values).toMatchObject({ workspaceId: WS_OLD });

    const audit = writes.filter((w) => w.op === 'update' && w.table === 'deviceTransfers').pop();
    expect(audit!.values).toMatchObject({ status: 'failed', stage: 'publish' });
  });

  it('treats a failed attribute write as a degraded success, not a rollback', async () => {
    scriptPreflight();
    scriptTransferTail();
    iotSend.mockImplementation(async () => {
      timeline.push('updateThing');
      throw new Error('access denied');
    });

    const summary = await transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} });

    expect(summary.scopeAttributes).toBe('failed');
    expect(summary.warnings.some((w) => w.includes('legacy (unscoped) telemetry plane'))).toBe(
      true,
    );
    // The device stays moved: it has already been INSTRUCTED, and the row is the authority.
    const deviceUpdates = writes.filter((w) => w.op === 'update' && w.table === 'devices');
    expect(deviceUpdates).toHaveLength(1);
    expect(deviceUpdates[0].values).toMatchObject({ workspaceId: WS_NEW });
  });

  it('409s when the device moved out from under the pre-flight', async () => {
    scriptPreflight();
    scriptTransferTail({ moved: false });
    await expect(
      transferDevice({ deviceId: DEVICE, toWorkspaceId: WS_NEW, actor: {} }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONCURRENT_MODIFICATION' });
    expect(dataSend).not.toHaveBeenCalled();
  });
});

describe('previewTransfer', () => {
  it('reports blockers instead of throwing, so the dialog can render them', async () => {
    scriptPreflight({ collision: true, runningRuns: 3, staleTokens: 1 });
    const preview = await previewTransfer(DEVICE, WS_NEW);
    expect(preview.blockers.map((b) => b.code)).toEqual(['SERIAL_COLLISION']);
    expect(preview.runningWorkflowRuns).toBe(3);
    expect(preview.staleSessionTokens).toBe(1);
    expect(preview.carriesHistory).toBe(true);
    // A preview writes nothing.
    expect(writes.filter((w) => w.table !== 'deviceTransfers')).toEqual([]);
  });

  it('names the attachments a cross-org move would detach, before anything is written', async () => {
    scriptPreflight({
      target: targetRow(ORG_B),
      attachments: [{ id: 'att-1', templateId: 'tpl-1', templateName: 'Harsh braking alert' }],
    });
    const preview = await previewTransfer(DEVICE, WS_NEW);
    expect(preview.crossOrg).toBe(true);
    expect(preview.workflowAttachments).toEqual([
      { id: 'att-1', templateId: 'tpl-1', templateName: 'Harsh braking alert' },
    ]);
    expect(preview.warnings.some((w) => w.includes('Harsh braking alert'))).toBe(true);
    expect(writes.some((w) => w.op === 'delete')).toBe(false);
  });
});

describe('transferAdoption', () => {
  const to = { workspaceId: WS_NEW, organizationId: ORG_A };

  it('is `unknown` when the device has never reported a telemetry scope', () => {
    expect(transferAdoption(null, to)).toBe('unknown');
    expect(transferAdoption({ effective: {} }, to)).toBe('unknown');
  });

  it('is `pending` while the device is still reporting the old tenancy', () => {
    const reported = {
      effective: { telemetryScope: { organizationId: ORG_A, workspaceId: WS_OLD, scoped: true } },
    };
    expect(transferAdoption(reported, to)).toBe('pending');
  });

  it('is `confirmed` once the device reports the new tenancy', () => {
    const reported = {
      effective: { telemetryScope: { organizationId: ORG_A, workspaceId: WS_NEW, scoped: true } },
    };
    expect(transferAdoption(reported, to)).toBe('confirmed');
  });

  it('never reads a fallback-to-legacy report as confirmed', () => {
    const reported = {
      effective: {
        telemetryScope: {
          topic: `xorgate/devices/${DEVICE}/telemetry`,
          scoped: false,
          organizationId: ORG_A,
          workspaceId: WS_OLD,
          fallback: { since: 1, count: 3 },
        },
      },
    };
    expect(transferAdoption(reported, to)).toBe('pending');
  });
});

describe('TransferError', () => {
  it('carries the status the route should return', () => {
    const err = new TransferError('nope', 409, 'SERIAL_COLLISION');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('SERIAL_COLLISION');
  });
});

describe('reconcileStaleTransfers', () => {
  it('finishes an interrupted transfer whose DB half landed, publish FIRST', async () => {
    // A `pending` row older than the stale window, for a device that is already
    // in the destination workspace: steps 3-4 may or may not have run, and
    // re-running both is the only safe repair.
    queueSelect('deviceTransfers', [
      { id: 'tr-stale', toWorkspaceId: WS_NEW, toOrganizationId: ORG_A },
    ]);
    queueSelect('devices', [deviceRow({ workspaceId: WS_NEW })]); // deviceTenancy
    queueSelect('devices', [{ workspaceId: WS_NEW, organizationId: ORG_A }]); // deviceScope
    queueSelect('devices', []); // hardware block

    await reconcileStaleTransfers(DEVICE);

    const publishAt = timeline.indexOf('publish');
    const attrAt = timeline.indexOf('updateThing');
    expect(publishAt).toBeGreaterThan(-1);
    expect(attrAt).toBeGreaterThan(publishAt);
    // Unlike the hot path, the repair leaves the DescribeThing precheck ON — it
    // is not in the ordering-critical window and the read is what stops a
    // redundant UpdateThing bumping the thing's version.
    expect(iotSend.mock.calls.some((c) => c[0] instanceof DescribeThingCommand)).toBe(true);

    const closed = writes.filter((w) => w.op === 'update' && w.table === 'deviceTransfers').pop();
    expect(closed!.values).toMatchObject({ status: 'completed', stage: 'attributes' });
  });

  it('marks a stale transfer failed — and touches NO AWS — when the DB half never landed', async () => {
    queueSelect('deviceTransfers', [
      { id: 'tr-stale', toWorkspaceId: WS_NEW, toOrganizationId: ORG_A },
    ]);
    queueSelect('devices', [deviceRow({ workspaceId: WS_OLD })]); // still in the source

    await reconcileStaleTransfers(DEVICE);

    // Re-asserting the ATTRIBUTES alone here would be the forbidden direction:
    // the config carrying the new scope was never published.
    expect(iotSend).not.toHaveBeenCalled();
    expect(dataSend).not.toHaveBeenCalled();
    const closed = writes.filter((w) => w.op === 'update' && w.table === 'deviceTransfers').pop();
    expect(closed!.values).toMatchObject({ status: 'failed', stage: 'db' });
  });

  it('does nothing when no transfer is stale', async () => {
    queueSelect('deviceTransfers', []);
    await reconcileStaleTransfers(DEVICE);
    expect(writes).toEqual([]);
  });
});
