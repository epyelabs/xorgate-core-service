# Initiate Backend (calipr-core-service template)

Use this prompt to scaffold a new backend service that follows the exact structure and conventions of `calipr/backend/calipr-core-service`. Fill in the placeholders below, then paste everything below the `---` into a fresh Claude Code session opened against an empty directory.

---

## FILL IN BEFORE PASTING

```
PROJECT_NAME       = xorgate-core-service
PROJECT_PASCAL     = XorgateCore
AWS_REGION         = us-east-1
DB_NAME            = xorgatedb
DB_NAME_DEV        = xorgatedb_dev
ALLOWED_ORIGINS    = http://localhost:*, https://xorgate.ai
PRIMARY_ENTITIES   = see "xorgate/backend/xorgate-core-service/initial_entities.md"
DEV_SANDBOX_CLUSTER_EXPORT = EpyeSandboxClusterArn (explore "epyelabs/epye-sandbox-stack" for reference)
DEV_SANDBOX_DB_SECRET_NAME = epye-sandbox/xorgate-db-credentials
```

---

## ROLE AND GOAL

You are scaffolding a brand-new backend service named `<PROJECT_NAME>` in the current working directory. It is modeled on the `calipr-core-service` reference architecture: an AWS-native, Lambda-per-handler, Aurora-via-Data-API, Cognito-authenticated TypeScript backend, deployed with AWS CDK.

You will produce only the **basics**: project skeleton, AWS CDK infrastructure (Storage, Database, Auth, API stacks), the database schema and client, the Cognito JWT auth middleware, response helpers, and one CRUD handler per entity in `PRIMARY_ENTITIES`. Do not add LLM/agent code, tools, prompt registries, streaming endpoints, or anything domain-specific to calipr.

Follow the conventions below to the letter. If something is unspecified, **ask** rather than improvise.

---

## DIRECTORY LAYOUT

Create exactly this layout:

```
<PROJECT_NAME>/
├── bin/
│   └── app.ts                          # CDK app entrypoint
├── lib/
│   └── stacks/
│       ├── storage-stack.ts
│       ├── database-stack.ts
│       ├── auth-stack.ts
│       └── api-stack.ts
├── src/
│   ├── handlers/                       # one file per resource family
│   │   └── <entity>.ts                 # one per entry in PRIMARY_ENTITIES
│   ├── middleware/
│   │   └── auth.ts
│   ├── db/
│   │   ├── schema.ts
│   │   └── index.ts
│   ├── types/
│   │   └── index.ts
│   └── utils/
│       └── responses.ts
├── drizzle/                            # generated migration .sql files
├── cdk.json
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── tsconfig.cdk.json
└── tsconfig.lambda.json
```

Do not introduce any other top-level directories. Do not create `services/`, `prompts/`, `services/tools/`, or `scripts/` unless explicitly asked.

---

## RUNTIME AND FRAMEWORK CONSTRAINTS

- Runtime: **Node.js 20**, **ARM64** Lambdas.
- Framework: **none**. Use the native `APIGatewayProxyHandlerV2` signature from `@types/aws-lambda`. Do not install or use Express, Fastify, Hono, Koa, or any other web framework.
- Routing: HTTP API Gateway v2 (`aws-cdk-lib/aws-apigatewayv2`). Routes for a single resource family map to **one** Lambda; that Lambda switches on `event.requestContext.http.method` internally. Do not collapse multiple unrelated resources into one Lambda, and do not build a generic router.
- SDK clients (Drizzle DB, S3, Secrets Manager, CognitoJwtVerifier) are **module-scoped**, created once at module load and reused across warm invocations. Never instantiate them per request.
- AWS SDK v3 is provided by the Lambda Node 20 runtime; mark `@aws-sdk/*` as external in the esbuild bundling config (do not bundle).

---

## TYPESCRIPT CONFIG (DUAL TSCONFIG)

Two separate compilation targets:

`tsconfig.cdk.json` (compiles `bin/` and `lib/`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "cdk.out/.tsc",
    "declaration": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "composite": true
  },
  "include": ["bin", "lib"],
  "exclude": ["node_modules", "cdk.out"]
}
```

`tsconfig.lambda.json` (compiles `src/`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist/lambda",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "composite": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "cdk.out"]
}
```

`tsconfig.json` at the root is a thin file that references both: `{ "files": [], "references": [{ "path": "./tsconfig.cdk.json" }, { "path": "./tsconfig.lambda.json" }] }`.

---

## package.json

```json
{
  "name": "<PROJECT_NAME>",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.cdk.json",
    "watch": "tsc -p tsconfig.cdk.json --watch",
    "cdk": "cdk",
    "synth": "cdk synth --context stage=dev",
    "synth:dev": "cdk synth --context stage=dev",
    "synth:prod": "cdk synth --context stage=prod",
    "deploy": "cdk deploy --context stage=dev --all --require-approval never",
    "deploy:dev": "cdk deploy --context stage=dev --all --require-approval never",
    "deploy:prod": "cdk deploy --context stage=prod --all --require-approval never",
    "diff": "cdk diff --context stage=dev --all",
    "diff:dev": "cdk diff --context stage=dev --all",
    "diff:prod": "cdk diff --context stage=prod --all",
    "destroy:dev": "cdk destroy --context stage=dev --all",
    "destroy:prod": "cdk destroy --context stage=prod --all",
    "typecheck": "tsc -p tsconfig.cdk.json --noEmit && tsc -p tsconfig.lambda.json --noEmit",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@aws-sdk/client-rds-data": "^3.800.0",
    "@aws-sdk/client-s3": "^3.800.0",
    "@aws-sdk/client-secrets-manager": "^3.800.0",
    "@aws-sdk/s3-request-presigner": "^3.800.0",
    "aws-jwt-verify": "^5.1.1",
    "drizzle-orm": "^0.43.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.149",
    "@types/node": "^24.0.0",
    "aws-cdk": "2.1114.1",
    "aws-cdk-lib": "2.245.0",
    "constructs": "^10.4.2",
    "drizzle-kit": "^0.31.10",
    "esbuild": "^0.25.0",
    "ts-node": "^10.9.2",
    "typescript": "~5.9.3"
  }
}
```

`cdk.json` should set `"app": "npx ts-node --prefer-ts-exts bin/app.ts"`.

---

## bin/app.ts (CDK ENTRYPOINT)

The entrypoint instantiates four stacks per stage. Dev imports a shared sandbox Aurora cluster (no `DatabaseStack` deployed); prod provisions its own VPC + cluster.

```typescript
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { <PROJECT_PASCAL>StorageStack } from '../lib/stacks/storage-stack';
import { <PROJECT_PASCAL>DatabaseStack } from '../lib/stacks/database-stack';
import { <PROJECT_PASCAL>AuthStack } from '../lib/stacks/auth-stack';
import { <PROJECT_PASCAL>ApiStack } from '../lib/stacks/api-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? '<AWS_REGION>',
};

const stage = app.node.tryGetContext('stage') as 'dev' | 'prod' | undefined;
if (stage !== 'dev' && stage !== 'prod') {
  throw new Error(
    "Missing stage. Pass --context stage=dev or --context stage=prod " +
    "(use 'npm run deploy:dev' or 'npm run deploy:prod').",
  );
}

if (stage === 'prod') {
  const storageStack = new <PROJECT_PASCAL>StorageStack(app, '<PROJECT_PASCAL>StorageStack', { env, stage });
  const databaseStack = new <PROJECT_PASCAL>DatabaseStack(app, '<PROJECT_PASCAL>DatabaseStack', {
    env,
    vpc: storageStack.vpc!,
  });
  const authStack = new <PROJECT_PASCAL>AuthStack(app, '<PROJECT_PASCAL>AuthStack', { env, stage });

  new <PROJECT_PASCAL>ApiStack(app, '<PROJECT_PASCAL>ApiStack', {
    env,
    stage,
    vpc: storageStack.vpc,
    bucket: storageStack.bucket,
    dbCluster: databaseStack.cluster,
    dbSecret: databaseStack.dbSecret,
    dbSecurityGroup: databaseStack.dbSecurityGroup,
    dbName: '<DB_NAME>',
    userPoolId: authStack.userPool.userPoolId,
    userPoolClientId: authStack.userPoolClient.userPoolClientId,
  });
} else {
  // Dev: no dedicated DB cluster, no VPC. Lambdas run outside any VPC and reach
  // a shared sandbox cluster via RDS Data API (HTTPS).
  const storageStack = new <PROJECT_PASCAL>StorageStack(app, '<PROJECT_PASCAL>StorageStackDev', { env, stage });
  const authStack = new <PROJECT_PASCAL>AuthStack(app, '<PROJECT_PASCAL>AuthStackDev', { env, stage });

  new <PROJECT_PASCAL>ApiStack(app, '<PROJECT_PASCAL>ApiStackDev', {
    env,
    stage,
    bucket: storageStack.bucket,
    dbClusterArn: cdk.Fn.importValue('<DEV_SANDBOX_CLUSTER_EXPORT>'),
    dbSecretName: '<DEV_SANDBOX_DB_SECRET_NAME>',
    dbName: '<DB_NAME_DEV>',
    userPoolId: authStack.userPool.userPoolId,
    userPoolClientId: authStack.userPoolClient.userPoolClientId,
  });
}

app.synth();
```

---

## CDK STACKS

### lib/stacks/storage-stack.ts

- Exports `vpc?: ec2.Vpc` (prod only) and `bucket: s3.Bucket`.
- Prod VPC: 2 AZs, **1 NAT Gateway**, three subnet tiers: `PUBLIC`, `PRIVATE_WITH_EGRESS` (Lambdas), `PRIVATE_ISOLATED` (Aurora).
- Bucket: `<PROJECT_NAME>-${ACCOUNT_ID}-${REGION}` (prod) or `<PROJECT_NAME>-dev-${ACCOUNT_ID}-${REGION}` (dev); S3-managed encryption; block all public access; enforce SSL; CORS allowing `<ALLOWED_ORIGINS>` for GET/PUT/POST. Lifecycle rules to be defined per project. RemovalPolicy: `RETAIN` (prod) or `DESTROY` with `autoDeleteObjects: true` (dev).

### lib/stacks/database-stack.ts (prod only)

- Aurora PostgreSQL **16.6** serverless v2 (`serverlessV2MinCapacity: 0.5`, `serverlessV2MaxCapacity: 8`, writer instance via `ClusterInstance.serverlessV2('writer')`).
- `enableDataApi: true` (required so Drizzle can use `drizzle-orm/aws-data-api/pg`).
- Credentials auto-generated via `rds.Credentials.fromGeneratedSecret('<project>_admin', { secretName: '<PROJECT_NAME>/db-credentials', excludeCharacters: '"@/\\' })`.
- `defaultDatabaseName: '<DB_NAME>'`, `storageEncrypted: true`, `deletionProtection: true`, `removalPolicy: RETAIN`.
- `vpcSubnets: { subnetType: PRIVATE_ISOLATED }`; its own SG that the API stack opens for ingress from the Lambda SG (do the cross-SG ingress rule in the API stack to avoid a stack dependency cycle).
- Outputs: `ClusterArn` and `DbSecretArn` as `CfnOutput`s.

### lib/stacks/auth-stack.ts

- Cognito `UserPool`: `signInAliases: { email: true }`, `selfSignUpEnabled: true`, `autoVerify: { email: true }`, email required, `passwordPolicy: { minLength: 8, requireSymbols: false, requireUppercase: false }`, `AccountRecovery.EMAIL_ONLY`. Removal: `RETAIN` (prod) or `DESTROY` (dev).
- SPA client (`generateSecret: false`, `authFlows: { userSrp: true }`, identity provider `COGNITO`).
- Outputs: `UserPoolId`, `UserPoolClientId`.

### lib/stacks/api-stack.ts

The API stack creates:

1. **A shared Lambda SG** (prod only) with `allowAllOutbound: true`; add a `CfnSecurityGroupIngress` on the DB SG that allows tcp/5432 from the Lambda SG.
2. **A shared IAM execution role** with policies for:
   - `bucket.grantReadWrite(role)`
   - RDS Data API:
     ```
     actions: [
       "rds-data:ExecuteStatement",
       "rds-data:BatchExecuteStatement",
       "rds-data:BeginTransaction",
       "rds-data:CommitTransaction",
       "rds-data:RollbackTransaction",
     ],
     resources: [clusterArn],
     ```
   - `dbSecret.grantRead(role)`
3. **Shared `commonEnv`** injected into every Lambda:
   ```
   NODE_ENV: isProd ? "production" : "development",
   DB_CLUSTER_ARN: clusterArn,
   DB_SECRET_ARN: dbSecret.secretArn,
   DB_NAME: dbName,
   BUCKET_NAME: bucket.bucketName,
   COGNITO_USER_POOL_ID: userPoolId,
   COGNITO_CLIENT_ID: userPoolClientId,
   AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
   ```
4. **Shared bundling**:
   ```
   const commonBundling: nodejs.BundlingOptions = {
     minify: true,
     sourceMap: true,
     target: "node20",
     externalModules: ["@aws-sdk/*"],
     forceDockerBundling: false,
   };
   ```
5. **One `NodejsFunction` per handler file in `src/handlers/`.** Standard CRUD Lambdas use `memorySize: 128`, `timeout: 10s`, `architecture: ARM_64`, `runtime: NODEJS_20_X`. Apply `vpcProps` (vpc + PRIVATE_WITH_EGRESS subnets + Lambda SG) only when `vpc` is set; in dev, run outside any VPC.
6. **`HttpApi`** with CORS preflight allowing `<ALLOWED_ORIGINS>` for GET/POST/PUT/PATCH/DELETE/OPTIONS, headers `["Authorization", "Content-Type", "X-Request-ID"]`, maxAge 24h.
7. **Routes** registered via `api.addRoutes({ path, methods, integration: new HttpLambdaIntegration(...) })`. For each entity in `PRIMARY_ENTITIES`, register `/<entity>` (GET, POST) and `/<entity>/{id}` (GET, PUT, DELETE), both pointed at the same Lambda.

---

## DATABASE (Drizzle + RDS Data API)

`drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
```

`src/db/index.ts`. Module-scoped client. **Do not** use a TCP `pg` driver:

```typescript
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import * as schema from "./schema";

const rdsDataClient = new RDSDataClient({});

export const db = drizzle(rdsDataClient, {
  database: process.env.DB_NAME!,
  secretArn: process.env.DB_SECRET_ARN!,
  resourceArn: process.env.DB_CLUSTER_ARN!,
  schema,
});

export type DB = typeof db;
export { schema };
```

`src/db/schema.ts` must define a `users` table with **exactly** these columns (Cognito sub as PK):

```typescript
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(), // Cognito sub
  email: text("email").notNull(),
  tier: text("tier").default("free"), // free | pro | team
  role: text("role").default("user").notNull(), // user | admin
  createdAt: timestamp("created_at").defaultNow(),
});
```

Then add one `pgTable` per entity in `PRIMARY_ENTITIES`, each scoped to a user via:

```typescript
userId: text('user_id').references(() => users.id).notNull(),
```

Use `uuid('id').primaryKey().defaultRandom()` for entity primary keys. Always include `createdAt` and `updatedAt` (`timestamp(...).defaultNow()`).

Migrations are generated with `npm run db:generate` and committed under `drizzle/`. Migrations are applied out-of-band against the target cluster (Data API SQL execution); do not write a CDK custom resource for migration runs unless asked.

---

## AUTH MIDDLEWARE

`src/types/index.ts` must define:

```typescript
export type UserTier = "free" | "pro" | "team";
export type UserRole = "user" | "admin";

export interface AuthContext {
  userId: string;
  email: string;
  tier: UserTier;
  role: UserRole;
}
```

`src/middleware/auth.ts`. Verbatim pattern:

```typescript
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema";
import type { AuthContext, UserRole, UserTier } from "../types/index";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// Module-scoped verifier — reused across warm Lambda invocations, caches JWKS keys
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID!,
});

export async function requireAuth(
  event: APIGatewayProxyEventV2,
): Promise<AuthContext> {
  const authHeader =
    event.headers["authorization"] ?? event.headers["Authorization"];

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = await verifier.verify(token);
  } catch {
    throw new AuthError("Invalid or expired token");
  }

  const sub = payload.sub;
  const email = payload.email as string;

  let user = await db.query.users.findFirst({ where: eq(users.id, sub) });

  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({ id: sub, email })
      .returning();
    user = newUser;
  }

  return {
    userId: user.id,
    email: user.email,
    tier: (user.tier ?? "free") as UserTier,
    role: user.role as UserRole,
  };
}

export function unauthorizedResponse(message = "Unauthorized"): object {
  return {
    statusCode: 401,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: { code: "UNAUTHORIZED", message } }),
  };
}
```

Auth is **not** registered as a generic framework middleware. Every protected handler calls `requireAuth(event)` itself at the top, inside a try/catch.

---

## RESPONSE HELPERS

`src/utils/responses.ts`:

```typescript
import type { APIGatewayProxyResultV2 } from "aws-lambda";

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      error: details ? { code, message, details } : { code, message },
    }),
  };
}

export function badRequest(message: string): APIGatewayProxyResultV2 {
  return errorResponse(400, "BAD_REQUEST", message);
}

export function forbidden(message = "Forbidden"): APIGatewayProxyResultV2 {
  return errorResponse(403, "FORBIDDEN", message);
}

export function notFound(message: string): APIGatewayProxyResultV2 {
  return errorResponse(404, "NOT_FOUND", message);
}
```

Body envelope on errors is always `{ error: { code, message, details? } }`. Successful responses are application-shaped (e.g. `{ <entity>: ... }` or `{ <entities>: [...] }`); they do **not** wrap a top-level `data` key.

---

## CANONICAL HANDLER TEMPLATE

`src/handlers/<entity>.ts`. Replace `<entity>` and table references. This is the shape every CRUD Lambda follows:

```typescript
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth, AuthError, unauthorizedResponse } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, errorResponse } from '../utils/responses';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    auth = await requireAuth(event);
  } catch (err) {
    if (err instanceof AuthError) return unauthorizedResponse(err.message) as APIGatewayProxyResultV2;
    throw err;
  }

  switch (method) {
    case 'GET': {
      if (id) {
        const row = await db.query.<entity>.findFirst({
          where: and(eq(schema.<entity>.id, id), eq(schema.<entity>.userId, auth.userId)),
        });
        if (!row) return errorResponse(404, 'NOT_FOUND', `<Entity> "${id}" not found`);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ <entity>: row }),
        };
      }
      const rows = await db.query.<entity>.findMany({
        where: eq(schema.<entity>.userId, auth.userId),
        orderBy: [desc(schema.<entity>.updatedAt)],
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ <entities>: rows }),
      };
    }
    case 'POST': {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const newId = randomUUID();
      const now = new Date();
      await db.insert(schema.<entity>).values({
        id: newId,
        userId: auth.userId,
        // ...entity-specific fields parsed from body
        createdAt: now,
        updatedAt: now,
      });
      return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ <entity>_id: newId, createdAt: now.toISOString() }),
      };
    }
    case 'PUT': {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = { /* whitelist updatable fields from body */ };
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();
      const updated = await db
        .update(schema.<entity>)
        .set(updates)
        .where(and(eq(schema.<entity>.id, id!), eq(schema.<entity>.userId, auth.userId)))
        .returning();
      if (updated.length === 0) return errorResponse(404, 'NOT_FOUND', `<Entity> "${id}" not found`);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ <entity>: updated[0] }),
      };
    }
    case 'DELETE': {
      const deleted = await db
        .delete(schema.<entity>)
        .where(and(eq(schema.<entity>.id, id!), eq(schema.<entity>.userId, auth.userId)))
        .returning({ id: schema.<entity>.id });
      if (deleted.length === 0) return errorResponse(404, 'NOT_FOUND', `<Entity> "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return {
        statusCode: 405,
        headers: { Allow: 'GET, POST, PUT, DELETE' },
        body: JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${method} not allowed` } }),
      };
  }
};
```

Every entity-scoped query and mutation **must** include the `eq(<table>.userId, auth.userId)` predicate. Cross-user reads are a security bug, not a feature.

---

## QUESTIONS TO ASK THE HUMAN BEFORE WRITING CODE

Before generating files, confirm:

1. The fields on each entity in `PRIMARY_ENTITIES` (column names, types, required vs nullable, jsonb shapes if any).
2. Whether any entity needs a foreign key beyond `users.id` (e.g. `items.projectId -> projects.id`).
3. Whether prod should provision its own VPC + Aurora cluster (default yes) or import a shared one.
4. Whether dev should also provision an isolated cluster, or import one via `DEV_SANDBOX_CLUSTER_EXPORT` (default: import).
5. Any extra Lambdas needed beyond the per-entity CRUD (e.g. `/me`, `/health`). Default to scaffolding `/me` only if asked.
6. Whether a custom domain, certificate, or Route53 record is in scope for this scaffold (default: no).

If any answer is unclear, ask before writing code. Do not invent business rules.

---

## HARD RULES (DO NOT VIOLATE)

- **No web framework.** No Express, Fastify, Hono, Koa, oak, NestJS. Native `APIGatewayProxyHandlerV2` only.
- **No TCP Postgres driver.** No `pg`, no `postgres`, no connection pools. DB access goes through Drizzle's `aws-data-api/pg` driver and the RDS Data API exclusively.
- **No generic auth middleware abstraction.** Each handler calls `requireAuth(event)` itself at the top.
- **No single mega-router file.** One handler file per resource family; one `NodejsFunction` per handler file.
- **No fields on `users` beyond** `id, email, tier, role, createdAt`. If you need per-user data, put it on a separate table that references `users.id`.
- **No tests** unless explicitly asked. No CI config unless asked.
- **No LLM, agent, tool, prompt, or streaming code.** This is a basics-only scaffold.
- **No `data` envelope** on successful responses. Use entity-shaped keys.
- **Module-scope SDK clients.** Never construct AWS SDK clients or `CognitoJwtVerifier` inside a handler function body.
- **Mark `@aws-sdk/*` as external** in esbuild bundling. It is provided by the Lambda Node 20 runtime.

---

## EXECUTION ORDER

Once the human has answered the questions above, generate files in this order so each step typechecks against the previous:

1. `package.json`, `tsconfig.json`, `tsconfig.cdk.json`, `tsconfig.lambda.json`, `cdk.json`, `drizzle.config.ts`, `.gitignore` (include `node_modules`, `cdk.out`, `dist`, `.env*`).
2. `src/types/index.ts`.
3. `src/db/schema.ts` (users + all entities), then `src/db/index.ts`.
4. `src/middleware/auth.ts`.
5. `src/utils/responses.ts`.
6. `src/handlers/<entity>.ts`, one per entity in `PRIMARY_ENTITIES`.
7. `lib/stacks/storage-stack.ts`, `lib/stacks/database-stack.ts`, `lib/stacks/auth-stack.ts`, `lib/stacks/api-stack.ts`.
8. `bin/app.ts`.
9. Run `npm install`, then `npm run typecheck`, then `npm run synth:dev`. Fix anything that fails before reporting done.

When you finish, output a short summary of what was created and the exact commands to deploy (`npm run deploy:dev` after Cognito, sandbox cluster, and any extra secrets are in place). Do not deploy anything yourself.
