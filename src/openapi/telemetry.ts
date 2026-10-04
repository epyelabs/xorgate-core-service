const deviceIdParams = [
  { $ref: '#/components/parameters/IdPath' },
  { $ref: '#/components/parameters/OrganizationIdHeader' },
];

const metricQuery = {
  name: 'metric',
  in: 'query',
  required: false,
  schema: { type: 'string', example: 'imu.accel_x,imu.euler_yaw,gps.lat' },
  description:
    'Comma-separated metric filter, at most 20 names. Each must look like `group.field`; anything ' +
    'else is a 400.',
};

export const telemetryPaths = {
  '/devices/{id}/telemetry': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getDeviceTelemetry',
      summary: 'Query historical telemetry over a time range',
      description:
        'Stored readings for the device over `[from, to)`, ordered by `ts` then `metric`. Both ' +
        'bounds are REQUIRED and the range may not exceed 31 days.\n\n' +
        'With `interval` (seconds) the result is downsampled server-side: readings are grouped ' +
        'into `interval`-wide buckets per metric and averaged, up to 10,000 buckets. Without it, ' +
        'raw rows are returned up to 5,000. Either way `truncated: true` means the cap was hit and ' +
        'the result is incomplete, so narrow the range or pass a coarser `interval`. This endpoint ' +
        'does not paginate; `truncated` is the only signal that data was left behind.',
      tags: ['Telemetry'],
      parameters: [
        {
          name: 'from',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'date-time' },
          description: 'Range start (inclusive), ISO-8601.',
        },
        {
          name: 'to',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'date-time' },
          description: 'Range end (exclusive), ISO-8601.',
        },
        metricQuery,
        {
          name: 'interval',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 86400 },
          description:
            'Downsample bucket width in seconds. An interval that would produce more than 5,000 ' +
            'buckets for the requested range is a 400.',
        },
      ],
      responses: {
        '200': {
          description: 'Telemetry readings (raw or bucket-averaged), ordered by ts then metric.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['readings', 'bucketSeconds', 'truncated'],
                properties: {
                  readings: { type: 'array', items: { $ref: '#/components/schemas/TelemetryReading' } },
                  bucketSeconds: {
                    type: 'integer',
                    nullable: true,
                    description: 'Echo of `interval`; null when raw rows were returned.',
                  },
                  truncated: {
                    type: 'boolean',
                    description: 'True when the row cap was hit and the result is incomplete.',
                  },
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
  '/devices/{id}/telemetry/latest': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getDeviceTelemetryLatest',
      summary: "The device's most recent reading per metric",
      description:
        'One row per metric, last-writer-wins, ordered by metric. This is the cheap "what is the ' +
        'device doing right now" read and the authoritative source of a metric\'s unit. Empty when ' +
        'the device has never reported telemetry. It reflects the last reading INGESTED, so on an ' +
        'offline device it keeps returning stale values rather than nothing; check the timestamps.',
      tags: ['Telemetry'],
      responses: {
        '200': {
          description: 'Latest reading per metric.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['latest'],
                properties: {
                  latest: { type: 'array', items: { $ref: '#/components/schemas/DeviceLatest' } },
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
  '/devices/{id}/telemetry/recent': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getDeviceTelemetryRecent',
      summary: 'The newest N readings, with no time window',
      description:
        'The newest `limit` rows for the device, returned in chronological order. Unlike ' +
        '`/telemetry` it takes no time window, so it never comes back empty just because the ' +
        'device last reported weeks ago. That makes it the right call for seeding a chart on page ' +
        'load, with the live MQTT feed appending after it. The response shape is the same as ' +
        '`/telemetry`: `bucketSeconds` is always null (nothing is averaged), and `truncated` means ' +
        'the row limit was reached.',
      tags: ['Telemetry'],
      parameters: [
        metricQuery,
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
          description:
            'Rows (not samples) to return. Out-of-range values are a 400 here, not clamped.',
        },
      ],
      responses: {
        '200': {
          description: 'The newest readings, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['readings', 'bucketSeconds', 'truncated'],
                properties: {
                  readings: { type: 'array', items: { $ref: '#/components/schemas/TelemetryReading' } },
                  bucketSeconds: { type: 'integer', nullable: true, description: 'Always null.' },
                  truncated: { type: 'boolean', description: 'True when `limit` rows were returned.' },
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
  '/devices/{id}/telemetry/readings': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getDeviceTelemetryReadings',
      summary: 'One page of the telemetry history table',
      description:
        'Raw (un-averaged) stored samples for one page, paginated over DISTINCT timestamps so a ' +
        'page boundary never splits a sample. Defaults to the latest samples (`order=desc`) with ' +
        'no time window. `limit`/`offset` count timestamps (samples), not rows, and unlike the ' +
        'other list endpoints an out-of-range `limit` is a 400 rather than being clamped.\n\n' +
        '**Two response shapes, selected by `shape`.** `shape=table` (the DEFAULT) returns the ' +
        'table being displayed: an ordered `columns` list with stable units, and one `rows` entry ' +
        'per timestamp whose `v` array is positional against `columns`. `shape=flat` returns the ' +
        'original `readings: [{ts, metric, value, unit}]` rows, the same raw-rows contract as ' +
        '`/telemetry` and `/telemetry/recent`. The table shape is roughly 10x smaller on the wire ' +
        '(this API does not compress) and its column set does not vary with the page contents.\n\n' +
        '`page.total` is the distinct-timestamp count, **bounded at 10,000**: when more samples ' +
        'match, `page.totalIsCapped` is `true` and only the first 10,000 in the requested `order` ' +
        'are addressable (newest first by default). `page.coveredFrom`/`coveredTo` give the ISO ' +
        'span of that addressable slice. Narrow `from`/`to` to reach beyond it; an `offset` past ' +
        'the cap returns an empty page, not an error.',
      tags: ['Telemetry'],
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          description: 'Timestamps (samples) per page.',
        },
        {
          name: 'offset',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 0, default: 0 },
          description: 'Timestamps to skip (page offset).',
        },
        {
          name: 'order',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          description: 'Sort direction by ts.',
        },
        { $ref: '#/components/parameters/FromQuery' },
        { $ref: '#/components/parameters/ToQuery' },
        {
          ...metricQuery,
          description:
            'Comma-separated metric filter, at most 20 names, each `group.field`. Under ' +
            '`shape=table` this also fixes the column set (the columns and the filter are one ' +
            "value). Omit it and the columns are derived from the device model's capabilities.",
        },
        {
          name: 'shape',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['table', 'flat'], default: 'table' },
          description:
            'Response shape. `table` (default) returns `columns` + positional `rows`; `flat` ' +
            'returns the raw `readings` rows.',
        },
      ],
      responses: {
        '200': {
          description:
            'One page of the history table (`shape=table`), or of raw readings ordered by ts then ' +
            'metric (`shape=flat`).',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    title: 'Table shape (default)',
                    type: 'object',
                    required: ['columns', 'rows', 'columnSource', 'page'],
                    properties: {
                      columns: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/TelemetryTableColumn' },
                      },
                      rows: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/TelemetryTableRow' },
                      },
                      columnSource: {
                        type: 'string',
                        enum: ['request', 'model', 'data'],
                        description:
                          'Where the column set came from. `request` is your `metric` filter. ' +
                          "`model` is the device model's io_capabilities. `data` means the model " +
                          "declares nothing usable, so columns were discovered from this page's " +
                          'rows and may vary between pages. `data` with an empty `columns` means ' +
                          'the model declares nothing AND this page has no data.',
                      },
                      page: { $ref: '#/components/schemas/PageMeta' },
                    },
                  },
                  {
                    title: 'Flat shape (shape=flat)',
                    type: 'object',
                    required: ['readings', 'page'],
                    properties: {
                      readings: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/TelemetryReading' },
                      },
                      page: { $ref: '#/components/schemas/PageMeta' },
                    },
                  },
                ],
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
  '/devices/{id}/telemetry/insights': {
    parameters: deviceIdParams,
    get: {
      operationId: 'getDeviceTelemetryWindowInsights',
      summary: 'Distance and moving time inside a window',
      description:
        'What the device drove INSIDE `[from, to)`, integrated over the overview artifacts of the ' +
        'telemetry sessions overlapping the window with the same rules as each session\'s own ' +
        '`insights.distance` (accepted fixes, the 60 m/s jump reject, the 30 s gap break, the ' +
        '`gps.speed` stationary rule). Use it to roll up a media run, a day or a month: the ' +
        'per-session `insights` on the sessions listing describe WHOLE sessions, and telemetry ' +
        'sessions do not line up with video sessions (the recorder starts at boot, the camera after ' +
        'its GPS gate), so summing whole sessions that merely overlap a run over-counts. The grid is ' +
        'bucketed, so the number is within about a percent of the raw-sample insight ' +
        '(`method: "overview-haversine"`). A session whose overview is not built yet (open, or ' +
        'closed within the last minute) is listed with `source: "unbuilt"` and no numbers, and ' +
        '`partial` is true. One object read per overlapping built session; the window may span ' +
        'at most 31 days.',
      tags: ['Telemetry'],
      parameters: [
        { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
      ],
      responses: {
        '200': {
          description: 'The windowed roll-up.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/TelemetryWindowInsights' } },
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
  '/devices/{id}/telemetry/insights/batch': {
    parameters: deviceIdParams,
    post: {
      operationId: 'getDeviceTelemetryWindowInsightsBatch',
      summary: 'Distance and moving time inside many windows',
      description:
        'The batch form of `GET /devices/{id}/telemetry/insights`: one windowed roll-up per entry ' +
        'of `windows`, returned in the same order and computed by exactly the same rules. Use it to ' +
        'roll up a page of media runs in one request instead of one request per run: the device\'s ' +
        'telemetry sessions are listed once for the whole batch, and each overview artifact is read ' +
        'once however many windows overlap it. At most 100 windows per request; each window is ' +
        'validated like the single read (`to` after `from`, at most 31 days), and the first invalid ' +
        'one answers `400` naming its index. POST only because the windows ride in the body; the ' +
        'route reads, it creates nothing.',
      tags: ['Telemetry'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['windows'],
              properties: {
                windows: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 100,
                  items: {
                    type: 'object',
                    required: ['from', 'to'],
                    properties: {
                      from: { type: 'string', format: 'date-time' },
                      to: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'One roll-up per window, in request order.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/TelemetryWindowInsights' } },
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
  '/devices/{id}/telemetry/sessions': {
    parameters: deviceIdParams,
    get: {
      operationId: 'listDeviceTelemetrySessions',
      summary: 'List recorded telemetry sessions with their insights',
      description:
        'The index of what the device RECORDED, one row per telemetry session, with the counters ' +
        'and the `insights` block computed when its overview was built (distance, duration, max ' +
        'speed, stops, GPS quality, ...). This is the read for a sessions table or a roll-up such ' +
        'as "kilometres this month": it never opens an artifact and never touches object storage. ' +
        'No URLs; to play a session\'s telemetry, ask the replay manifest for its window.\n\n' +
        'A telemetry session is NOT a video session: both ids are minted independently on the ' +
        'device, so relate them by time. `from`/`to` match sessions OVERLAPPING the range, exactly ' +
        'like `GET /devices/{id}/sessions`, so a recording run\'s distance is the sum over the ' +
        'telemetry sessions returned for the run\'s window. `insights` is `null` on a session whose ' +
        'overview has not been built yet (it is `open`, or closed within the last minute or so). ' +
        'Listing has the same side effect as the media list: it closes stale sessions as it goes.\n\n' +
        'Paginated: `page.total` is exact. Sorted by session start, newest first by default.',
      tags: ['Telemetry'],
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
          description: 'Sessions per page. Out of range is a 400.',
        },
        { $ref: '#/components/parameters/OffsetQuery' },
        { $ref: '#/components/parameters/OrderQuery' },
        {
          name: 'sort',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['startedAt'], default: 'startedAt' },
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['open', 'closed', 'any'] },
          description: 'Filter by lifecycle state. Omit or pass `any` for both.',
        },
        {
          name: 'from',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
          description: 'Sessions still recording at or after this instant (overlap semantics).',
        },
        {
          name: 'to',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
          description: 'Sessions that started before this instant (overlap semantics).',
        },
      ],
      responses: {
        '200': {
          description: 'One page of telemetry sessions.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sessions', 'page'],
                properties: {
                  sessions: { type: 'array', items: { $ref: '#/components/schemas/TelemetrySession' } },
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
};
