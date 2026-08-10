/**
 * Write the OpenAPI document to a file, without deploying anything.
 *
 *   npm run openapi:emit -- ../../frontend/xorgate-docs/openapi/xorgate.json
 *
 * `GET /openapi.json` on a deployed stage serves exactly this, so the docs site
 * can normally refresh its snapshot over HTTP. This script is the offline path:
 * it lets a spec change be reviewed, and the reference pages regenerated, before
 * the change is live.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { buildOpenApiDocument } from '../src/openapi/index';

const DEFAULT_OUT = resolve(__dirname, '..', 'openapi.json');
const DEFAULT_BASE_URL = 'https://h357muxy3k.execute-api.us-east-1.amazonaws.com';

const out = resolve(process.cwd(), process.argv[2] ?? DEFAULT_OUT);
const baseUrl = process.env.API_BASE_URL ?? DEFAULT_BASE_URL;

const document = buildOpenApiDocument(baseUrl);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);

const paths = Object.keys((document as { paths: Record<string, unknown> }).paths).length;
console.log(`Wrote ${out} (${paths} paths, servers[0] ${baseUrl})`);
