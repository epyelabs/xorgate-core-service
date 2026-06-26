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
lib/stacks/             # storage, database, auth (Cognito), iot, recorder (ECS/ECR), api
src/
  handlers/             # one Lambda per file (devices, device-provisioning, device-registrations, install-script, telemetry-*, device-recordings, media-finalize, …)
  services/             # shared logic (iot-provisioning: thing + cert + KVS; recordings: ECS RunTask/StopTask + DB)
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

## Stream recording (cloud viewer-recorder)

KVS WebRTC here is **signaling only**: live media flows peer-to-peer between the
device (master) and the browser, and KVS does not store it. Enabling KVS's native
ingestion would replace that P2P path, so recording instead uses a **cloud
viewer-recorder**: a headless KVS viewer (a Fargate task, built from
[`device/xorgate-kvs-webrtc`](../../device/xorgate-kvs-webrtc)) joins the device's
existing signaling channel as *one more viewer*, remuxes the incoming H.264 to a
single MP4, and uploads it to S3 on stop. The device and the browser's live view
are untouched.

**Lifecycle** (one row per run in the `recordings` table):

1. **Start**: `POST /devices/{id}/recordings` (or auto-record, below) →
   `services/recordings.ts` inserts the row (`status='recording'`), resolves the
   device's KVS channel from `kvs_channels`, and **ECS `RunTask`** launches the
   recorder with the channel + S3 key passed as container env. The task ARN is
   saved for stop.
2. **Stop**: `POST /devices/{id}/recordings/{rid}/stop` → **ECS `StopTask`**. ECS
   sends SIGTERM; the recorder sends EOS so the MP4's `moov` atom is written
   (seekable/playable), then uploads to
   `media/v1/<deviceId>/<streamKey>/<recordingId>.mp4`.
3. **Finalize**: the upload fires an S3 *Object Created* event → **EventBridge**
   rule → `media-finalize` Lambda flips the row to `completed` with the final size.
   The API never marks `completed` itself (avoids racing the upload).
4. **Playback / delete**: `GET …/{rid}/playback` returns a presigned S3 GET URL;
   `DELETE …/{rid}` stops an active task, deletes the S3 object, and removes the row.

**Manual vs auto.** Manual recording is per-stream (or `{"all": true}` to record
every channel). Auto-record is the opt-in `devices.auto_record` flag (default
off), reconciled inside `telemetry-ingest`: while on, it keeps a recorder running
for each live stream and stops it once the stream has been gone past a grace
window (so a brief stream restart does not fragment the recording). Both paths
share `services/recordings.ts`.

**Infra** (`lib/stacks/recorder-stack.ts`): an ECR repo (`xorgate-recorder[-dev]`),
an ECS cluster, an **ARM64** Fargate task def (120s stop timeout so the MP4 can
finalize + upload before SIGKILL), and a dedicated **public-subnet VPC with no NAT**
(tasks get a public IP to reach KVS/S3/TURN). The task role grants the KVS viewer
actions + `s3:PutObject` on `media/v1/*` (mirroring the device credential role in
`iot-stack.ts`). The API-stack Lambdas get `ecs:RunTask`/`StopTask` + `iam:PassRole`
on the recorder roles and the `RECORDER_*` env.

Two non-obvious choices: the API stack is passed the task **family** name (not a
revision ARN) so task-def changes never hit CloudFormation's "cannot update an
export in use" deadlock; and the recorder uses the SDK's bundled `cert.pem` for KVS
TLS (the system CA bundle fails verification in the slim image).

The recorder **image is built and pushed out-of-band** (not by `cdk deploy`); see
the deploy steps below and `device/xorgate-kvs-webrtc`.

## Routes (summary)

| Route | Auth | Notes |
|-------|------|-------|
| `POST /device-registrations` | yes | mint/reuse a code (project-scoped) |
| `GET /device-registrations/{code}` | yes | poll status (lazy-expire) |
| `POST /device-registrations/{code}/claim` | **no** | called by install.sh — creates + provisions the device |
| `GET /get/{code}` | **no** | renders install.sh (text/x-shellscript) |
| `POST /devices/{id}/provision` | yes | provision an existing device (same IoT service) |
| `GET/POST/PUT/DELETE /devices[/{id}]` | yes | device CRUD (`PUT` also sets `persistTelemetry` / `autoRecord`) |
| `GET /devices/{id}/{identity,kvs-channels,telemetry,telemetry/latest}` | yes | device detail reads |
| `GET/POST /devices/{id}/recordings` | yes | list / start (one stream or `{"all": true}`) |
| `POST /devices/{id}/recordings/{rid}/stop` | yes | stop the recording's Fargate task |
| `GET /devices/{id}/recordings/{rid}/playback` | yes | presigned S3 GET URL |
| `DELETE /devices/{id}/recordings/{rid}` | yes | stop if active, delete S3 object + row |
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
npm run deploy:prod          # cdk deploy --context stage=prod --all
npm run db:generate          # generate a Drizzle migration after editing src/db/schema.ts
```

**Recorder image** (separate from `cdk deploy`, which only references the ECR
repo). After the recorder stack exists, build + push the viewer-recorder once (and
on any change under `device/xorgate-kvs-webrtc`). The Fargate task runs **arm64**:

```sh
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
cd ../../device/xorgate-kvs-webrtc
docker build --platform linux/arm64 -t <acct>.dkr.ecr.us-east-1.amazonaws.com/xorgate-recorder-dev:latest .
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/xorgate-recorder-dev:latest
```

The recorder paths (push the image, run/stop tasks) need ECR + ECS + `iam:PassRole`
permissions the base deploy user does not have; grant them separately.

**Migrations** are generated here but **applied out-of-band via the RDS Data
API** — the local deploy credentials lack migration permissions. Status columns
are plain `text` (not `pgEnum`) on purpose: the aws-data-api driver binds enum
values as text and Postgres rejects the implicit cast (see the comments in
`db/schema.ts`).

Dev imports the shared sandbox Aurora cluster + has no VPC; prod builds its own
VPC + cluster. Stage is required: `--context stage=dev|prod`.
