import { describe, expect, it } from 'vitest';
import {
  parseSegment,
  parseTelemetryObjectKey,
} from '../src/services/telemetry-batch';
import { recordingStatusSchema, telemetryPayloadSchema } from '../src/schemas/telemetry';
import { flattenTelemetryToRows } from '../src/schemas/telemetry';

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const SESSION = '019f857a-1111-7222-8333-444455556666';

describe('parseTelemetryObjectKey', () => {
  it('parses the contract key shape', () => {
    expect(
      parseTelemetryObjectKey(`telemetry/v1/${DEVICE}/${SESSION}/1753000000000-00003.jsonl.gz`),
    ).toEqual({ deviceId: DEVICE, sessionId: SESSION, startTsMs: 1753000000000, seq: 3 });
  });

  it('rejects foreign shapes', () => {
    for (const key of [
      `media/v1/${DEVICE}/cam0/rec.mp4`,
      `telemetry/v1/${DEVICE}/${SESSION}/whatever.jsonl.gz`,
      `telemetry/v1/not-a-uuid/${SESSION}/1-00000.jsonl.gz`,
      `telemetry/v1/${DEVICE}/${SESSION}/1-00000.jsonl`,
      `telemetry/v2/${DEVICE}/${SESSION}/1-00000.jsonl.gz`,
    ]) {
      expect(parseTelemetryObjectKey(key)).toBeNull();
    }
  });
});

function segmentText(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const NOW = Date.UTC(2026, 6, 21);
const OPTS = { deviceId: DEVICE, now: NOW, maxAgeMs: 90 * 86400_000, maxFutureMs: 45 * 86400_000 };

const header = {
  type: 'header',
  v: 1,
  deviceId: DEVICE,
  sessionId: SESSION,
  bootId: 'b',
  timeSource: 'ntp',
  rateHz: 10,
  startedAt: NOW - 1000,
};

describe('parseSegment', () => {
  it('flattens samples into <group>.<field> rows and skips headers', () => {
    const text = segmentText([
      header,
      { ts: NOW - 500, mono: 1, seq: 0, metrics: { imu: { accel_x: { value: 0.5, unit: 'm/s2' } } } },
      { ...header, timeSource: 'unsynced' }, // mid-file timeSource re-emission
      { ts: NOW - 400, mono: 2, seq: 1, metrics: { gps: { lat: { value: 1 }, lon: { value: 2 } } } },
    ]);
    const parsed = parseSegment(text, OPTS);
    expect(parsed.samples).toBe(2);
    expect(parsed.skippedInvalid).toBe(0);
    expect(parsed.deviceIdMismatch).toBe(false);
    expect(parsed.rows).toEqual([
      { deviceId: DEVICE, ts: new Date(NOW - 500), metric: 'imu.accel_x', value: 0.5, unit: 'm/s2' },
      { deviceId: DEVICE, ts: new Date(NOW - 400), metric: 'gps.lat', value: 1, unit: null },
      { deviceId: DEVICE, ts: new Date(NOW - 400), metric: 'gps.lon', value: 2, unit: null },
    ]);
  });

  it('skips malformed lines without dropping the file', () => {
    const text =
      segmentText([header, { ts: NOW, mono: 1, seq: 0, metrics: { imu: { a: { value: 1 } } } }]) +
      'not json\n' +
      segmentText([{ ts: 'nope', metrics: {} }, { ts: NOW, mono: 3, seq: 2, metrics: { imu: { b: { value: 2 } } } }]);
    const parsed = parseSegment(text, OPTS);
    expect(parsed.samples).toBe(2);
    expect(parsed.skippedInvalid).toBe(2);
  });

  it('rejects samples outside the partition-age window (both directions)', () => {
    const text = segmentText([
      header,
      { ts: NOW - 91 * 86400_000, mono: 1, seq: 0, metrics: { imu: { a: { value: 1 } } } },
      { ts: NOW + 46 * 86400_000, mono: 2, seq: 1, metrics: { imu: { a: { value: 2 } } } },
      { ts: NOW, mono: 3, seq: 2, metrics: { imu: { a: { value: 3 } } } },
    ]);
    const parsed = parseSegment(text, OPTS);
    expect(parsed.samples).toBe(1);
    expect(parsed.skippedAge).toBe(2);
    expect(parsed.rows.map((r) => r.value)).toEqual([3]);
  });

  it('flags a header that contradicts the key deviceId', () => {
    const text = segmentText([
      { ...header, deviceId: '00000000-0000-4000-8000-000000000000' },
      { ts: NOW, mono: 1, seq: 0, metrics: { imu: { a: { value: 1 } } } },
    ]);
    expect(parseSegment(text, OPTS).deviceIdMismatch).toBe(true);
  });
});

describe('telemetry payload recording block', () => {
  const recording = {
    enabled: true,
    sessionId: SESSION,
    backlogBytes: 1024,
    backlogSegments: 2,
    droppedSegments: 17,
    uploading: false,
    lastUploadAt: null,
  };

  it('accepts a payload with the recording block and flattens its gauges', () => {
    const payload = telemetryPayloadSchema.parse({
      v: 1,
      deviceId: DEVICE,
      ts: NOW,
      metrics: { imu: { a: { value: 1 } } },
      recording,
    });
    expect(payload.recording).toEqual(recording);
    const metrics = flattenTelemetryToRows(payload).map((r) => [r.metric, r.value]);
    expect(metrics).toEqual([
      ['imu.a', 1],
      ['recording.enabled', 1],
      ['recording.uploading', 0],
      ['recording.backlog_bytes', 1024],
      ['recording.backlog_segments', 2],
      ['recording.dropped_segments', 17],
    ]);
  });

  it('still accepts payloads without the block (pre-Phase-2 agents)', () => {
    const payload = telemetryPayloadSchema.parse({ v: 1, deviceId: DEVICE, ts: NOW, metrics: {} });
    expect(payload.recording).toBeUndefined();
  });

  it('mirrors the device RecordingStatus shape', () => {
    expect(recordingStatusSchema.safeParse(recording).success).toBe(true);
    expect(recordingStatusSchema.safeParse({ ...recording, backlogBytes: -1 }).success).toBe(false);
  });
});
