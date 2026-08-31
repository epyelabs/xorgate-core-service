import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Uploaded pictures: profile pictures under `avatars/` and organization and
 * workspace logos under `logos/` in the core bucket. One module rather than
 * one per feature, because all three share the same gate — the validation
 * below is what stops a payload from being stored, and it should exist once.
 *
 * The bucket is private and stays private (`BLOCK_ALL`, `enforceSSL`), so a
 * browser never holds a credential for it: every read is a presigned GET
 * minted alongside the response that carries it, exactly as the replay
 * manifest and workflow-run artifacts already do. An image URL is therefore
 * useless once it expires, and a key cannot be guessed into public access.
 *
 * Uploads arrive as base64 in the request body rather than through a presigned
 * PUT. The bytes are tiny (the browser downscales to a 512px square first,
 * tens of kilobytes), and one round trip means the object and the row that
 * points at it are written together: no orphaned uploads and no second
 * request, and the server — not the browser — decides the key.
 */

const BUCKET = process.env.BUCKET_NAME;
const s3 = new S3Client({});

/** URL lifetime. Long enough for a working session, short enough to matter. */
const URL_TTL_SECONDS = 60 * 60;

/** Hard ceiling on decoded bytes. The client sends ~40 KB; this is the abuse stop. */
export const MAX_IMAGE_BYTES = 1_500_000;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type ImageContentType = keyof typeof EXTENSIONS;

export function isSupportedType(value: string): value is ImageContentType {
  return value in EXTENSIONS;
}

/**
 * Confirm the bytes really are the image type they claim. A declared
 * `Content-Type` is caller-supplied and gets served back on the GET, so it
 * must not be taken on faith: without this, an HTML payload labelled
 * `image/png` would be stored and later served as whatever it says it is.
 */
export function sniffType(bytes: Uint8Array): ImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export type DecodedUpload =
  | { ok: true; contentType: ImageContentType; bytes: Buffer }
  | { ok: false; message: string };

/**
 * The whole gate an uploaded picture passes before anything is stored, in one
 * place: the declared type must be one we serve, the base64 must decode to
 * something, the bytes must fit, and — the part that matters — the bytes
 * themselves must BE the type they claim.
 */
export function decodeImageUpload(input: {
  contentType: string;
  data: string;
}): DecodedUpload {
  const kind = 'a JPEG, PNG or WebP image';
  if (!isSupportedType(input.contentType)) {
    return { ok: false, message: `Picture must be ${kind}` };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.data, 'base64');
  } catch {
    return { ok: false, message: 'data must be base64' };
  }
  if (bytes.length === 0) return { ok: false, message: 'data must be base64' };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      message: `Picture is too large (${Math.round(
        bytes.length / 1024,
      )} KB); the limit is ${Math.round(MAX_IMAGE_BYTES / 1024)} KB`,
    };
  }
  const sniffed = sniffType(bytes);
  if (sniffed === null || sniffed !== input.contentType) {
    return { ok: false, message: `The uploaded bytes are not ${kind}` };
  }
  return { ok: true, contentType: sniffed, bytes };
}

function requireBucket(): string {
  if (!BUCKET) throw new Error('images: BUCKET_NAME is not configured');
  return BUCKET;
}

/**
 * The key for one stored picture. A fresh uuid per upload rather than a stable
 * key, so a replaced picture cannot be served stale from a cache still holding
 * the previous presigned URL.
 *
 * The prefix is chosen by the three helpers below rather than by the caller —
 * a handler cannot reach into another feature's objects by getting the key
 * wrong.
 */
function keyFor(prefix: string, ownerId: string, contentType: ImageContentType): string {
  return `${prefix}/${ownerId}/${randomUUID()}.${EXTENSIONS[contentType]}`;
}

/** Write a picture at `key` and return the key the row should point at. */
async function put(
  key: string,
  contentType: ImageContentType,
  bytes: Uint8Array,
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: requireBucket(),
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: 'private, max-age=3600',
    }),
  );
  return key;
}

/** Profile picture for one user. */
export function putAvatar(
  userId: string,
  contentType: ImageContentType,
  bytes: Uint8Array,
): Promise<string> {
  return put(keyFor('avatars', userId, contentType), contentType, bytes);
}

/** Logo for one organization. */
export function putOrganizationLogo(
  organizationId: string,
  contentType: ImageContentType,
  bytes: Uint8Array,
): Promise<string> {
  return put(keyFor('logos/organizations', organizationId, contentType), contentType, bytes);
}

/** Logo for one workspace. */
export function putWorkspaceLogo(
  workspaceId: string,
  contentType: ImageContentType,
  bytes: Uint8Array,
): Promise<string> {
  return put(keyFor('logos/workspaces', workspaceId, contentType), contentType, bytes);
}

/**
 * Best-effort: the row no longer points here, so a surviving object is
 * unreachable garbage rather than a correctness problem. Never fail the
 * request the user actually asked for over it.
 */
export async function deleteImage(key: string): Promise<void> {
  await s3
    .send(new DeleteObjectCommand({ Bucket: requireBucket(), Key: key }))
    .catch(() => {});
}

/** A presigned GET for a stored picture, or null when there is not one. */
export function imageUrl(key: string | null): Promise<string | null> {
  if (!key) return Promise.resolve(null);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: requireBucket(), Key: key }), {
    expiresIn: URL_TTL_SECONDS,
  });
}
