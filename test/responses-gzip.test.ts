import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { acceptsGzip, GZIP_MIN_BYTES, gzipIfAccepted, ok } from '../src/utils/responses';

// README D11 (telemetry-session-artifacts P5): the telemetry history handler
// gzips its JSON when the caller accepts it.
const big = ok({ readings: Array.from({ length: 200 }, (_, i) => ({ ts: new Date(i * 1000).toISOString(), metric: 'gps.speed', value: i, unit: 'km/h' })) });
const small = ok({ ok: true });

describe('acceptsGzip', () => {
  it.each([
    ['gzip', true],
    ['gzip, deflate, br', true],
    ['br;q=1.0, gzip;q=0.8, *;q=0.1', true],
    ['*', true],
    ['identity', false],
    ['gzip;q=0', false],
    ['deflate', false],
    ['', false],
  ])('%s -> %s', (value, want) => {
    expect(acceptsGzip({ 'accept-encoding': value })).toBe(want);
  });

  it('is header-name case-insensitive and false without headers', () => {
    expect(acceptsGzip({ 'Accept-Encoding': 'gzip' })).toBe(true);
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip({})).toBe(false);
  });
});

describe('gzipIfAccepted', () => {
  it('gzips a large 200 JSON body for a gzip-accepting caller and the bytes round-trip', () => {
    const out = gzipIfAccepted({ headers: { 'accept-encoding': 'gzip, br' } }, big) as { body: string; isBase64Encoded?: boolean; headers?: Record<string, string> };
    expect(out.isBase64Encoded).toBe(true);
    expect(out.headers?.['Content-Encoding']).toBe('gzip');
    expect(out.headers?.Vary).toBe('Accept-Encoding');
    expect(out.headers?.['Content-Type']).toBe('application/json');
    const inflated = gunzipSync(Buffer.from(out.body, 'base64')).toString('utf8');
    expect(inflated).toBe((big as { body: string }).body);
    expect(out.body.length).toBeLessThan((big as { body: string }).body.length / 5);
  });

  it('leaves the response alone when the caller does not accept gzip', () => {
    expect(gzipIfAccepted({ headers: {} }, big)).toBe(big);
    expect(gzipIfAccepted({ headers: { 'accept-encoding': 'identity' } }, big)).toBe(big);
  });

  it('leaves small bodies, non-2xx responses and already-encoded bodies alone', () => {
    expect(Buffer.byteLength((small as { body: string }).body)).toBeLessThan(GZIP_MIN_BYTES);
    expect(gzipIfAccepted({ headers: { 'accept-encoding': 'gzip' } }, small)).toBe(small);
    const err = { ...(big as object), statusCode: 500 } as typeof big;
    expect(gzipIfAccepted({ headers: { 'accept-encoding': 'gzip' } }, err)).toBe(err);
    const encoded = { ...(big as object), headers: { 'Content-Encoding': 'br' } } as typeof big;
    expect(gzipIfAccepted({ headers: { 'accept-encoding': 'gzip' } }, encoded)).toBe(encoded);
    const already = { ...(big as object), isBase64Encoded: true } as typeof big;
    expect(gzipIfAccepted({ headers: { 'accept-encoding': 'gzip' } }, already)).toBe(already);
  });
});
