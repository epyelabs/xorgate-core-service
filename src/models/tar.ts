/**
 * A read-only tar parser (pure; no dependency). SageMaker packages
 * `/opt/ml/model` into `model.tar.gz`, and the finalizer has to open it to
 * read `result.json`, the manifest and the ONNX file before anything is
 * published. Nothing in the service needs to WRITE tar, so this is the
 * smaller half: ustar plus the GNU long-name extension, which is all GNU tar
 * (what SageMaker uses) emits for these paths.
 */

const BLOCK = 512;

export interface TarEntry {
  name: string;
  size: number;
  /** Offset of the entry's first data byte in the buffer. */
  offset: number;
  type: 'file' | 'directory' | 'other';
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** Octal header fields; GNU also writes base-256 for large sizes (high bit set). */
function readNumber(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset];
  if (first & 0x80) {
    let value = 0;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + buf[i];
    return value;
  }
  const text = readString(buf, offset, length).trim();
  if (text === '') return 0;
  const n = parseInt(text, 8);
  return Number.isFinite(n) ? n : 0;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Every entry of an uncompressed tar, in archive order. Throws on a truncated
 * archive; unknown type flags are reported as `other` and skipped by callers
 * rather than failing the whole finalize.
 */
export function listTarEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + BLOCK <= buf.length) {
    if (isZeroBlock(buf, offset)) break; // the two-block end marker (or padding)
    const rawName = readString(buf, offset, 100);
    const size = readNumber(buf, offset + 124, 12);
    const typeFlag = String.fromCharCode(buf[offset + 156] || 0x30);
    const prefix = readString(buf, offset + 345, 155);
    const dataOffset = offset + BLOCK;
    if (dataOffset + size > buf.length) {
      throw new Error(`tar: entry "${rawName}" claims ${size} bytes past the end of the archive`);
    }
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (typeFlag === 'L') {
      // GNU long name: the NEXT header's name comes from this entry's data.
      longName = buf.subarray(dataOffset, dataOffset + size).toString('utf8').replace(/\0+$/, '');
      offset = dataOffset + padded;
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'K') {
      // PAX extended headers: not used by these archives; skipped whole.
      offset = dataOffset + padded;
      continue;
    }
    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    entries.push({
      name: name.replace(/^\.\//, ''),
      size,
      offset: dataOffset,
      type: typeFlag === '0' || typeFlag === '\0' ? 'file' : typeFlag === '5' ? 'directory' : 'other',
    });
    offset = dataOffset + padded;
  }
  return entries;
}

/** An entry's bytes, without copying the whole archive. */
export function tarEntryBytes(buf: Buffer, entry: TarEntry): Buffer {
  return buf.subarray(entry.offset, entry.offset + entry.size);
}

/**
 * A path is safe to mirror under a prefix: relative, no `..`, no empty
 * segment, nothing absolute. A tar from our own container cannot carry one,
 * which is exactly why it is asserted rather than assumed.
 */
export function isSafeTarPath(name: string): boolean {
  if (name.length === 0 || name.startsWith('/')) return false;
  return name.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}
