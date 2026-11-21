import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_SENSORS_CAPABILITY,
  CAMERA_SENSORS_DEFAULTS,
  CAMERA_SENSORS_KEY,
  CAMERA_SENSORS_MIN_AGENT,
  CAMERA_SENSORS_ONLY_NAMESPACES,
  CONFIG_NAMESPACE_KEYS,
  cameraSensorsEligibility,
  cameraSensorsPortError,
  configNamespace,
  declaredCameraPorts,
  namespaceAllowedFor,
  reportDisprovesCameraSensors,
  validateConfigPatch,
  validateNamespaceValue,
} from '../src/config-registry/index';
import { buildConfigContract } from '../src/config-registry/contract';
import { CAMERA_CATALOG, SELECTABLE_SENSOR_IDS } from '../src/camera-catalog';
import { buildDeviceConfigMessage } from '../src/services/device-config';
import { deviceResponse, type DeviceRow } from '../src/services/device-view';

/**
 * The `cameraSensors` namespace (plans/support-other-camera-models, Phase 2):
 * the shape, the catalog check, the device gate, and the three places the gate
 * is asked (PATCH validation, the publisher, the served document).
 *
 * The load-bearing cases are the ones a device turns into an edit of
 * /boot/firmware/config.txt: only a catalog sensor (or `none`) with that
 * sensor's own option values may be stored, an absent port must stay absent,
 * and a device whose agent cannot act on the namespace must never hold it, be
 * sent it, or be shown as having it.
 */

const parse = (v: unknown) => validateNamespaceValue('cameraSensors', v);
const errorOf = (v: unknown): string => {
  const r = parse(v);
  if (!('error' in r)) throw new Error(`expected an error for ${JSON.stringify(v)}`);
  return r.error;
};
const cams = (cameras: unknown) => ({ cameras });

const KNOWN = 'imx290, imx219, imx708, imx335';

describe('cameraSensors: registration in the registry', () => {
  it('is the LAST namespace, so no existing published key moves', () => {
    expect(CONFIG_NAMESPACE_KEYS.at(-1)).toBe('cameraSensors');
    expect(CAMERA_SENSORS_KEY).toBe('cameraSensors');
    // Everything before it is the list as it was, in the order it was.
    expect(CONFIG_NAMESPACE_KEYS.slice(0, -1)).toEqual([
      'gnssAntBias',
      'imuMount',
      'recording',
      'lteRecovery',
      'timeSync',
      'cellular',
      'cameraMount',
      'simulation',
      'obd',
    ]);
  });

  it('has no column and applies like cameraMount', () => {
    const spec = configNamespace('cameraSensors')!;
    expect(spec.applyClass).toBe('agent-poll');
    expect(spec.legacyColumn).toBeNull();
    expect(spec.legacyPutField).toBeNull();
    expect(spec.kind).toBe('object');
    expect(spec.title).toBe('CameraSensorsConfig');
  });

  it('defaults to "nothing managed"', () => {
    expect(CAMERA_SENSORS_DEFAULTS).toEqual({ cameras: {} });
    expect(configNamespace('cameraSensors')!.defaults).toEqual({ cameras: {} });
  });

  it('this test file knows the catalog it was written against', () => {
    // The messages below quote the list of selectable sensors.
    expect(SELECTABLE_SENSOR_IDS.join(', ')).toBe(KNOWN);
  });
});

describe('cameraSensors: accepted values', () => {
  it('accepts the design document verbatim', () => {
    const v = cams({
      cam0: { sensor: 'imx708' },
      cam1: { sensor: 'imx290', options: { clockFrequency: 74250000 } },
    });
    expect(parse(v)).toEqual({ value: v });
  });

  it('accepts every selectable catalog sensor', () => {
    for (const id of SELECTABLE_SENSOR_IDS) {
      expect(parse(cams({ cam0: { sensor: id } })), id).toEqual({
        value: cams({ cam0: { sensor: id } }),
      });
    }
  });

  it('accepts every listed value of every option, and only those', () => {
    for (const sensor of CAMERA_CATALOG.sensors) {
      for (const option of sensor.options) {
        for (const value of option.values) {
          const v = cams({ cam0: { sensor: sensor.id, options: { [option.key]: value } } });
          expect(parse(v), `${sensor.id}.${option.key}=${value}`).toEqual({ value: v });
        }
        expect(
          parse(cams({ cam0: { sensor: sensor.id, options: { [option.key]: 1 } } })),
        ).toHaveProperty('error');
      }
    }
  });

  it('accepts "none": a port declared empty', () => {
    const v = cams({ cam0: { sensor: 'imx219' }, cam1: { sensor: 'none' } });
    expect(parse(v)).toEqual({ value: v });
    expect(parse(cams({ cam0: { sensor: 'none' } }))).toEqual({
      value: cams({ cam0: { sensor: 'none' } }),
    });
  });

  it('accepts one port only: the other stays ABSENT, it is never defaulted in', () => {
    const r = parse(cams({ cam1: { sensor: 'imx219' } })) as { value: { cameras: object } };
    expect(Object.keys(r.value.cameras)).toEqual(['cam1']);
  });

  it('accepts an empty camera map (nothing managed) and null (revert)', () => {
    expect(parse(cams({}))).toEqual({ value: cams({}) });
    expect(parse(null)).toEqual({ value: null });
  });

  it('normalizes: an empty options object is dropped, key order of the ports is kept', () => {
    expect(parse(cams({ cam1: { sensor: 'imx219', options: {} }, cam0: { sensor: 'imx708' } }))).toEqual(
      { value: cams({ cam1: { sensor: 'imx219' }, cam0: { sensor: 'imx708' } }) },
    );
    const r = parse(cams({ cam1: { sensor: 'imx219' }, cam0: { sensor: 'imx708' } })) as {
      value: { cameras: object };
    };
    expect(Object.keys(r.value.cameras)).toEqual(['cam1', 'cam0']);
  });

  it('keeps an option explicitly set to its default (it is a statement)', () => {
    const v = cams({ cam0: { sensor: 'imx290', options: { clockFrequency: 37125000 } } });
    expect(parse(v)).toEqual({ value: v });
  });
});

describe('cameraSensors: refused values, each naming the port and what is allowed', () => {
  it('an unknown sensor', () => {
    expect(errorOf(cams({ cam0: { sensor: 'imx999' } }))).toBe(
      `cameraSensors.cameras.cam0.sensor: "imx999" is not a known camera sensor (known: ${KNOWN}); ` +
        'or "none" for a port with no camera',
    );
  });

  it('a planned sensor that cannot be selected yet', () => {
    const e = errorOf(cams({ cam1: { sensor: 'imx662' } }));
    expect(e).toContain('cameraSensors.cameras.cam1.sensor: "imx662"');
    expect(e).toContain('is planned and cannot be selected yet');
    expect(e).toContain(`available: ${KNOWN}`);
  });

  it('a sensor that is not an id at all', () => {
    for (const sensor of ['IMX290', 'imx 290', 'imx290,cam0', '../x', '', 'a', 7, null, true, {}]) {
      const e = errorOf(cams({ cam0: { sensor } }));
      expect(e, String(sensor)).toMatch(/^cameraSensors\.cameras\.cam0\.sensor: /);
    }
    expect(errorOf(cams({ cam0: { sensor: 'IMX290' } }))).toBe(
      'cameraSensors.cameras.cam0.sensor: must be a camera sensor id or "none"',
    );
  });

  it('a missing sensor', () => {
    expect(errorOf(cams({ cam0: {} }))).toBe('cameraSensors.cameras.cam0.sensor: Required');
    expect(errorOf(cams({ cam0: { options: { clockFrequency: 37125000 } } }))).toBe(
      'cameraSensors.cameras.cam0.sensor: Required',
    );
  });

  it('an option the sensor does not have', () => {
    expect(errorOf(cams({ cam0: { sensor: 'imx290', options: { linkFrequency: 450000000 } } }))).toBe(
      'cameraSensors.cameras.cam0.options: imx290 has no option "linkFrequency" ' +
        '(its options: clockFrequency)',
    );
    expect(errorOf(cams({ cam1: { sensor: 'imx219', options: { clockFrequency: 37125000 } } }))).toBe(
      'cameraSensors.cameras.cam1.options: imx219 has no option "clockFrequency" ' +
        '(it takes no options, so remove "options")',
    );
  });

  it('an option value the catalog does not list', () => {
    expect(errorOf(cams({ cam1: { sensor: 'imx290', options: { clockFrequency: 24000000 } } }))).toBe(
      'cameraSensors.cameras.cam1.options.clockFrequency: must be one of 37125000, 74250000 Hz ' +
        '(got 24000000)',
    );
  });

  it('an option value that is not a number, and an options that is not an object', () => {
    expect(
      errorOf(cams({ cam0: { sensor: 'imx290', options: { clockFrequency: '37125000' } } })),
    ).toMatch(/^cameraSensors\.cameras\.cam0\.options\.clockFrequency: /);
    expect(errorOf(cams({ cam0: { sensor: 'imx290', options: [37125000] } }))).toMatch(
      /^cameraSensors\.cameras\.cam0\.options: /,
    );
    expect(errorOf(cams({ cam0: { sensor: 'imx290', options: null } }))).toMatch(
      /^cameraSensors\.cameras\.cam0\.options: /,
    );
  });

  it('"none" with options, whatever they hold', () => {
    const expected =
      'cameraSensors.cameras.cam1.options: a port declared empty ("sensor": "none") takes no ' +
      'options: remove "options"';
    expect(errorOf(cams({ cam1: { sensor: 'none', options: { clockFrequency: 37125000 } } }))).toBe(
      expected,
    );
    expect(errorOf(cams({ cam1: { sensor: 'none', options: {} } }))).toBe(expected);
  });

  it('unknown keys at both levels (a silent drop would be a wrong boot line)', () => {
    expect(parse(cams({ cam0: { sensor: 'imx290', rotation: 180 } }))).toHaveProperty('error');
    expect(parse({ cameras: { cam0: { sensor: 'imx290' } }, enabled: true })).toHaveProperty('error');
    expect(parse({ cam0: { sensor: 'imx290' } })).toHaveProperty('error');
  });

  it('a key that is not a stream key, and an absurd camera count', () => {
    expect(parse(cams({ 'cam 0': { sensor: 'imx290' } }))).toHaveProperty('error');
    expect(parse(cams({ '': { sensor: 'imx290' } }))).toHaveProperty('error');
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`cam${i}`, { sensor: 'imx290' }]),
    );
    expect(parse(cams(many))).toHaveProperty('error');
  });

  it('the empty object ({} is never an erase: null is), and things that are not a document', () => {
    expect(errorOf({})).toContain('send null to revert');
    for (const v of ['imx290', 7, true, [], [{ cameras: {} }], { cameras: null }, { cameras: [] }]) {
      expect(parse(v), JSON.stringify(v)).toHaveProperty('error');
    }
  });

  it('reports the first problem only, so one 400 names one thing to fix', () => {
    const e = errorOf(cams({ cam0: { sensor: 'nope' }, cam1: { sensor: 'alsonope' } }));
    expect(e).toContain('cameraSensors.cameras.cam0.sensor');
    expect(e).not.toContain('cam1');
  });
});

describe('cameraSensors: a key must be a camera port the model declares', () => {
  const ports = ['cam0', 'cam1'];

  it('declaredCameraPorts reads the hardware block, and says "unknown" without one', () => {
    expect(declaredCameraPorts({ video: [{ key: 'cam0' }, { key: 'cam1' }] })).toEqual(ports);
    expect(declaredCameraPorts({ video: [] })).toEqual([]);
    // A schemaVersion-1 model has no hardware block: the ports are UNKNOWN.
    expect(declaredCameraPorts(null)).toBeNull();
    expect(declaredCameraPorts(undefined)).toBeNull();
  });

  it('refuses an undeclared port, naming it and the ports there are', () => {
    expect(cameraSensorsPortError(cams({ cam2: { sensor: 'imx290' } }), ports)).toBe(
      'cameraSensors.cameras.cam2: this device\'s model has no camera port "cam2" ' +
        '(its camera ports: cam0, cam1)',
    );
    expect(cameraSensorsPortError(cams({ cam1: { sensor: 'imx290' } }), ['cam0'])).toBe(
      'cameraSensors.cameras.cam1: this device\'s model has no camera port "cam1" ' +
        '(its camera ports: cam0)',
    );
    expect(cameraSensorsPortError(cams({ cam0: { sensor: 'none' } }), [])).toBe(
      'cameraSensors.cameras.cam0: this device\'s model has no camera port "cam0" ' +
        '(its model declares no camera ports)',
    );
  });

  it('accepts declared ports, an empty map and the cleared marker', () => {
    expect(cameraSensorsPortError(cams({ cam0: { sensor: 'imx290' } }), ports)).toBeNull();
    expect(cameraSensorsPortError(cams({}), ports)).toBeNull();
    expect(cameraSensorsPortError(null, ports)).toBeNull();
  });

  it('checks nothing when the ports are unknown (no hardware block)', () => {
    expect(cameraSensorsPortError(cams({ cam7: { sensor: 'imx290' } }), null)).toBeNull();
    expect(cameraSensorsPortError(cams({ cam7: { sensor: 'imx290' } }), undefined)).toBeNull();
  });

  it('validateConfigPatch applies it through the gate facts', () => {
    const allowed = { allowed: true } as const;
    const body = { cameraSensors: cams({ cam0: { sensor: 'imx708' }, cam2: { sensor: 'imx219' } }) };
    expect(validateConfigPatch(body, { cameraSensors: allowed, cameraPorts: ports })).toEqual({
      error:
        'cameraSensors.cameras.cam2: this device\'s model has no camera port "cam2" ' +
        '(its camera ports: cam0, cam1)',
    });
    // Unknown ports: the shape and the catalog are all the cloud checks.
    expect(validateConfigPatch(body, { cameraSensors: allowed, cameraPorts: null })).toEqual({
      value: body,
    });
    expect(validateConfigPatch(body, { cameraSensors: allowed })).toEqual({ value: body });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────────

const reportWith = (capabilities: unknown, extra: Record<string, unknown> = {}) => ({
  v: 1,
  rev: 3,
  origin: 'boot',
  effective: {
    agent: { mode: 'real', build: { version: 'v0.1.1' }, capabilities, runtime: 'rust', ...extra },
  },
  status: {},
});
const OLD_CAPS = ['sms.read', 'sms.clear', 'obd.scan', 'obd.forget'];
const NEW_CAPS = [...OLD_CAPS, 'camera.sensors'];

const jsDevice = { agent: 'js', simulated: false, reportedConfig: reportWith(OLD_CAPS, { runtime: undefined }) };
const jsNeverReported = { agent: 'js', simulated: false, reportedConfig: null };
const simDevice = { agent: 'rust', simulated: true, reportedConfig: reportWith(NEW_CAPS) };
const oldRust = { agent: 'rust', simulated: false, reportedConfig: reportWith(OLD_CAPS), agentVersion: 'v0.1.1' };
const freshRust = { agent: 'rust', simulated: false, reportedConfig: null };
const capableRust = { agent: 'rust', simulated: false, reportedConfig: reportWith(NEW_CAPS), agentVersion: 'v0.2.0' };

const JS_MESSAGE =
  'config namespace cameraSensors needs the Rust device agent, version 0.2.0 or newer; this ' +
  'device runs the JS agent, which does not manage camera sensors';
const SIM_MESSAGE =
  'config namespace cameraSensors does not apply to simulated devices: a simulator has no ' +
  'camera ports';
const OLD_RUST_MESSAGE =
  'config namespace cameraSensors needs Rust agent 0.2.0 or newer; this device last reported ' +
  'agent build "v0.1.1" that does not support it (no "camera.sensors" capability). Update the ' +
  'agent on the device, then save again';

describe('cameraSensors: who may hold it (cameraSensorsEligibility)', () => {
  it('the capability string and the version are the agreed ones', () => {
    expect(CAMERA_SENSORS_CAPABILITY).toBe('camera.sensors');
    // The lowest `minAgent` of the catalog: the working value until the release.
    expect(CAMERA_SENSORS_MIN_AGENT).toBe('0.2.0');
    expect(CAMERA_CATALOG.sensors.every((s) => s.minAgent === '0.2.0')).toBe(true);
    expect(CAMERA_SENSORS_ONLY_NAMESPACES).toEqual(['cameraSensors']);
  });

  it('a JS device: refused, reported or not', () => {
    expect(cameraSensorsEligibility(jsDevice)).toEqual({
      allowed: false,
      reason: 'agent-kind',
      message: JS_MESSAGE,
    });
    expect(cameraSensorsEligibility(jsNeverReported)).toMatchObject({
      allowed: false,
      reason: 'agent-kind',
    });
    // Even a JS row whose report somehow listed the capability: the kind decides.
    expect(
      cameraSensorsEligibility({ ...jsDevice, reportedConfig: reportWith(NEW_CAPS) }),
    ).toMatchObject({ allowed: false, reason: 'agent-kind' });
  });

  it('a simulator: refused, whatever its agent says', () => {
    expect(cameraSensorsEligibility(simDevice)).toEqual({
      allowed: false,
      reason: 'simulated',
      message: SIM_MESSAGE,
    });
    expect(cameraSensorsEligibility({ ...freshRust, simulated: true })).toMatchObject({
      allowed: false,
      reason: 'simulated',
    });
  });

  it('an old Rust agent (reported, no capability): refused, naming the version needed', () => {
    expect(cameraSensorsEligibility(oldRust)).toEqual({
      allowed: false,
      reason: 'agent-version',
      message: OLD_RUST_MESSAGE,
    });
  });

  it('an old Rust agent whose build is unknown still gets the version needed', () => {
    const r = cameraSensorsEligibility({ ...oldRust, agentVersion: null });
    expect(r).toMatchObject({ allowed: false, reason: 'agent-version' });
    expect((r as { message: string }).message).toBe(
      'config namespace cameraSensors needs Rust agent 0.2.0 or newer; this device last reported ' +
        'an agent that does not support it (no "camera.sensors" capability). Update the agent on ' +
        'the device, then save again',
    );
  });

  it('a Rust device that has never reported: allowed (claim seeding lives here)', () => {
    expect(cameraSensorsEligibility(freshRust)).toEqual({ allowed: true });
    expect(cameraSensorsEligibility({ ...freshRust, reportedConfig: undefined })).toEqual({
      allowed: true,
    });
  });

  it('a Rust device reporting the capability: allowed', () => {
    expect(cameraSensorsEligibility(capableRust)).toEqual({ allowed: true });
  });

  it('a Rust report with no agent block or no capability list: refused (not proven)', () => {
    for (const reportedConfig of [
      { v: 1, effective: {} },
      { v: 1, effective: { agent: { mode: 'real' } } },
      { v: 1 },
      'garbage',
      { v: 1, effective: { agent: { capabilities: 'camera.sensors' } } },
    ]) {
      expect(
        cameraSensorsEligibility({ agent: 'rust', simulated: false, reportedConfig }),
        JSON.stringify(reportedConfig),
      ).toMatchObject({ allowed: false, reason: 'agent-version' });
    }
  });

  it('fails closed on a row it cannot read', () => {
    expect(
      cameraSensorsEligibility({ agent: 'rust', simulated: undefined, reportedConfig: null }),
    ).toMatchObject({ allowed: false });
    expect(
      cameraSensorsEligibility({ agent: undefined, simulated: false, reportedConfig: null }),
    ).toMatchObject({ allowed: false, reason: 'agent-kind' });
    expect(
      cameraSensorsEligibility({ agent: 'RUST', simulated: false, reportedConfig: null }),
    ).toMatchObject({ allowed: false, reason: 'agent-kind' });
  });
});

describe('cameraSensors: reportDisprovesCameraSensors (what may REMOVE a stored value)', () => {
  it('true only for a capability list without camera.sensors', () => {
    expect(reportDisprovesCameraSensors(reportWith(OLD_CAPS))).toBe(true);
    expect(reportDisprovesCameraSensors(reportWith([]))).toBe(true);
  });

  it('false when the capability is there', () => {
    expect(reportDisprovesCameraSensors(reportWith(NEW_CAPS))).toBe(false);
  });

  it('false when the report says nothing about capabilities: absence proves nothing', () => {
    for (const r of [
      null,
      undefined,
      'x',
      {},
      { effective: {} },
      { effective: { agent: {} } },
      { effective: { agent: { mode: 'real' } } },
      { effective: { agent: { capabilities: 'sms.read' } } },
    ]) {
      expect(reportDisprovesCameraSensors(r), JSON.stringify(r)).toBe(false);
    }
  });
});

describe('cameraSensors: PATCH validation (validateConfigPatch)', () => {
  const body = { cameraSensors: cams({ cam0: { sensor: 'imx708' } }) };
  const facts = (device: Parameters<typeof cameraSensorsEligibility>[0]) => ({
    simulated: device.simulated === true,
    cameraSensors: cameraSensorsEligibility(device),
  });

  it('JS device: a 400 text, never a silent drop', () => {
    expect(validateConfigPatch(body, facts(jsDevice))).toEqual({ error: JS_MESSAGE });
  });

  it('simulator: refused', () => {
    expect(validateConfigPatch(body, facts(simDevice))).toEqual({ error: SIM_MESSAGE });
  });

  it('old Rust: refused with the version needed', () => {
    expect(validateConfigPatch(body, facts(oldRust))).toEqual({ error: OLD_RUST_MESSAGE });
  });

  it('never-reported Rust and capable Rust: accepted', () => {
    expect(validateConfigPatch(body, facts(freshRust))).toEqual({ value: body });
    expect(validateConfigPatch(body, facts(capableRust))).toEqual({ value: body });
  });

  it('refuses when the caller supplied no facts at all (the gate fails closed)', () => {
    expect(validateConfigPatch(body)).toEqual({
      error: 'config namespace cameraSensors applies only to devices running Rust agent 0.2.0 or newer',
    });
    expect(validateConfigPatch(body, { simulated: false, obd: true })).toHaveProperty('error');
  });

  it('refuses null too: a device that cannot hold the namespace cannot clear it either', () => {
    expect(validateConfigPatch({ cameraSensors: null }, facts(oldRust))).toEqual({
      error: OLD_RUST_MESSAGE,
    });
    expect(validateConfigPatch({ cameraSensors: null }, facts(capableRust))).toEqual({
      value: { cameraSensors: null },
    });
  });

  it('is all-or-nothing: a refused cameraSensors fails the namespaces sent with it', () => {
    const multi = { timeSync: { offlineSources: false }, ...body };
    expect(validateConfigPatch(multi, facts(jsDevice))).toEqual({ error: JS_MESSAGE });
  });

  it('leaves every other namespace exactly as it was for a device that does not qualify', () => {
    const other = { cameraMount: { cameras: { cam0: { rotationDeg: 180 as const } } } };
    for (const device of [jsDevice, oldRust, freshRust, capableRust]) {
      expect(validateConfigPatch(other, facts(device))).toEqual({ value: other });
      // And with no camera facts at all, as every pre-existing caller sends.
      expect(validateConfigPatch(other, { simulated: false })).toEqual({ value: other });
    }
    expect(namespaceAllowedFor('cameraMount', {})).toBe(true);
    expect(namespaceAllowedFor('cameraSensors', {})).toBe(false);
  });

  it('joins the refusals when several gated namespaces are sent together', () => {
    const r = validateConfigPatch(
      { ...body, obd: { enabled: true } },
      { simulated: false, obd: false, cameraSensors: cameraSensorsEligibility(jsDevice) },
    ) as { error: string };
    expect(r.error).toContain('obd apply only to devices whose model declares');
    expect(r.error).toContain(JS_MESSAGE);
  });
});

describe('cameraSensors: the retained config message', () => {
  const value = cams({ cam0: { sensor: 'imx708' }, cam1: { sensor: 'none' } });
  const allowed = { cameraSensors: { allowed: true } } as const;
  const TS = 1_800_000_000_000;

  it('rides LAST of the namespaces for an eligible device', () => {
    const msg = buildDeviceConfigMessage(
      { timeSync: { offlineSources: true }, cameraSensors: value } as never,
      7,
      TS,
      null,
      null,
      allowed,
    );
    expect(msg.cameraSensors).toEqual(value);
    expect(Object.keys(msg)).toEqual(['v', 'rev', 'gnssAntBias', 'timeSync', 'cameraSensors', 'ts']);
  });

  it('a cleared namespace travels as {} for an eligible device', () => {
    const msg = buildDeviceConfigMessage({ cameraSensors: null }, 7, TS, null, null, allowed);
    expect(msg.cameraSensors).toEqual({});
  });

  it('an absent namespace is never emitted, eligible or not (absent = unmanaged)', () => {
    for (const facts of [undefined, {}, allowed]) {
      const msg = buildDeviceConfigMessage({ gnssAntBias: true }, 7, TS, null, null, facts);
      expect('cameraSensors' in msg).toBe(false);
    }
  });

  it('is NOT published without proof of eligibility, value or cleared marker alike', () => {
    for (const facts of [
      undefined,
      {},
      { cameraSensors: cameraSensorsEligibility(jsDevice) },
      { cameraSensors: cameraSensorsEligibility(simDevice) },
      { cameraSensors: cameraSensorsEligibility(oldRust) },
    ]) {
      const held = buildDeviceConfigMessage({ cameraSensors: value } as never, 7, TS, null, null, facts);
      expect('cameraSensors' in held).toBe(false);
      const cleared = buildDeviceConfigMessage({ cameraSensors: null }, 7, TS, null, null, facts);
      expect('cameraSensors' in cleared).toBe(false);
    }
  });

  it('JS device: the message is byte-identical to today, whatever the row holds', () => {
    // A realistic fielded JS document, with a scope and a hardware block.
    const doc = {
      gnssAntBias: true,
      imuMount: { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 90 },
      recording: { video: { enabled: true, cameras: { cam1: false } } },
      cameraMount: { cameras: { cam0: { rotationDeg: 180 as const } } },
    };
    const scope = { organizationId: 'org-1', workspaceId: 'ws-1' };
    const hardware = {
      v: 2 as const,
      platform: 'rpi-cm5' as const,
      encoder: 'sw-h264' as const,
      rails: true,
      statusLed: null,
      imu: 'bno085',
      video: [
        { key: 'cam0', connector: 'csi0', sensor: 'imx290', codec: 'h264' },
        { key: 'cam1', connector: 'csi1', sensor: 'imx290', codec: 'h264' },
      ],
    };
    // "Today": the five-argument call every publish made before this namespace.
    const before = JSON.stringify(buildDeviceConfigMessage(doc, 42, TS, scope, hardware));
    expect(before).toBe(
      '{"v":1,"rev":42,"gnssAntBias":true,' +
        '"imuMount":{"enabled":true,"rollDeg":90,"pitchDeg":0,"yawDeg":90},' +
        '"recording":{"video":{"enabled":true,"cameras":{"cam1":false}}},' +
        '"cameraMount":{"cameras":{"cam0":{"rotationDeg":180}}},' +
        '"scope":{"organizationId":"org-1","workspaceId":"ws-1"},' +
        '"hardware":{"v":2,"platform":"rpi-cm5","encoder":"sw-h264","rails":true,"statusLed":null,' +
        '"imu":"bno085","video":[' +
        '{"key":"cam0","connector":"csi0","sensor":"imx290","codec":"h264"},' +
        '{"key":"cam1","connector":"csi1","sensor":"imx290","codec":"h264"}]},' +
        `"ts":${TS}}`,
    );
    const jsFacts = { cameraSensors: cameraSensorsEligibility(jsDevice) };
    // With the gate facts of a JS device: the same bytes.
    expect(JSON.stringify(buildDeviceConfigMessage(doc, 42, TS, scope, hardware, jsFacts))).toBe(before);
    // Even if a JS row held the key (nothing can store it there): the same bytes.
    const poisoned = { ...doc, cameraSensors: value };
    expect(
      JSON.stringify(buildDeviceConfigMessage(poisoned as never, 42, TS, scope, hardware, jsFacts)),
    ).toBe(before);
    expect(JSON.stringify(buildDeviceConfigMessage(poisoned as never, 42, TS, scope, hardware))).toBe(
      before,
    );
  });
});

describe('cameraSensors: the served device document (deviceResponse)', () => {
  const value = cams({ cam0: { sensor: 'imx708' } });
  const row = (device: object, config: unknown): DeviceRow =>
    ({ id: 'd1', agentVersion: null, ...device, config }) as unknown as DeviceRow;

  it('is served for a device that may hold it', () => {
    expect(deviceResponse(row(freshRust, { cameraSensors: value })).config).toEqual({
      cameraSensors: value,
    });
    expect(deviceResponse(row(capableRust, { cameraSensors: value })).config).toEqual({
      cameraSensors: value,
    });
  });

  it('is never served for an agent that cannot act on it (it would read as applied)', () => {
    for (const device of [oldRust, jsDevice, simDevice]) {
      const served = deviceResponse(row(device, { gnssAntBias: true, cameraSensors: value })).config;
      expect(served).toEqual({ gnssAntBias: true });
      expect('cameraSensors' in served).toBe(false);
    }
  });

  it('leaves a document without the key untouched, for every kind of device', () => {
    const doc = { gnssAntBias: true, cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } };
    for (const device of [oldRust, jsDevice, simDevice, freshRust, capableRust]) {
      const served = deviceResponse(row(device, doc)).config;
      expect(JSON.stringify(served)).toBe(JSON.stringify(doc));
    }
  });
});

describe('cameraSensors: the config contract', () => {
  const contract = buildConfigContract();
  const entry = contract.namespaces.cameraSensors;

  it('carries the namespace, last', () => {
    expect(Object.keys(contract.namespaces).at(-1)).toBe('cameraSensors');
    expect(entry.applyClass).toBe('agent-poll');
    expect(entry.kind).toBe('object');
    expect(entry.defaults).toEqual({ cameras: {} });
  });

  it('types sensor as a constrained string: NO sensor id list in the contract', () => {
    const schema = entry.jsonSchema as {
      properties: { cameras: { additionalProperties: { properties: Record<string, Record<string, unknown>> } } };
    };
    const port = schema.properties.cameras.additionalProperties.properties;
    expect(port.sensor).toMatchObject({ type: 'string', pattern: '^[a-z][a-z0-9]{1,31}$' });
    expect(port.sensor).not.toHaveProperty('enum');
    expect(port.options).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } });
    // Adding sensor six must not move the contract: no catalog id may appear in
    // the namespace's JSON Schema. (Prose may name one as an example.)
    const text = JSON.stringify(schema);
    expect(text).not.toContain('"enum"');
  });

  it('the committed contract holds it and the committed catalog did not change', () => {
    const committed = JSON.parse(
      readFileSync(join(__dirname, '..', 'src/config-registry/config-contract.json'), 'utf8'),
    );
    expect(committed.namespaces.cameraSensors).toEqual(JSON.parse(JSON.stringify(entry)));
    // The catalog artifact is pinned by content in camera-catalog.test.ts; a
    // new NAMESPACE must not have touched it.
    expect(CAMERA_CATALOG.catalogVersion).toBe(3);
  });
});
