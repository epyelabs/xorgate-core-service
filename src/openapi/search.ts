export const searchPaths = {
  '/search': {
    parameters: [{ $ref: '#/components/parameters/OrganizationIdHeader' }],
    get: {
      operationId: 'search',
      summary: 'Cross-resource search within the active organization',
      description:
        'A jump-to-detail navigator, not a result browser. It matches devices by name or serial ' +
        '(and workflow resources, which are not part of this documented surface yet), returns at ' +
        'most 6 hits per resource type, and normalizes every hit to `{type, id, title, subtitle}` ' +
        'so one code path can render them all. A `q` shorter than 2 characters returns an empty ' +
        'list rather than an error, and `%` or `_` are matched literally.',
      tags: ['Search'],
      parameters: [
        {
          name: 'q',
          in: 'query',
          required: false,
          schema: { type: 'string', minLength: 2 },
          description: 'Search term. Substring match, case-insensitive.',
        },
      ],
      responses: {
        '200': {
          description: 'Matching resources, devices first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['results'],
                properties: {
                  results: { type: 'array', items: { $ref: '#/components/schemas/SearchResult' } },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { $ref: '#/components/responses/Forbidden' },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
};
