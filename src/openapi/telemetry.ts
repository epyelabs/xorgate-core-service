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
};
