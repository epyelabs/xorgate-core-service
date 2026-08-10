/**
 * Service-level endpoints that are not part of any resource: the health probe
 * and the two routes that serve this document.
 */
export const metaPaths = {
  '/health': {
    get: {
      operationId: 'health',
      summary: 'Service health',
      description:
        'Unauthenticated liveness probe. It does not touch the database, so a 200 means the ' +
        'Lambda is warm and reachable, not that the platform is fully healthy.',
      tags: ['Meta'],
      security: [],
      responses: {
        '200': {
          description: 'Service is up',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'stage'],
                properties: {
                  ok: { type: 'boolean' },
                  stage: { type: 'string', enum: ['dev', 'prod'] },
                },
              },
            },
          },
        },
        '405': { $ref: '#/components/responses/MethodNotAllowed' },
      },
    },
  },
  '/openapi.json': {
    get: {
      operationId: 'getOpenApiDocument',
      summary: 'This OpenAPI document',
      description:
        'The document you are reading, served straight from the API and cached for 5 minutes. ' +
        'The docs site generates its reference pages from a checked-in snapshot of this, so the ' +
        'two can differ until the snapshot is refreshed.',
      tags: ['Meta'],
      security: [],
      responses: {
        '200': {
          description: 'OpenAPI 3.0.3 document',
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        },
      },
    },
  },
  '/docs': {
    get: {
      operationId: 'getSwaggerUi',
      summary: 'Swagger UI for this document',
      description:
        'A minimal Swagger UI page rendering `/openapi.json`. Useful when poking at a deployment ' +
        'directly; the documentation site is the richer reference.',
      tags: ['Meta'],
      security: [],
      responses: {
        '200': {
          description: 'HTML page',
          content: { 'text/html': { schema: { type: 'string' } } },
        },
      },
    },
  },
};
