import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  conflict,
  created,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import {
  ACTIVE_STATUS,
  RecordingError,
  startRecording,
  stopRecording,
} from '../services/recordings';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME;
const PLAYBACK_TTL_SECONDS = 3600;

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * CRUD + control for cloud-side stream recordings. Routes (all -> this Lambda):
 *   GET    /devices/{id}/recordings
 *   POST   /devices/{id}/recordings                       body {streamKey} | {all:true}
 *   POST   /devices/{id}/recordings/{recordingId}/stop
 *   GET    /devices/{id}/recordings/{recordingId}/playback
 *   DELETE /devices/{id}/recordings/{recordingId}
 * Ownership: the device must belong to a workspace in the caller's org (same check
 * as devices.ts / device-kvs-channels.ts).
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey; // e.g. "POST /devices/{id}/recordings/{recordingId}/stop"
  const deviceId = event.pathParameters?.id;
  const recordingId = event.pathParameters?.recordingId;

  if (!deviceId) return notFound('Device "" not found');

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'DELETE';
    auth = await requireOrgContext(
      event,
      writeMethod ? ['owner', 'admin', 'member'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);

  // Org-ownership: the device must belong to a workspace in the caller's org.
  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, deviceId),
      inArray(schema.devices.workspaceId, orgWorkspaceIds),
    ),
    columns: { id: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

  // Resolve a recording-scoped row when the route carries {recordingId}, enforcing
  // that it belongs to this device.
  async function loadRecording() {
    return db.query.recordings.findFirst({
      where: and(
        eq(schema.recordings.id, recordingId as string),
        eq(schema.recordings.deviceId, deviceId as string),
      ),
    });
  }

  switch (routeKey) {
    case 'GET /devices/{id}/recordings': {
      const rows = await db.query.recordings.findMany({
        where: eq(schema.recordings.deviceId, deviceId),
        orderBy: [desc(schema.recordings.createdAt)],
      });
      return ok({ recordings: rows });
    }

    case 'POST /devices/{id}/recordings': {
      let body: { streamKey?: string; all?: boolean };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }

      try {
        if (body.all) {
          const channels = await db.query.kvsChannels.findMany({
            where: eq(schema.kvsChannels.deviceId, deviceId),
            columns: { streamKey: true },
          });
          if (channels.length === 0) return badRequest('Device has no media channels to record');
          const recordings = [];
          for (const ch of channels) {
            recordings.push(await startRecording(deviceId, ch.streamKey, 'manual'));
          }
          return created({ recordings });
        }
        if (!body.streamKey) return badRequest('streamKey is required (or pass {"all": true})');
        const recording = await startRecording(deviceId, body.streamKey, 'manual');
        return created({ recording });
      } catch (err) {
        if (err instanceof RecordingError) {
          return err.code === 'NO_CHANNEL' ? badRequest(err.message) : conflict(err.message);
        }
        throw err;
      }
    }

    case 'POST /devices/{id}/recordings/{recordingId}/stop': {
      const row = await loadRecording();
      if (!row) return notFound(`Recording "${recordingId}" not found`);
      await stopRecording(row.id, { endReason: 'user_stop' });
      return ok({ recording: { ...row, status: row.status } });
    }

    case 'GET /devices/{id}/recordings/{recordingId}/playback': {
      const row = await loadRecording();
      if (!row) return notFound(`Recording "${recordingId}" not found`);
      if (!row.s3Key) return conflict('Recording has no media object');
      if (!BUCKET) return conflict('Storage bucket is not configured');
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: row.s3Key }),
        { expiresIn: PLAYBACK_TTL_SECONDS },
      );
      return ok({ url, expiresIn: PLAYBACK_TTL_SECONDS });
    }

    case 'DELETE /devices/{id}/recordings/{recordingId}': {
      const row = await loadRecording();
      if (!row) return notFound(`Recording "${recordingId}" not found`);
      // Stop the recorder first if it's still running.
      if (row.status === ACTIVE_STATUS) await stopRecording(row.id);
      // Best-effort S3 cleanup (object may not exist yet / already gone).
      if (row.s3Key && BUCKET) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: row.s3Key }));
        } catch (err) {
          console.warn(`delete recording ${row.id}: S3 delete failed`, err);
        }
      }
      await db.delete(schema.recordings).where(eq(schema.recordings.id, row.id));
      return { statusCode: 204, body: '' };
    }

    default:
      return methodNotAllowed(method, 'GET, POST, DELETE');
  }
};
