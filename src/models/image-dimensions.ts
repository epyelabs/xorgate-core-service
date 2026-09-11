/**
 * Image dimensions from the first bytes of a file, without a decoder: the
 * JPEG SOF marker walk and the PNG IHDR chunk. The register path reads the
 * object head once (a ranged GET of the first 64 KiB is plenty for every
 * camera JPEG: the SOF sits after the JFIF/EXIF APP segments, which stay
 * under a few KiB unless a thumbnail is embedded, so `read` says how much a
 * caller should fetch before giving up). Pure.
 */

export interface ImageDimensions {
  width: number;
  height: number;
  format: 'jpeg' | 'png';
}

/** How many leading bytes the register path fetches before parsing. */
export const DIMENSION_PROBE_BYTES = 256 * 1024;

export function sniffImageFormat(bytes: Uint8Array): 'jpeg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  return null;
}

/** Returns null when the format is unknown or the header is truncated. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const format = sniffImageFormat(bytes);
  if (format === 'png') {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Bytes 12..16 spell IHDR; width and height follow as big-endian u32.
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height, format } : null;
  }
  if (format === 'jpeg') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI or SOS before any SOF
      const length = view.getUint16(i + 2);
      if (length < 2) return null;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 9 > bytes.length) return null;
        const height = view.getUint16(i + 5);
        const width = view.getUint16(i + 7);
        return width > 0 && height > 0 ? { width, height, format } : null;
      }
      i += 2 + length;
    }
    return null;
  }
  return null;
}
