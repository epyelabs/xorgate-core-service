import { describe, expect, it } from 'vitest';
import {
  historyColumnKeys,
  orderColumnsByModel,
  pivotRows,
} from '../src/services/telemetry-columns';

/**
 * The real io_capabilities of the dev test device's model, copied verbatim from
 * xorgatedb_dev on 2026-08-04 (device a73f7a36-…). Kept whole — including the
 * media/audio blocks the history table ignores — so the tests exercise the same
 * shape production sees, not a tidied-up version of it.
 *
 * ⚠ Note `system.fields` declares cpu_usage, **cpu_temp, ram_usage**, … The
 * frontend filters this list through its allowlist, so the MODEL's order wins,
 * not the allowlist's. That is the order asserted below.
 */
const PI_CAPS = {
  comm: {
    gps: {
      fields: [
        'lat', 'lon', 'alt', 'speed', 'course',
        'satellites', 'fix_quality', 'satellites_in_view', 'hdop', 'ttff_s',
      ],
    },
    module: '4g-lte',
    signal: { fields: ['rssi', 'quality', 'modem_temp', 'gnss_health', 'resets_24h'] },
  },
  media: {
    audio: [{ key: 'audio0', codec: 'opus', channels: 2, sampleRate: 48000 }],
    video: [
      { key: 'cam0', codec: 'h264', label: 'Left', maxFps: 25, maxWidth: 1280, maxHeight: 720 },
      { key: 'cam1', codec: 'h264', label: 'Right', maxFps: 25, maxWidth: 1280, maxHeight: 720 },
    ],
  },
  system: {
    fields: [
      'cpu_usage', 'cpu_temp', 'ram_usage', 'disk_usage',
      'rail_5v', 'psu_max_current', 'throttled',
    ],
  },
  sensors: {
    imu: {
      unit: 'm/s^2',
      accel: ['x', 'y', 'z'],
      euler: ['roll', 'pitch', 'yaw'],
      rateHz: 10,
      quaternion: ['r', 'i', 'j', 'k'],
    },
  },
  schemaVersion: 1,
};

const PI_COLUMNS = [
  'imu.accel_x', 'imu.accel_y', 'imu.accel_z',
  'imu.quat_r', 'imu.quat_i', 'imu.quat_j', 'imu.quat_k',
  'imu.euler_roll', 'imu.euler_pitch', 'imu.euler_yaw',
  'system.cpu_usage', 'system.cpu_temp', 'system.ram_usage',
  'system.disk_usage', 'system.rail_5v',
  'gps.lat', 'gps.lon',
];

describe('historyColumnKeys', () => {
  it('returns the Pi model\'s exact 17 columns, in order', () => {
    expect(historyColumnKeys(PI_CAPS)).toEqual(PI_COLUMNS);
    expect(historyColumnKeys(PI_CAPS)).toHaveLength(17);
  });

  it('drops non-chartable system fields', () => {
    // throttled is a bitmask and psu_max_current is boot-static — both are
    // declared by the Pi model and neither is a column.
    const cols = historyColumnKeys(PI_CAPS);
    expect(cols).not.toContain('system.throttled');
    expect(cols).not.toContain('system.psu_max_current');
  });

  it('shows only lat/lon of the ten declared GPS fields', () => {
    const cols = historyColumnKeys(PI_CAPS).filter((c) => c.startsWith('gps.'));
    expect(cols).toEqual(['gps.lat', 'gps.lon']);
  });

  it('omits lte.* entirely (that is producibleMetricKeys\' job, not this)', () => {
    expect(historyColumnKeys(PI_CAPS).some((c) => c.startsWith('lte.'))).toBe(false);
  });

  it('follows the model\'s system field order, not the allowlist\'s', () => {
    const reordered = {
      ...PI_CAPS,
      system: { fields: ['rail_5v', 'disk_usage', 'cpu_usage'] },
    };
    expect(historyColumnKeys(reordered).filter((c) => c.startsWith('system.'))).toEqual([
      'system.rail_5v',
      'system.disk_usage',
      'system.cpu_usage',
    ]);
  });

  it('handles a model with no IMU', () => {
    const { sensors, ...noImu } = PI_CAPS;
    expect(historyColumnKeys(noImu)).toEqual([
      'system.cpu_usage', 'system.cpu_temp', 'system.ram_usage',
      'system.disk_usage', 'system.rail_5v',
      'gps.lat', 'gps.lon',
    ]);
  });

  it('handles a model with no GPS', () => {
    const noGps = { ...PI_CAPS, comm: { module: '4g-lte' } };
    expect(historyColumnKeys(noGps)).toEqual(PI_COLUMNS.slice(0, 15));
    expect(historyColumnKeys(noGps).some((c) => c.startsWith('gps.'))).toBe(false);
  });

  it('includes GPS on the presence of the gps object, even with no fields', () => {
    // Mirrors the frontend's `Boolean(caps?.comm?.gps)` deliberately — the
    // column set and the metric filter must agree, and the frontend is the
    // shipped behaviour. See the ⚠ in telemetry-columns.ts.
    const emptyGps = { ...PI_CAPS, comm: { gps: { fields: [] } } };
    expect(historyColumnKeys(emptyGps).slice(-2)).toEqual(['gps.lat', 'gps.lon']);
  });

  it('accepts the legacy `axes` alias for `accel`', () => {
    const legacy = { sensors: { imu: { axes: ['x', 'y'] } } };
    expect(historyColumnKeys(legacy)).toEqual(['imu.accel_x', 'imu.accel_y']);
  });

  it('returns [] for null / undefined / junk capabilities', () => {
    expect(historyColumnKeys(null)).toEqual([]);
    expect(historyColumnKeys(undefined)).toEqual([]);
    expect(historyColumnKeys({})).toEqual([]);
    expect(historyColumnKeys({ sensors: { imu: null }, system: { fields: null } })).toEqual([]);
    expect(historyColumnKeys('not an object')).toEqual([]);
  });

  it('ignores non-string entries in a capability array', () => {
    const junk = { sensors: { imu: { accel: ['x', 42, null, 'z'] } } };
    expect(historyColumnKeys(junk)).toEqual(['imu.accel_x', 'imu.accel_z']);
  });
});

describe('orderColumnsByModel', () => {
  it('reorders a requested filter into model order', () => {
    expect(orderColumnsByModel(['gps.lat', 'imu.accel_z', 'imu.accel_x'], PI_CAPS)).toEqual([
      'imu.accel_x',
      'imu.accel_z',
      'gps.lat',
    ]);
  });

  it('appends requested metrics the model does not declare, in requested order', () => {
    expect(
      orderColumnsByModel(['lte.rssi', 'gps.lat', 'system.throttled', 'imu.accel_x'], PI_CAPS),
    ).toEqual(['imu.accel_x', 'gps.lat', 'lte.rssi', 'system.throttled']);
  });

  it('keeps the requested order when the model declares nothing', () => {
    expect(orderColumnsByModel(['b.b', 'a.a'], null)).toEqual(['b.b', 'a.a']);
  });
});

describe('pivotRows', () => {
  const t1 = new Date('2026-08-04T13:00:01.000Z');
  const t2 = new Date('2026-08-04T13:00:00.000Z');
  const cols = ['imu.accel_x', 'gps.lat', 'system.cpu_temp'];

  it('pivots into positional arrays, preserving input ts order', () => {
    // Input order is (ts desc, metric asc), as the page query returns it.
    const rows = [
      { ts: t1, metric: 'gps.lat', value: 14.5 },
      { ts: t1, metric: 'imu.accel_x', value: 0.12 },
      { ts: t2, metric: 'imu.accel_x', value: 0.34 },
      { ts: t2, metric: 'system.cpu_temp', value: 47.3 },
    ];
    expect(pivotRows(rows, cols)).toEqual([
      { ts: '2026-08-04T13:00:01.000Z', v: [0.12, 14.5, null] },
      { ts: '2026-08-04T13:00:00.000Z', v: [0.34, null, 47.3] },
    ]);
  });

  it('always emits an array of exactly columns.length, trailing nulls included', () => {
    const rows = [{ ts: t1, metric: 'imu.accel_x', value: 1 }];
    const [row] = pivotRows(rows, cols);
    expect(row.v).toHaveLength(cols.length);
    expect(row.v).toEqual([1, null, null]);
  });

  it('preserves a stored null as null (a reading that exists but has no value)', () => {
    const rows = [
      { ts: t1, metric: 'imu.accel_x', value: null },
      { ts: t1, metric: 'gps.lat', value: 0 },
    ];
    // 0 must survive as 0 — it is a real reading, not a gap.
    expect(pivotRows(rows, cols)[0].v).toEqual([null, 0, null]);
  });

  it('ignores metrics outside the column set rather than shifting indices', () => {
    const rows = [
      { ts: t1, metric: 'lte.rssi', value: -70 },
      { ts: t1, metric: 'system.cpu_temp', value: 47.3 },
    ];
    expect(pivotRows(rows, cols)).toEqual([
      { ts: '2026-08-04T13:00:01.000Z', v: [null, null, 47.3] },
    ]);
  });

  it('emits no row for a timestamp whose every metric is off-column', () => {
    expect(pivotRows([{ ts: t1, metric: 'lte.rssi', value: -70 }], cols)).toEqual([]);
  });

  it('returns [] for no rows and for no columns', () => {
    expect(pivotRows([], cols)).toEqual([]);
    expect(pivotRows([{ ts: t1, metric: 'gps.lat', value: 1 }], [])).toEqual([]);
  });
});
