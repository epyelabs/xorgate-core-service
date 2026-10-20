import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { INDEX_FUTURE_SLACK_MS, plausibleSampleTs } from '../src/services/telemetry-batch';
import {
  isTelemetryArtifactKey,
  iterateSegmentLines,
  parseSegment,
  parseTelemetryObjectKey,
  rebuildSegmentText,
  replaceSampleTs,
  shiftSegmentText,
  summarizeSegment,
  worstTimeSource,
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

  it('recognises the artifacts the sweeper writes next to the segments', () => {
    expect(isTelemetryArtifactKey(`telemetry/v1/${DEVICE}/${SESSION}/overview.v1.json.gz`)).toBe(true);
    expect(isTelemetryArtifactKey(`telemetry/v1/${DEVICE}/${SESSION}/raw.v2.jsonl.gz`)).toBe(true);
    expect(isTelemetryArtifactKey(`telemetry/v1/${DEVICE}/${SESSION}/1753000000000-00003.jsonl.gz`)).toBe(false);
    expect(parseTelemetryObjectKey(`telemetry/v1/${DEVICE}/${SESSION}/overview.v1.json.gz`)).toBeNull();
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

describe('parseSegment session-index fields (telemetry-session-artifacts Phase 1)', () => {
  it('lifts the first header and the min/max ts over every valid sample line', () => {
    const text = segmentText([
      header,
      { ts: NOW - 500, mono: 1, seq: 0, metrics: { imu: { a: { value: 1 } } } },
      { ts: NOW - 91 * 86400_000, mono: 2, seq: 1, metrics: { imu: { a: { value: 2 } } } }, // outside the window
      { ts: NOW - 400, mono: 3, seq: 2, metrics: { imu: { a: { value: 3 } } } },
    ]);
    const parsed = parseSegment(text, OPTS);
    expect(parsed.header).toEqual({ rateHz: 10, timeSource: 'ntp', startedAt: NOW - 1000, bootId: 'b' });
    expect(parsed.samples).toBe(2);
    expect(parsed.sampleLines).toBe(3);
    expect(parsed.skippedAge).toBe(1);
    // The index describes the FILE: the age-skipped line still bounds the window.
    expect(parsed.firstTs).toBe(NOW - 91 * 86400_000);
    expect(parsed.lastTs).toBe(NOW - 400);
  });

  it('keeps the WORST time source across header re-emissions, in either order', () => {
    const downgrade = segmentText([header, { ...header, timeSource: 'unsynced' }]);
    expect(parseSegment(downgrade, OPTS).header?.timeSource).toBe('unsynced');
    const upgrade = segmentText([{ ...header, timeSource: 'rtc' }, { ...header, timeSource: 'ntp' }]);
    expect(parseSegment(upgrade, OPTS).header?.timeSource).toBe('rtc');
    expect(worstTimeSource('ntp', 'gps')).toBe('gps');
    expect(worstTimeSource(null, 'ntp')).toBe('ntp');
    expect(worstTimeSource('ntp', undefined)).toBe('ntp');
    expect(worstTimeSource('weird', 'ntp')).toBe('weird');
  });

  it('tolerates a header without provenance fields and a file without a header', () => {
    const bare = segmentText([{ type: 'header', deviceId: DEVICE, sessionId: SESSION }, { ts: NOW, mono: 1, seq: 0, metrics: {} }]);
    expect(parseSegment(bare, OPTS).header).toEqual({ rateHz: null, timeSource: null, startedAt: null, bootId: null });
    const none = segmentText([{ ts: NOW, mono: 1, seq: 0, metrics: {} }]);
    const parsed = parseSegment(none, OPTS);
    expect(parsed.header).toBeNull();
    expect(parsed.firstTs).toBe(NOW);
    expect(parsed.samples).toBe(1);
    expect(parsed.rows).toEqual([]);
  });

  it('summarizeSegment: header + bounds + counts, no rows, no age window', () => {
    const text = segmentText([
      header,
      { ts: NOW - 400 * 86400_000, mono: 1, seq: 0, metrics: { imu: { a: { value: 1 } } } },
      { ...header, timeSource: 'rtc' },
      { ts: NOW, mono: 2, seq: 1, metrics: { imu: { a: { value: 1 } } } },
    ]) + 'not json\n';
    expect(summarizeSegment(text)).toEqual({
      header: { rateHz: 10, timeSource: 'rtc', startedAt: NOW - 1000, bootId: 'b' },
      sampleLines: 2,
      invalidLines: 1,
      firstTs: NOW - 400 * 86400_000,
      lastTs: NOW,
      // clock-step fields: nothing detected without the option
      clockSteps: [],
      rawFirstTs: NOW - 400 * 86400_000,
      rawLastTs: NOW,
      staleTs: [],
      staleTsGroups: [],
      staleBefore: null,
    });
    expect([...iterateSegmentLines('\n\n')]).toEqual([]);
    expect([...iterateSegmentLines('{"type":"header","deviceId":"x"}\n')]).toEqual([{ kind: 'invalid' }]);
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

describe('plausibleSampleTs (telemetry-session-artifacts Phase 2)', () => {
  const arrived = Date.UTC(2026, 6, 29, 23, 34, 19);
  it('keeps a sample at, before, or within a day after its upload', () => {
    expect(plausibleSampleTs(arrived - 3_600_000, arrived)).toBe(arrived - 3_600_000);
    expect(plausibleSampleTs(arrived, arrived)).toBe(arrived);
    expect(plausibleSampleTs(arrived + 8 * 60_000, arrived)).toBe(arrived + 8 * 60_000); // real rtc skew on dev
    expect(plausibleSampleTs(arrived + INDEX_FUTURE_SLACK_MS, arrived)).toBe(arrived + INDEX_FUTURE_SLACK_MS);
  });
  it('replaces a sample stamped past the slack (the 2080 RTC) with the arrival time', () => {
    expect(plausibleSampleTs(Date.UTC(2080, 0, 6), arrived)).toBe(arrived);
    expect(plausibleSampleTs(arrived + INDEX_FUTURE_SLACK_MS + 1, arrived)).toBe(arrived);
  });
});

// ---- clock-step correction (plans/clock-step-correction P2, §4.3) ----------
//
// Fixture: prod telemetry session 01a14954-4f1d-718e-80b1-8089fca3c017 (device
// "Tacloban 02"), ids anonymised by plain string substitution, every other byte
// as the agent wrote it. The CM5 booted on the fake-hwclock stamp
// (2026-10-17 10:07Z); NTP stepped the clock 226 669 005 ms (~63 h) forward
// between the first two samples of seq 1. seq 0 is entirely stale.
const CLOCK_FIXTURES = join(__dirname, 'fixtures', 'clock-step-telemetry');
const fixtureText = (name: string): string => gunzipSync(readFileSync(join(CLOCK_FIXTURES, name))).toString('utf8');
const SEQ0 = fixtureText('1792231625531-00000.jsonl.gz');
const SEQ1 = fixtureText('1792231686490-00001.jsonl.gz');
const FIX_DEVICE = 'c10c57e9-0000-4000-8000-00000000d002';
const FIX_NOW = Date.UTC(2026, 9, 20, 2);
const FIX_OPTS = { deviceId: FIX_DEVICE, now: FIX_NOW, maxAgeMs: 90 * 86400_000, maxFutureMs: 45 * 86400_000 };
const STEP_MS = 226_669_005;

describe('clock-step correction: parseSegment on the prod straddling file', () => {
  it('parses mono (hrtime ns) off every sample line and keeps the raw text', () => {
    const samples = [...iterateSegmentLines(SEQ1)].filter((l) => l.kind === 'sample');
    expect(samples).toHaveLength(61);
    expect(samples.every((l) => l.kind === 'sample' && typeof l.sample.mono === 'number')).toBe(true);
    const first = samples[0];
    if (first.kind !== 'sample') throw new Error('unreachable');
    expect(first.sample).toMatchObject({ ts: 1792231686490, mono: 75554021954, seq: 60 });
    expect(first.lineNo).toBe(1);
    expect(first.raw).toBe(SEQ1.split('\n')[1]);
  });

  it('finds exactly one ~63 h forward step at the second sample and re-stamps the first', () => {
    const parsed = parseSegment(SEQ1, { ...FIX_OPTS, clockStepMinMs: 10_000 });
    expect(parsed.clockSteps).toEqual([{ atIndex: 1, jumpMs: STEP_MS }]);
    expect(parsed.rawFirstTs).toBe(1792231686490); // 2026-10-17T10:08:06.490Z
    expect(parsed.rawLastTs).toBe(1792458415511);
    expect(parsed.staleTs).toEqual([1792231686490]);
    expect(parsed.staleTsGroups).toEqual([{ shiftMs: STEP_MS, ts: [1792231686490] }]);
    expect(parsed.staleBefore).toBe(1792458356539); // raw ts of the first post-step sample
    // Corrected bounds: one honest 60 s file instead of a 63 h one.
    expect(new Date(parsed.firstTs!).toISOString()).toBe('2026-10-20T01:05:55.495Z');
    expect(new Date(parsed.lastTs!).toISOString()).toBe('2026-10-20T01:06:55.511Z');
    expect(parsed.lastTs! - parsed.firstTs!).toBeLessThan(61_000);
    // Rows of the stale sample carry the corrected ts; none keeps the stale one.
    expect(parsed.rows.filter((r) => r.ts.getTime() === 1792231686490 + STEP_MS).length).toBeGreaterThan(0);
    expect(parsed.rows.some((r) => r.ts.getTime() === 1792231686490)).toBe(false);
    expect(parsed.sampleLines).toBe(61);
    expect(parsed.samples).toBe(61);
    expect(parsed.header?.timeSource).toBe('rtc');
  });

  it('correctedText is the input byte for byte except the shifted ts token', () => {
    const parsed = parseSegment(SEQ1, { ...FIX_OPTS, clockStepMinMs: 10_000 });
    const corrected = parsed.correctedText!;
    expect(corrected).toBeDefined();
    const inLines = SEQ1.split('\n');
    const outLines = corrected.split('\n');
    expect(outLines).toHaveLength(inLines.length);
    expect(corrected.endsWith('\n')).toBe(SEQ1.endsWith('\n'));
    const changed = inLines.map((l, i) => (l === outLines[i] ? -1 : i)).filter((i) => i >= 0);
    expect(changed).toEqual([1]); // only the stale sample line; headers (lines 0 and 3) untouched
    expect(outLines[1]).toBe(inLines[1].replace('"ts":1792231686490,', `"ts":${1792231686490 + STEP_MS},`));
    expect(Buffer.byteLength(corrected)).toBe(Buffer.byteLength(SEQ1)); // same digit count here
    // Re-parsing the corrected text finds no step (self-cancelling, D8) and the same rows.
    const again = parseSegment(corrected, { ...FIX_OPTS, clockStepMinMs: 10_000 });
    expect(again.clockSteps).toEqual([]);
    expect(again.correctedText).toBeUndefined();
    expect(again.rows).toEqual(parsed.rows);
  });

  it('a file with no step (the stale seq 0): no correctedText, output identical to detection off', () => {
    const on = parseSegment(SEQ0, { ...FIX_OPTS, clockStepMinMs: 10_000 });
    const off = parseSegment(SEQ0, FIX_OPTS);
    expect(on.clockSteps).toEqual([]);
    expect(on.correctedText).toBeUndefined();
    expect(on).toEqual(off);
    expect(on.firstTs).toBe(1792231625531);
    expect(on.rawFirstTs).toBe(on.firstTs);
  });

  it('detection off (option absent or 0) leaves the straddling file as the device wrote it', () => {
    for (const clockStepMinMs of [undefined, 0]) {
      const parsed = parseSegment(SEQ1, { ...FIX_OPTS, clockStepMinMs });
      expect(parsed.clockSteps).toEqual([]);
      expect(parsed.correctedText).toBeUndefined();
      expect(parsed.firstTs).toBe(1792231686490);
      expect(parsed.lastTs).toBe(1792458415511);
    }
  });

  it('summarizeSegment reports the corrected bounds with the option (backfill/index path)', () => {
    const summary = summarizeSegment(SEQ1, { clockStepMinMs: 10_000 });
    expect(summary.clockSteps).toEqual([{ atIndex: 1, jumpMs: STEP_MS }]);
    expect(summary.firstTs).toBe(1792231686490 + STEP_MS);
    expect(summary.lastTs).toBe(1792458415511);
    expect(summary.rawFirstTs).toBe(1792231686490);
    expect(summary.correctedText).toBe(parseSegment(SEQ1, { ...FIX_OPTS, clockStepMinMs: 10_000 }).correctedText);
    expect(summarizeSegment(SEQ1).firstTs).toBe(1792231686490);
  });

  it('shiftSegmentText moves every sample of a wholly stale file, headers byte-identical', () => {
    const shifted = shiftSegmentText(SEQ0, STEP_MS);
    expect(shifted.sampleLines).toBe(60);
    expect(shifted.staleTs[0]).toBe(1792231625531);
    expect(shifted.staleTs.at(-1)).toBe(1792231685490);
    expect(new Date(shifted.firstTs!).toISOString()).toBe('2026-10-20T01:04:54.536Z');
    expect(new Date(shifted.lastTs!).toISOString()).toBe('2026-10-20T01:05:54.495Z');
    const inLines = SEQ0.split('\n');
    const outLines = shifted.text.split('\n');
    expect(outLines[0]).toBe(inLines[0]); // header
    for (let i = 1; i < inLines.length; i++) {
      if (inLines[i] === '') continue;
      const before = JSON.parse(inLines[i]) as { ts: number };
      expect(outLines[i]).toBe(inLines[i].replace(`"ts":${before.ts},`, `"ts":${before.ts + STEP_MS},`));
    }
    // Shifting back restores the original bytes.
    expect(shiftSegmentText(shifted.text, -STEP_MS).text).toBe(SEQ0);
    expect(shiftSegmentText(SEQ0, 0).text).toBe(SEQ0);
  });
});

describe('clock-step correction: synthetic cases', () => {
  const T0 = Date.UTC(2026, 9, 17, 10, 7, 0);
  const sample = (ts: number, monoMs: number, seq: number) =>
    `{"ts":${ts},"mono":${monoMs * 1e6},"seq":${seq},"metrics":{"imu":{"a":{"value":${seq}}}}}`;

  it('two steps in one file: cumulative offsets, one stale group per offset (D11)', () => {
    const lines = [
      JSON.stringify(header),
      sample(T0, 1000, 0),
      sample(T0 + 1000, 2000, 1),
      sample(T0 + 3_600_000 + 2000, 3000, 2), // +1 h step (NITZ)
      sample(T0 + 3_600_000 + 3000, 4000, 3),
      sample(T0 + 3_600_000 + 15_000 + 4000, 5000, 4), // +15 s refinement (NTP)
    ];
    const parsed = parseSegment(lines.join('\n') + '\n', { ...OPTS, now: T0, clockStepMinMs: 10_000 });
    expect(parsed.clockSteps).toEqual([
      { atIndex: 2, jumpMs: 3_600_000 },
      { atIndex: 4, jumpMs: 15_000 },
    ]);
    expect(parsed.staleTsGroups).toEqual([
      { shiftMs: 3_615_000, ts: [T0, T0 + 1000] },
      { shiftMs: 15_000, ts: [T0 + 3_600_000 + 2000, T0 + 3_600_000 + 3000] },
    ]);
    expect(parsed.staleBefore).toBe(T0 + 3_600_000 + 2000);
    const ts = [...iterateSegmentLines(parsed.correctedText!)].flatMap((l) => (l.kind === 'sample' ? [l.sample.ts] : []));
    const base = T0 + 3_615_000;
    expect(ts).toEqual([base, base + 1000, base + 2000, base + 3000, base + 4000]);
  });

  it('a backward step (RTC in 2080 stepped back by NTP) re-stamps the future samples back (D12)', () => {
    const future = Date.UTC(2080, 0, 6);
    const lines = [sample(future, 1000, 0), sample(future + 1000, 2000, 1), sample(T0, 3000, 2)];
    const parsed = parseSegment(lines.join('\n'), { ...OPTS, now: T0, clockStepMinMs: 10_000 });
    expect(parsed.clockSteps).toEqual([{ atIndex: 2, jumpMs: T0 - future - 2000 }]);
    expect(parsed.firstTs).toBe(T0 - 2000);
    expect(parsed.skippedAge).toBe(0); // the 2080 rows become insertable once corrected
  });

  it('samples without mono detect nothing (hand-made files)', () => {
    const text = [JSON.stringify(header), `{"ts":${T0},"metrics":{}}`, `{"ts":${T0 + 86_400_000},"metrics":{}}`].join('\n');
    const parsed = parseSegment(text, { ...OPTS, now: T0, clockStepMinMs: 10_000 });
    expect(parsed.clockSteps).toEqual([]);
    expect(parsed.correctedText).toBeUndefined();
  });

  it('invalid lines and blank lines survive the rewrite untouched', () => {
    const text = [sample(T0, 1000, 0), 'not json', '', sample(T0 + 60_000 + 1000, 2000, 1), ''].join('\n');
    const parsed = parseSegment(text, { ...OPTS, now: T0, clockStepMinMs: 10_000 });
    expect(parsed.skippedInvalid).toBe(1);
    expect(parsed.correctedText).toBe(
      [sample(T0 + 60_000, 1000, 0), 'not json', '', sample(T0 + 60_000 + 1000, 2000, 1), ''].join('\n'),
    );
  });
});

describe('replaceSampleTs', () => {
  it('swaps only the top-level ts token, not a nested one', () => {
    const raw = '{"metrics":{"x":{"ts":{"value":5},"y":{"value":1,"ts":7}}},"ts":100,"mono":3}';
    expect(replaceSampleTs(raw, 250)).toBe('{"metrics":{"x":{"ts":{"value":5},"y":{"value":1,"ts":7}}},"ts":250,"mono":3}');
  });

  it('ignores a "ts" string value and tolerates strings with escaped quotes', () => {
    const raw = '{"note":"say \\"ts\\":1","k":"ts","ts":42}';
    expect(replaceSampleTs(raw, 43)).toBe('{"note":"say \\"ts\\":1","k":"ts","ts":43}');
  });

  it('falls back to a key-order-preserving re-serialisation when the key is escaped', () => {
    const raw = '{"\\u0074s":10,"mono":1}';
    expect(replaceSampleTs(raw, 11)).toBe('{"ts":11,"mono":1}');
  });

  it('rebuildSegmentText with no replacements is the identity', () => {
    expect(rebuildSegmentText(SEQ1, new Map())).toBe(SEQ1);
  });
});
