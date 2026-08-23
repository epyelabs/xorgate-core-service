import { requestPath } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { buildOpenApiDocument } from '../openapi/index';
import { notFound } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

/**
 * Serves the OpenAPI document and a Swagger UI over it.
 *
 * The document itself lives in `src/openapi/`, one module per resource, so this
 * handler stays a transport shim. Editing the API surface means editing a module
 * there; `test/openapi-route-coverage.test.ts` fails if a route in the CDK route
 * table has no entry.
 */

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Xorgate Core API - Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    });
  </script>
</body>
</html>`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const restHandler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Canonical form: `/v1/openapi.json` and `/openapi.json` are the same
  // document, and the exact comparison below would miss the versioned one.
  const reqPath = requestPath(event);
  const baseUrl = process.env.DOCS_BASE_URL ?? '/';

  if (reqPath === '/openapi.json') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        ...CORS_HEADERS,
      },
      body: JSON.stringify(buildOpenApiDocument(baseUrl)),
    };
  }

  if (reqPath.startsWith('/docs')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: SWAGGER_UI_HTML,
    };
  }

  return notFound('Route not found');
};

export const handler = apiHandler(restHandler);
