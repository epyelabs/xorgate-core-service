# xorgate-core-service

Xorgate's core backend: an **AWS Lambda + API Gateway (HTTP API v2)** service,
deployed with **AWS CDK**. Each route maps to its own Lambda (native
`APIGatewayProxyEventV2` handlers — no Hono/Express). Data lives in **Aurora
PostgreSQL**, accessed over the **RDS Data API** via **Drizzle ORM**. Auth is
**Cognito** ID tokens; devices get **AWS IoT** X.509 identities and **KVS** WebRTC
channels.

> There is **no API Gateway authorizer** — every route is open at the gateway and
> each handler enforces its own auth (`requireOrgContext`). An "unauthenticated"
> route is simply a handler that doesn't call it (used by the device claim +
> install-script routes below).

## Layout

```
bin/app.ts              # CDK app: wires the stacks (dev imports shared sandbox Aurora; prod builds its own)
lib/stacks/             # storage, database, auth (Cognito), iot, recorder (shared Fargate plane — historic name), api
src/
  handlers/             # one Lambda per file (devices, device-provisioning, device-registrations, install-script, telemetry-*, media-segment-ingest, device-sessions, …)
  services/             # shared logic (iot-provisioning: thing + cert + KVS; media-sessions/media-segments: on-device recording index)
  middleware/auth.ts    # requireAuth / requireOrgContext (Cognito + org/project scoping)
  db/                   # Drizzle schema + RDS Data API client
  assets/install-script.ts  # the install.sh template served per-request
  utils/                # responses, sql casts, registration-code (base32)
drizzle/                # generated migrations (+ manual/ seeds & partitions)
```

## Device lifecycle (registration → telemetry)

The zero-touch onboarding flow added for the
[device agent](../../device/xorgate-device-agent) and
[web app](../../frontend/xorgate-web):

1. **Mint a code** — web app calls `POST /device-registrations` (auth, project-
   scoped). Returns a short-lived (15 min) base32 code + `installUrl`. Idempotent:
   reloading reuses the project's pending code instead of minting a new one. The
   device model is auto-picked (the single seeded model today).
2. **Operator pastes** `curl -s <installUrl> -o install.sh && sudo bash install.sh`
   on the device. `installUrl` is `${API_BASE_URL}/get/<code>`.
3. **Serve the script** — `GET /get/{code}` (unauth) renders
   `assets/install-script.ts` with the code, API base, and dist bucket URL/version
   baked in. Invalid/used/expired codes return a *runnable* bash that exits with a
   clear message.
4. **Claim** — `install.sh` calls `POST /device-registrations/{code}/claim`
   (unauth; the code is the bearer secret). The handler: race-safe flips the code
   `pending→claimed`, creates the `devices` row (serial from the device's
   machine-id, unique per project → `409` on a re-register), then provisions IoT
   via `services/iot-provisioning.ts` (thing + X.509 cert + KVS channels), and
   links the device back. Rolls back (deletes the device + IoT thing, reverts the
   code) on failure. Returns the one-shot cert bundle + `dataEndpoint`.
5. **Poll** — web app polls `GET /device-registrations/{code}` until `claimed`
   (lazy-expires stale codes on read; no sweeper).
6. The device installs the agent under systemd and streams telemetry to
   `xorgate/devices/<deviceId>/telemetry` → IoT rule → `telemetry-ingest` Lambda.

`thingName == device.id == agent DEVICE_ID == MQTT clientId == topic segment` —
the IoT policy (`lib/stacks/iot-stack.ts`) scopes everything to
`${iot:Connection.Thing.ThingName}`, so don't break that chain.

The same `iot-provisioning.ts` service backs the older
`POST /devices/{id}/provision` (provision an already-created device), so both
paths share one code path.

### Dist bucket

Agent build tarballs (`xorgate-agent-<version>.tar.gz`) live in a **public-read**
S3 bucket (`DeviceDistBucket` in `lib/stacks/storage-stack.ts`) — devices download
them during `install.sh` with no AWS creds (the registration code, not S3 auth,
gates access). Published by the device repo's
`.github/workflows/device-deploy-{dev,prod}.yml`. The install Lambda bakes the
bucket URL into the script via `DEVICE_DIST_BUCKET_URL` / `DEVICE_DIST_VERSION`.

## Stream recording (on-device)

KVS WebRTC here is **signaling only**: live media flows peer-to-peer between the
device (master) and the browser, and KVS does not store it. **Recording happens on
the device**, not in the cloud: the agent writes ~60 s MP4 segments locally and
uploads them to `s3://…/media-sessions/v1/…` when it has connectivity, so a drive
through a dead zone still records. The backend only **ingests and indexes** what
the device uploads.

1. **Ingest**: the upload fires an S3 *Object Created* event → **EventBridge** rule
   → `media-segment-ingest` inserts the `media_segments` row (idempotent under
   redelivery) and opens/extends the owning `media_sessions` row.
2. **Close**: a session with no new segments for `MEDIA_SESSION_CLOSE_AFTER_MS` is
   closed — by the `offline-sweeper` schedule, or lazily on read in
   `device-sessions.ts`.
3. **Read**: `GET /devices/{id}/sessions[…]` lists sessions/segments and mints
   presigned playback URLs; `GET /devices/{id}/replay-manifest`
   (`services/replay-manifest.ts`) builds the ordered, gap-aware timeline the
   replay player and the workflow engine both consume.
4. **Trigger**: `segment_uploaded` fires per chunk from `media-segment-ingest`;
   `session_completed` fires once per session on close.

> **Removed 2026-07-28:** a **cloud viewer-recorder** used to exist alongside this —
> a headless KVS viewer on Fargate that joined a device channel as one more viewer,
> remuxed to a single MP4 in `media/v1/*`, and was driven by `POST
> /devices/{id}/recordings` + an auto-record flag. It is gone: handlers, the
> `recordings` table, the `media/v1/*` objects, the ECR repo, and the ECS task
> definition. ⚠️ `lib/stacks/recorder-stack.ts` and the `RECORDER_*` env vars keep
> their historic names but are now the **shared Fargate plane** (VPC, SG, cluster)
> that the workflow engine-runner uses — do not "clean up" those names; renaming the
> cluster would replace it.

## Workflows

User-defined processing pipelines that attach to a device, fire on a trigger, and
produce reviewable runs + events. A **template** is an org-scoped graph of nodes
(catalog type in `node.type`, knobs in `node.data.config`); an **attachment** binds
a *published* template to one device with one or more triggers; a **run** is a
single execution with a step trace and emitted events. Simulations run a draft
from the editor over uploaded or recorded inputs through the same path.

**One engine, consumed as a package.** The graph executor, the 28-node catalog,
the definition/manifest/result schemas and the host seams are
[`@xorgate/workflow-engine`](https://www.npmjs.com/package/@xorgate/workflow-engine)
(pinned exactly in `package.json`, `0.5.1` today). This service is the engine's
**platform shell**: it owns the REST API, the run rows, dispatch, the S3 artifact
tree, the IoT progress plane and the AWS-backed host the engine runs on.
Nothing engine-internal lives in this repo any more.

| File | Role |
|---|---|
| `src/workflows/catalog.ts` | `platformCatalog` (the package's core catalog) and the served payload; `EXPECTED_CATALOG_VERSION` is the hash the smoke asserts |
| `src/workflows/host/cloud-host.ts` | the `EngineHost` both targets hand to `createEngine`: S3 sources/artifacts, Secrets Manager secrets (org key over platform key), IoT progress, the live webcam-ingest seam; plus the pre-flight refusal. The Fargate flavour also tees visualization frames to `workDir/<runId>/frames/` and muxes them into `video/<nodeId>.mp4` (ffmpeg) before `result.json` |
| `src/workflows/host/aws.ts` | the AWS SDK calls behind the host (manifest load, artifact writes with `result.json` last, frame sink, MP4 upload, IoT publish transport, secret reader) |
| `src/workflows/host/result.ts` | `platformResultSchema`: the package's `result.json` contract plus the additive `artifacts.videos` map (`{ key, frames, fps }` per visualization node); finalize parses with it so the videos reach the run row |
| `src/workflows/host/live-ingest.ts`, `session.ts`, `finalize.ts` | MQTT webcam ingest, the warm-session loop, the `result.json` to row mapping |
| `src/workflows/simulations.ts`, `production.ts` | manifest building for simulations and triggered runs; `engineTargetForDefinition` routes |
| `src/handlers/workflow-engine.ts` | **Lambda target**: telemetry-only graphs (512 MB, 5 min) |
| `engine-runner/main.ts` + `Dockerfile` | **Fargate target**: media graphs and code function nodes (ffmpeg, ONNX Runtime, python3), single-run and warm-session modes |

**Two targets, one call.** `engineTargetForDefinition` sends a graph to Fargate
when any node is media-bound (`runtime.target: media`) or is a code function
node (group `function`); everything else runs on Lambda. Both targets load the
manifest from S3, run the pre-flight refusal (unknown types everywhere; media
and function nodes on Lambda), then
`createEngine({ host: cloudHost(...), catalog: platformCatalog }).run({ manifest })`.
The engine emits the `running` and terminal status messages itself and writes
the artifact tree through the host with `result.json` last, which is what the
S3 `ObjectCreated` EventBridge rule and `workflow-run-finalize.ts` key on.

**Run artifacts** under `workflows/v2/runs/<runId>/` (the package's layout,
`docs/compatibility.md`): `manifest.json` (dispatcher), `events.jsonl`,
`outputs/<nodeId>/records.<jsonl|json>` (Data Capture), `frames/<nodeId>/<seq>.jpg`
(visualization), `inputs/<nodeId>/records.jsonl` (materialized telemetry,
Fargate) and `result.json` last. The platform adds ONE key on Fargate runs:
`video/<nodeId>.mp4`, the annotated frames muxed at the decode fps, recorded in
`result.json` as `artifacts.videos[nodeId] = { key, frames, fps }` (additive; the
package's `engineResultSchema` still parses the file). Every key is reachable
from the browser through `GET /workflow-runs/{id}/artifact-url?key=`, which
presigns anything under the run's own prefix.

```mermaid
flowchart TD
  A[triggers: session / segment / telemetry / schedule / manual] --> F[fireWorkflowRun]
  S[POST simulations] --> M
  F --> Q[[WorkflowRunQueue]] --> DISP[workflow-dispatch.ts] --> M[manifest.json to S3<br/>dispatchV2Run]
  M -->|telemetry graph| L[workflow-engine.ts Lambda<br/>cloudHost lambda flavour]
  M -->|media or function graph| T[engine-runner Fargate ARM64<br/>cloudHost fargate flavour]
  L --> E[@xorgate/workflow-engine createEngine]
  T --> E
  E -->|events, records, frames, result.json last| S3[(core bucket workflows/v2/runs/)]
  E -->|status, steps, events, records, preview| IOT[IoT wf/sim and wf/run topics]
  S3 --> FIN[workflow-run-finalize.ts] --> DB[(workflow_runs / _steps / _events)]
```

**Packaging.** The package locates its own `package.json` and `dist/runtime/`
(the function-node runners) at run time, so it is never bundled: `api-stack.ts`
lists it in `externalModules` and `nodeModules` of both bundling presets and
installs it into every Lambda asset with `npm_config_omit=optional` (no ONNX
Runtime in a Lambda). The Fargate image installs it through the ordinary
`npm ci`, keeps the optional dependencies, and adds `python3`; build and push it
from the service root, out of band:

```bash
docker build --platform linux/arm64 -f engine-runner/Dockerfile -t engine-runner .
# tag + push to ECR xorgate-engine-runner[-dev]:latest (recorder-stack.ts holds the repo + task def)
```

**Bumping the engine.** `npm install --save-exact @xorgate/workflow-engine@<version>`,
read its `CHANGELOG.md`, then `npm run typecheck && npm test && npm run smoke`.
The smoke asserts the served catalog hash equals `EXPECTED_CATALOG_VERSION` in
`src/workflows/catalog.ts`: if the release moved the core hash (a new core node
or an additive def change, named in the changelog), update that constant in the
same commit. Deploy dev, rebuild and push the dev image, run a simulation on each
target, then prod. The catalog the editor fetches (`GET /workflow-catalog`, ETag
= the hash) is the same instance both targets execute, so an engine bump is the
only way a node appears or changes.

**Tags.** `workflow_templates.tags` (`text[]`, GIN index, manual migration `021`)
is how a PROGRAM finds a template it did not author. `src/utils/tags.ts` is the
one source of the rules, applied to writes and to the filter alike: trimmed,
lowercased, deduped, 1 to 32 characters matching `^[a-z0-9][a-z0-9._-]*$`, at
most 20 per template, and anything else is a 400 rather than a silent drop.
`POST`/`PUT /workflow-templates[/{id}]` take `tags` and REPLACE the whole set
(`[]` clears it, absent leaves it alone). `GET /workflow-templates?tag=` filters
ANY-of (`tags && ARRAY[...]`); repeating the parameter and comma-separating its
values are the same request, because API Gateway comma-joins duplicates and a
comma cannot occur inside a tag. `GET /workflow-templates/tags` returns the
org's distinct tags with counts for a picker.

Those three reads are the ONLY part of this surface in the public OpenAPI
document (`src/openapi/scope.ts`, `IN_SCOPE_ROUTES`): `@xorgate/sdk` models them
as `xg.workflowTemplates`, and a consumer holding an organization API key is
expected to discover templates by tag. Authoring stays out and stays editor-side.

**Schema** (migrations `0009` onward, `db/schema.ts`): `workflow_templates`
(incl. `tags`), `workflow_template_versions` (app-enforced one-draft + one-published invariant),
`workflow_attachments`, `workflow_trigger_state` (debounce/cooldown + schedule
cursor), `workflow_runs` (snapshot of the definition that ran, `engine_version`,
`artifacts`), `workflow_run_steps`, `workflow_events`.

**Notes:** the run-firing and dispatching Lambdas bundle the AWS SDK
(`bundling: bundlingWithSdk`) since client-sqs / client-ecs / client-lambda are
not guaranteed in the runtime. The scheduler/watchdog rule is **off in dev by
default** (Aurora auto-pause); enable with `--context scheduledJobs=on`.

## Routes (summary)

| Route | Auth | Notes |
|-------|------|-------|
| `POST /device-registrations` | yes | mint/reuse a code (project-scoped) |
| `GET /device-registrations/{code}` | yes | poll status (lazy-expire) |
| `POST /device-registrations/{code}/claim` | **no** | called by install.sh — creates + provisions the device |
| `GET /get/{code}` | **no** | renders install.sh (text/x-shellscript) |
| `POST /devices/{id}/provision` | yes | provision an existing device (same IoT service) |
| `GET/POST/PUT/DELETE /devices[/{id}]` | yes | device CRUD (`PUT` also sets `recordingConfig` / `lteRecoveryConfig`) |
| `GET /devices/{id}/{identity,kvs-channels,telemetry,telemetry/latest}` | yes | device detail reads |
| `GET /devices/{id}/sessions[/{sessionId}[/segments…]]` | yes | on-device recordings: list / detail / segments / segment playback URL |
| `GET /devices/{id}/replay-manifest` | yes | ordered segment timeline for the replay player |
| `…/me, /organizations, /projects, /device-models, /api-keys, /iot/attach-policy, /docs` | mixed | platform + tenancy |

`API_BASE_URL` (used to build `installUrl` and the claim URL inside the script) is
injected post-hoc onto the registration Lambdas from `this.api.apiEndpoint` — the
same chicken-and-egg trick as `DOCS_BASE_URL`. No custom DNS yet; it's the
generated `execute-api` endpoint.

## Develop / deploy

```sh
npm run typecheck            # tsc (cdk + lambda projects)
npm run synth:dev            # cdk synth (bundles every Lambda via esbuild)
npm run deploy:dev           # cdk deploy --context stage=dev --all
npm run deploy:prod          # cdk deploy --context stage=prod --all (needs prod-account creds, see below)
npm run db:generate          # generate a Drizzle migration after editing src/db/schema.ts
```

**Prod is a different AWS account** (865609249890) since the 2026-08-21
org/account split; dev stays in the shared 111910761410. `bin/app.ts` pins the
account per stage, so `deploy:prod` with dev credentials fails fast rather than
deploying to the wrong place — run it with credentials that reach the prod
account, e.g. `AWS_PROFILE=xorgate-prod npm run deploy:prod`. The same applies
to anything else prod-side: migrations over the RDS Data API, model-registry
publishing to the core bucket, and `scripts/migrate-telemetry-partitions.mjs`
(its defaults are the dev sandbox cluster; point `XORGATE_DB_CLUSTER_ARN` /
`XORGATE_DB_SECRET_ARN` at the prod cluster explicitly).

The Fargate paths (push a runner image, run/stop tasks) need ECR + ECS +
`iam:PassRole` permissions the base deploy user does not have; grant them separately.

**Migrations** are generated here but **applied out-of-band via the RDS Data
API** — the local deploy credentials lack migration permissions. Status columns
are plain `text` (not `pgEnum`) on purpose: the aws-data-api driver binds enum
values as text and Postgres rejects the implicit cast (see the comments in
`db/schema.ts`).

Dev imports the shared sandbox Aurora cluster + has no VPC; prod builds its own
VPC + cluster. Stage is required: `--context stage=dev|prod`.
