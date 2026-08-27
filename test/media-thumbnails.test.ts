import { describe, expect, it } from 'vitest';
import { parseMediaSegmentObjectKey } from '../src/services/media-segments';
import {
  FIRST_SEGMENT_SUFFIX,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_SEEK_SECONDS,
  ffmpegThumbnailArgs,
  thumbnailKeyFor,
} from '../src/services/media-thumbnails';

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const SESSION = '019f857a-1111-7222-8333-444455556666';
const FIRST_KEY = `media-sessions/v1/${DEVICE}/cam0/${SESSION}/00000.mp4`;

describe('thumbnailKeyFor', () => {
  it('lands the thumbnail inside the session prefix (lifecycle + DELETE coverage)', () => {
    const parsed = parseMediaSegmentObjectKey(FIRST_KEY);
    expect(parsed).not.toBeNull();
    expect(thumbnailKeyFor(parsed!)).toBe(
      `media-sessions/v1/${DEVICE}/cam0/${SESSION}/thumb.jpg`,
    );
  });

  it('never collides with a segment key (thumb.jpg does not parse as one)', () => {
    const parsed = parseMediaSegmentObjectKey(FIRST_KEY)!;
    expect(parseMediaSegmentObjectKey(thumbnailKeyFor(parsed))).toBeNull();
  });
});

describe('FIRST_SEGMENT_SUFFIX (the EventBridge rule filter)', () => {
  it('matches exactly the seq-0 mp4 the handler expects', () => {
    expect(FIRST_KEY.endsWith(FIRST_SEGMENT_SUFFIX)).toBe(true);
    const parsed = parseMediaSegmentObjectKey(FIRST_KEY)!;
    expect(parsed.seq).toBe(0);
    expect(parsed.ext).toBe('mp4');
  });

  it('does not match later segments or sidecars', () => {
    expect(
      `media-sessions/v1/${DEVICE}/cam0/${SESSION}/00003.mp4`.endsWith(FIRST_SEGMENT_SUFFIX),
    ).toBe(false);
    expect(
      `media-sessions/v1/${DEVICE}/cam0/${SESSION}/00000.json`.endsWith(FIRST_SEGMENT_SUFFIX),
    ).toBe(false);
  });
});

describe('ffmpegThumbnailArgs', () => {
  it('seeks past the sensor warm-up by default (blown-out first frames)', () => {
    const args = ffmpegThumbnailArgs('/tmp/in.mp4', '/tmp/out.jpg')
    const ss = args.indexOf('-ss')
    expect(args.slice(ss, ss + 2)).toEqual(['-ss', String(THUMBNAIL_SEEK_SECONDS)])
    // Input seek: -ss must precede -i to land on a keyframe cheaply.
    expect(ss).toBeLessThan(args.indexOf('-i'))
  })

  it('omits the seek entirely for the frame-0 fallback', () => {
    expect(ffmpegThumbnailArgs('/tmp/in.mp4', '/tmp/out.jpg', 0)).not.toContain('-ss')
  })

  it('extracts a single downscaled frame, quietly, overwriting the output', () => {
    const args = ffmpegThumbnailArgs('/tmp/in.mp4', '/tmp/out.jpg');
    expect(args).toContain('-nostdin');
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', '/tmp/in.mp4']);
    expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual([
      '-frames:v',
      '1',
    ]);
    // Width is capped, never upscaled; -2 keeps the height encoder-legal (even).
    expect(args).toContain(`scale='min(iw,${THUMBNAIL_MAX_WIDTH})':-2`);
    expect(args).toContain('-y');
    expect(args[args.length - 1]).toBe('/tmp/out.jpg');
  });
});
