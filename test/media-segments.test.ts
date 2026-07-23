import { describe, expect, it } from 'vitest';
import {
  buildSegmentRows,
  parseMediaSegmentObjectKey,
  sidecarKeyFor,
  sidecarMatchesKey,
  videoSidecarSchema,
} from '../src/services/media-segments';

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const SESSION = '019f857a-1111-7222-8333-444455556666';
const MP4_KEY = `media-sessions/v1/${DEVICE}/cam0/${SESSION}/00003.mp4`;

// A real Phase 3 sidecar shape (incl. the anchor/finalized provenance fields).
const SIDECAR = {
  v: 1,
  deviceId: DEVICE,
  streamKey: 'cam0',
  sessionId: SESSION,
  seq: 3,
  startTs: 1753000000000,
  startMono: 123456.789,
  durationMs: 59987,
  sizeBytes: 15_000_000,
  timeSource: 'ntp',
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: 15,
  bitrateKbps: 2000,
  anchor: 'fstat',
  finalized: true,
};

describe('parseMediaSegmentObjectKey', () => {
  it('parses mp4 and json keys (zero-padded seq)', () => {
    expect(parseMediaSegmentObjectKey(MP4_KEY)).toEqual({
      deviceId: DEVICE,
      streamKey: 'cam0',
      sessionId: SESSION,
      seq: 3,
      ext: 'mp4',
    });
    expect(parseMediaSegmentObjectKey(sidecarKeyFor(MP4_KEY))?.ext).toBe('json');
  });

  it('rejects foreign shapes', () => {
    for (const key of [
      `media/v1/${DEVICE}/cam0/rec.mp4`, // cloud-recorder prefix
      `media-sessions/v1/${DEVICE}/cam0/${SESSION}/evil.mp4`,
      `media-sessions/v1/${DEVICE}/cam0/not-a-uuid/00000.mp4`,
      `media-sessions/v1/not-a-uuid/cam0/${SESSION}/00000.mp4`,
      `media-sessions/v1/${DEVICE}/bad key/${SESSION}/00000.mp4`,
      `media-sessions/v1/${DEVICE}/cam0/${SESSION}/00000.mkv`,
      `media-sessions/v2/${DEVICE}/cam0/${SESSION}/00000.mp4`,
    ]) {
      expect(parseMediaSegmentObjectKey(key)).toBeNull();
    }
  });
});

describe('videoSidecarSchema', () => {
  it('accepts the device contract, tolerating unknown extra fields', () => {
    const parsed = videoSidecarSchema.safeParse({ ...SIDECAR, futureField: 'x' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a minimal sidecar without the optional provenance fields', () => {
    const { anchor: _a, finalized: _f, startMono: _m, timeSource: _t, ...minimal } = SIDECAR;
    expect(videoSidecarSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects a sidecar missing timing facts', () => {
    const { startTs: _s, ...broken } = SIDECAR;
    expect(videoSidecarSchema.safeParse(broken).success).toBe(false);
  });
});

describe('sidecarMatchesKey', () => {
  const key = parseMediaSegmentObjectKey(MP4_KEY)!;
  const sc = videoSidecarSchema.parse(SIDECAR);

  it('accepts a matching pair and rejects any identity drift', () => {
    expect(sidecarMatchesKey(key, sc)).toBe(true);
    expect(sidecarMatchesKey(key, { ...sc, deviceId: SESSION })).toBe(false);
    expect(sidecarMatchesKey(key, { ...sc, streamKey: 'cam1' })).toBe(false);
    expect(sidecarMatchesKey(key, { ...sc, sessionId: DEVICE })).toBe(false);
    expect(sidecarMatchesKey(key, { ...sc, seq: 4 })).toBe(false);
  });
});

describe('buildSegmentRows', () => {
  const key = parseMediaSegmentObjectKey(MP4_KEY)!;
  const sc = videoSidecarSchema.parse(SIDECAR);
  const { session, segment, segmentEnd } = buildSegmentRows(key, MP4_KEY, sc);

  it('session row: id = device session uuid, window from the segment', () => {
    expect(session.id).toBe(SESSION);
    expect(session.deviceId).toBe(DEVICE);
    expect(session.streamKey).toBe('cam0');
    expect(session.source).toBe('device-offline');
    expect(session.status).toBe('open');
    expect(session.startedAt).toEqual(new Date(SIDECAR.startTs));
    expect(session.endedAt).toEqual(new Date(SIDECAR.startTs + SIDECAR.durationMs));
    expect(session.width).toBe(1920);
    expect(session.timeSource).toBe('ntp');
    expect(session.bitrateKbps).toBe(2000);
  });

  it('segment row: identity from the key, facts from the sidecar', () => {
    expect(segment.s3Key).toBe(MP4_KEY);
    expect(segment.sessionId).toBe(SESSION);
    expect(segment.seq).toBe(3);
    expect(segment.startTs).toEqual(new Date(SIDECAR.startTs));
    expect(segment.durationMs).toBe(59987);
    expect(segment.sizeBytes).toBe(15_000_000);
    expect(segment.keyframe).toBe(true);
    expect(segment.finalized).toBe(true);
    expect(segment.meta).toEqual({ anchor: 'fstat', timeSource: 'ntp', startMono: 123456.789 });
    expect(segmentEnd).toEqual(new Date(SIDECAR.startTs + SIDECAR.durationMs));
  });

  it('a crash-cut sidecar (finalized:false) is stored, not rejected', () => {
    const cut = buildSegmentRows(key, MP4_KEY, { ...sc, finalized: false, anchor: 'computed' });
    expect(cut.segment.finalized).toBe(false);
    expect((cut.segment.meta as Record<string, unknown>).anchor).toBe('computed');
  });

  it('defaults finalized to true when the field is absent', () => {
    const { finalized: _f, ...noFlag } = sc;
    const rows = buildSegmentRows(key, MP4_KEY, videoSidecarSchema.parse(noFlag));
    expect(rows.segment.finalized).toBe(true);
  });
});
