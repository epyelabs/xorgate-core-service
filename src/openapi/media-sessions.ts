const deviceIdParams = [
  { $ref: '#/components/parameters/IdPath' },
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];

const sessionParams = [
  { $ref: '#/components/parameters/IdPath' },
  { $ref: '#/components/parameters/SessionIdPath' },
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];

export const mediaSessionsPaths = {
  '/devices/{id}/sessions': {
    parameters: deviceIdParams,
    get: {
      operationId: 'listMediaSessions',
      summary: 'List device-recorded media sessions',
      description:
        'Sessions recorded on the device itself and uploaded segment by segment to S3. Paginated ' +
        'with the shared list dialect, plus `streamKey` and `group`. The time filter matches ' +
        'sessions OVERLAPPING `[from, to)`, not just those started inside it, because a session ' +
        'spans a window. Each row carries computed rollups (`segmentCount`, `totalBytes`, ' +
        '`totalDurationMs`).\n\n' +
        'Pass `group=runs` to paginate RECORDING RUNS instead of sessions: one drive with N ' +
        'cameras is N sessions, and a run is the set of sessions whose intervals are within 60 s ' +
        'of each other. Under `group=runs` the response returns `runs` instead of `sessions` (with ' +
        'members nested), `page.total` counts runs, and every filter selects which RUNS to return ' +
        'rather than which sessions to cluster. So `streamKey=cam0` returns the runs cam0 recorded ' +
        'in with all of their cameras present, and a from/to range returns overlapping runs whole ' +
        'rather than clipped.\n\n' +
        'Listing also closes stale sessions as a side effect, which is why a session can flip from ' +
        '`open` to `closed` between two reads with nothing else having happened.',
      tags: ['Media Sessions'],
      parameters: [
        {
          name: 'group',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['runs'] },
          description:
            'Group and paginate by recording run. Requires `sort=startedAt` (a run has no ' +
            'createdAt), and any other value is a 400.',
        },
        {
          name: 'streamKey',
          in: 'query',
          required: false,
          schema: { type: 'string', example: 'cam0' },
          description: 'Filter to one camera.',
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['open', 'closed'] },
          description: 'An empty value or the literal `any` means "no filter".',
        },
        { $ref: '#/components/parameters/FromQuery' },
        { $ref: '#/components/parameters/ToQuery' },
        { $ref: '#/components/parameters/LimitQuery' },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['startedAt', 'createdAt'], default: 'startedAt' },
          description: '`startedAt` is when the device recorded; `createdAt` is when the row landed.',
        },
      ],
      responses: {
        '200': {
          description:
            'Sessions with per-session rollups, newest first by default, or with `group=runs` the ' +
            'recording runs with their member sessions nested. `page.total` counts whichever noun ' +
            'was returned.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['page'],
                properties: {
                  sessions: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/MediaSession' },
                    description: 'Present unless `group=runs`.',
                  },
                  runs: {
                    type: 'array',
                    description: 'Present only with `group=runs`.',
                    items: { $ref: '#/components/schemas/RecordingRun' },
                  },
                  page: { $ref: '#/components/schemas/PageMeta' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/devices/{id}/sessions/{sessionId}': {
    parameters: sessionParams,
    delete: {
      operationId: 'deleteMediaSession',
      summary: 'Delete a device-recorded media session',
      description:
        'Deletes every segment object (video plus sidecar) from storage and removes the session ' +
        'and its segment index rows. Owner/admin only, because device-recorded sessions are not ' +
        're-creatable. A segment still uploading from the device after the delete recreates the ' +
        'session index (ingest is at-least-once); delete again once the device has drained.',
      tags: ['Media Sessions'],
      responses: {
        '204': { description: 'Session deleted.' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': {
          description: 'Storage is not configured for this stage (`CONFLICT`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },
  '/devices/{id}/sessions/{sessionId}/segments': {
    parameters: sessionParams,
    get: {
      operationId: 'listMediaSessionSegments',
      summary: "List a session's full segment index",
      description:
        'The whole ordered index in one response (`seq` ascending is chronological by ' +
        'construction). This is the replay and stitching input, so it is deliberately ' +
        'unpaginated: a session is bounded at a few hours of 60 s segments. It returns the index ' +
        'only; use the playback route or the replay manifest to get URLs you can fetch.',
      tags: ['Media Sessions'],
      responses: {
        '200': {
          description: 'Session + ordered segments.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['session', 'segments'],
                properties: {
                  session: { $ref: '#/components/schemas/MediaSession' },
                  segments: { type: 'array', items: { $ref: '#/components/schemas/MediaSegment' } },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/devices/{id}/sessions/{sessionId}/segments/{seq}/playback': {
    parameters: [
      { $ref: '#/components/parameters/IdPath' },
      { $ref: '#/components/parameters/SessionIdPath' },
      { $ref: '#/components/parameters/SegmentSeqPath' },
      { $ref: '#/components/parameters/OrganizationIdHeader' },
    ],
    get: {
      operationId: 'getMediaSegmentPlayback',
      summary: 'Get a presigned playback URL for one segment',
      description:
        'One segment at a time. For playing a span of media, the replay manifest batch-presigns ' +
        'everything in one call instead.',
      tags: ['Media Sessions'],
      responses: {
        '200': {
          description: 'Presigned S3 GET URL for the segment MP4.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url', 'expiresIn', 'segment'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  expiresIn: { type: 'integer', description: 'URL TTL in seconds.', example: 3600 },
                  segment: { $ref: '#/components/schemas/MediaSegment' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
        '409': {
          description: 'Storage is not configured for this stage (`CONFLICT`).',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    },
  },
  '/devices/{id}/replay-manifest': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getReplayManifest',
      summary: 'Get a gap-aware replay manifest with presigned segment URLs',
      description:
        'One response feeds a whole replay: per-session timelines (effective durations and gaps, ' +
        'computed server-side so every client renders the same timeline) plus a presigned GET URL ' +
        'per segment. Address it by `sessionId` (single session) OR by `from`/`to` (every session ' +
        'overlapping the range, segments clipped to it, optional `streamKey` filter), never both. ' +
        'Caps: 600 segments in total, and in range mode 10 sessions and 24 hours. Exceeding a cap ' +
        'is a 400 telling you to narrow the request. Refetch before `urlExpiresAt` (epoch ms), ' +
        'which is the real URL TTL minus a 5-minute safety margin.',
      tags: ['Media Sessions'],
      parameters: [
        {
          name: 'sessionId',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'uuid' },
          description: 'Single-session mode. Mutually exclusive with from/to.',
        },
        {
          name: 'from',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
          description: 'Range mode start (with `to`). ISO-8601, like the telemetry endpoints.',
        },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        {
          name: 'streamKey',
          in: 'query',
          required: false,
          schema: { type: 'string', example: 'cam0' },
          description: 'Range mode only: limit to one camera.',
        },
      ],
      responses: {
        '200': {
          description: 'The replay manifest. Timestamps are epoch ms.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['replay'],
                properties: { replay: { $ref: '#/components/schemas/ReplayManifest' } },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '404': { $ref: '#/components/responses/NotFound' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
};
