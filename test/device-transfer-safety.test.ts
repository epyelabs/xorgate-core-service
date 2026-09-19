import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Transfer safety, cloud side (transfer-device-ownership Phase 1.2).
 *
 * Two properties, both learned from the ~50-minute outage on 2026-09-18:
 *
 * 1. `publishDeviceConfig` is split, so the thing-attribute write is no longer
 *    unconditionally AHEAD of the retained publish. A transfer must instruct the
 *    device before it authorizes the new topic; do it the other way round and a
 *    running agent is refused on every publish, IoT Core closes the connection,
 *    and it reconnects into the same state forever.
 * 2. `ensureThingScopeAttributes` is a genuine no-op when the attributes already
 *    match. `UpdateThing` with an identical payload still bumps the thing's
 *    `version` and re-evaluates policy for live sessions — that is what turned
 *    one stranded device into a storm (version 118 -> 255 in minutes).
 */

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
vi.mock('../src/services/iot-data', () => ({
  iotDataClient: async () => ({ send: dataSend }),
}));

/**
 * `deviceScope` and `deviceHardwareBlock` are the only db users in play; both
 * are single indexed reads, stubbed here so the test is about ordering.
 */
const scopeRows = vi.fn(async () => [
  { workspaceId: 'ws-new', organizationId: 'org-1' },
]);
const hardwareRows = vi.fn(async () => [] as unknown[]);
vi.mock('../src/db/index', async () => {
  const schema = await import('../src/db/schema');
  const chain = (rows: () => Promise<unknown[]>) => {
    const self: Record<string, unknown> = {};
    for (const k of ['from', 'innerJoin', 'where']) self[k] = () => self;
    self.limit = () => rows();
    return self;
  };
  return {
    schema,
    db: {
      select: (cols: Record<string, unknown>) =>
        chain(
          Object.prototype.hasOwnProperty.call(cols, 'caps')
            ? (hardwareRows as () => Promise<unknown[]>)
            : (scopeRows as () => Promise<unknown[]>),
        ),
    },
  };
});

const { publishDeviceConfig, publishDeviceConfigOnly } = await import(
  '../src/services/device-config'
);
const { ensureThingScopeAttributes, ORG_ATTRIBUTE, WORKSPACE_ATTRIBUTE } = await import(
  '../src/services/device-scope'
);

const DEVICE = 'ca4b1c5d-1111-4000-8000-000000000001';
const SCOPE = { organizationId: 'org-1', workspaceId: 'ws-new' };

/** A thing whose attributes already carry `attrs`. */
function thingWith(attrs: Record<string, string>): void {
  iotSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof DescribeThingCommand) return { attributes: attrs };
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dataSend.mockResolvedValue({});
  thingWith({});
});

describe('ensureThingScopeAttributes: no-op when already correct', () => {
  it('reads first and writes nothing when both attributes match', async () => {
    thingWith({ [ORG_ATTRIBUTE]: 'org-1', [WORKSPACE_ATTRIBUTE]: 'ws-new' });
    const result = await ensureThingScopeAttributes(DEVICE, SCOPE);
    expect(result).toBe('unchanged');
    expect(iotSend).toHaveBeenCalledTimes(1);
    expect(iotSend.mock.calls[0][0]).toBeInstanceOf(DescribeThingCommand);
    // The whole point: no UpdateThing, so the thing's `version` does not move.
    expect(
      iotSend.mock.calls.some((c) => c[0] instanceof UpdateThingCommand),
    ).toBe(false);
  });

  it('writes when the workspace differs (the transfer case)', async () => {
    thingWith({ [ORG_ATTRIBUTE]: 'org-1', [WORKSPACE_ATTRIBUTE]: 'ws-old' });
    expect(await ensureThingScopeAttributes(DEVICE, SCOPE)).toBe('written');
    const update = iotSend.mock.calls.find((c) => c[0] instanceof UpdateThingCommand);
    expect((update?.[0] as UpdateThingCommand).input).toMatchObject({
      thingName: DEVICE,
      attributePayload: {
        attributes: { [ORG_ATTRIBUTE]: 'org-1', [WORKSPACE_ATTRIBUTE]: 'ws-new' },
        merge: true,
      },
    });
  });

  it('writes when the org differs (cross-org transfer)', async () => {
    thingWith({ [ORG_ATTRIBUTE]: 'org-other', [WORKSPACE_ATTRIBUTE]: 'ws-new' });
    expect(await ensureThingScopeAttributes(DEVICE, SCOPE)).toBe('written');
  });

  it('writes when an attribute is missing entirely (never provisioned)', async () => {
    thingWith({ [ORG_ATTRIBUTE]: 'org-1' });
    expect(await ensureThingScopeAttributes(DEVICE, SCOPE)).toBe('written');
  });

  it('writes when the describe fails — not knowing is a reason TO write', async () => {
    iotSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeThingCommand) throw new Error('throttled');
      return {};
    });
    expect(await ensureThingScopeAttributes(DEVICE, SCOPE)).toBe('written');
  });

  it('stays best-effort: a failed write is reported, never thrown', async () => {
    iotSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeThingCommand) return { attributes: {} };
      throw new Error('iot down');
    });
    await expect(ensureThingScopeAttributes(DEVICE, SCOPE)).resolves.toBe('failed');
  });
});

describe('publishDeviceConfigOnly: the instruction half, alone', () => {
  it('publishes the retained config and touches no thing attribute', async () => {
    const scope = await publishDeviceConfigOnly(DEVICE, { gnssAntBias: true }, 7);
    expect(scope).toEqual(SCOPE);
    expect(iotSend).not.toHaveBeenCalled();
    expect(dataSend).toHaveBeenCalledTimes(1);
    const cmd = dataSend.mock.calls[0][0] as PublishCommand;
    expect(cmd.input).toMatchObject({
      topic: `xorgate/devices/${DEVICE}/config`,
      qos: 1,
      retain: true,
    });
  });

  it('carries the scope and the rev it was given, unchanged', async () => {
    // Bumping the rev to force a republish is the 2026-09-18 anti-pattern; the
    // caller owns the rev and this must not editorialise.
    await publishDeviceConfigOnly(DEVICE, { gnssAntBias: true }, 7);
    const cmd = dataSend.mock.calls[0][0] as PublishCommand;
    const payload = JSON.parse(
      String((cmd.input as { payload: Buffer }).payload),
    ) as Record<string, unknown>;
    expect(payload.rev).toBe(7);
    expect(payload.scope).toEqual(SCOPE);
  });

  it('publishes without a scope block when the device or workspace is gone', async () => {
    scopeRows.mockResolvedValueOnce([]);
    expect(await publishDeviceConfigOnly(DEVICE, {}, 1)).toBeNull();
    const cmd = dataSend.mock.calls[0][0] as PublishCommand;
    const payload = JSON.parse(String((cmd.input as { payload: Buffer }).payload));
    expect(payload).not.toHaveProperty('scope');
  });

  it('throws on a failed publish, so the caller can stop a transfer', async () => {
    dataSend.mockRejectedValueOnce(new Error('iot down') as never);
    await expect(publishDeviceConfigOnly(DEVICE, {}, 1)).rejects.toThrow('iot down');
  });
});

describe('publishDeviceConfig: the ordinary config-save path', () => {
  it('keeps the attributes-first order, which is correct for THIS caller', async () => {
    // Not the transfer order, deliberately. This path never changes tenancy —
    // it asserts the one the device has, or sets the first one on a device
    // still using the unscoped topic. Writing the attribute there only ADDS a
    // permitted topic; the unscoped one stays permitted, so there is no window
    // where the device is publishing somewhere it is not allowed. A transfer is
    // the opposite case and uses publishDeviceConfigOnly instead.
    const order: string[] = [];
    dataSend.mockImplementation(async () => {
      order.push('publish');
      return {};
    });
    iotSend.mockImplementation(async (cmd: unknown) => {
      order.push(cmd instanceof DescribeThingCommand ? 'describe' : 'update');
      return cmd instanceof DescribeThingCommand ? { attributes: {} } : {};
    });
    await publishDeviceConfig(DEVICE, { gnssAntBias: true }, 7);
    expect(order).toEqual(['describe', 'update', 'publish']);
  });

  it('costs one describe and one publish once the attributes are right', async () => {
    // The steady state, and the regression that matters: no UpdateThing, so the
    // thing's `version` stops climbing on every config save and every republish.
    thingWith({ [ORG_ATTRIBUTE]: 'org-1', [WORKSPACE_ATTRIBUTE]: 'ws-new' });
    await publishDeviceConfig(DEVICE, { gnssAntBias: true }, 7);
    expect(dataSend).toHaveBeenCalledTimes(1);
    expect(iotSend).toHaveBeenCalledTimes(1);
    expect(iotSend.mock.calls[0][0]).toBeInstanceOf(DescribeThingCommand);
  });

  it('skips the attribute work entirely for a device with no resolvable scope', async () => {
    scopeRows.mockResolvedValueOnce([]);
    await publishDeviceConfig(DEVICE, {}, 1);
    expect(iotSend).not.toHaveBeenCalled();
    expect(dataSend).toHaveBeenCalledTimes(1);
  });

  it('still publishes when the attribute write fails — best-effort, as before', async () => {
    iotSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DescribeThingCommand) return { attributes: {} };
      throw new Error('iot down');
    });
    await expect(publishDeviceConfig(DEVICE, {}, 1)).resolves.toBeUndefined();
    expect(dataSend).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a publish failure', async () => {
    dataSend.mockRejectedValueOnce(new Error('iot down') as never);
    await expect(publishDeviceConfig(DEVICE, {}, 1)).rejects.toThrow('iot down');
  });
});
