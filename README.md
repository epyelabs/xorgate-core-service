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
lib/stacks/             # storage, database, auth (Cognito), iot, api
src/
  handlers/             # one Lambda per file (devices, device-provisioning, device-registrations, install-script, telemetry-*, …)
  services/             # shared logic (iot-provisioning: thing + cert + KVS, reused by provision + claim)
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

## Routes (summary)

| Route | Auth | Notes |
|-------|------|-------|
| `POST /device-registrations` | yes | mint/reuse a code (project-scoped) |
| `GET /device-registrations/{code}` | yes | poll status (lazy-expire) |
| `POST /device-registrations/{code}/claim` | **no** | called by install.sh — creates + provisions the device |
| `GET /get/{code}` | **no** | renders install.sh (text/x-shellscript) |
| `POST /devices/{id}/provision` | yes | provision an existing device (same IoT service) |
| `GET/POST/PUT/DELETE /devices[/{id}]` | yes | device CRUD |
| `GET /devices/{id}/{identity,kvs-channels,telemetry,telemetry/latest}` | yes | device detail reads |
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

**Migrations** are generated here but **applied out-of-band via the RDS Data
API** — the local deploy credentials lack migration permissions. Status columns
are plain `text` (not `pgEnum`) on purpose: the aws-data-api driver binds enum
values as text and Postgres rejects the implicit cast (see the comments in
`db/schema.ts`).

Dev imports the shared sandbox Aurora cluster + has no VPC; prod builds its own
VPC + cluster. Stage is required: `--context stage=dev|prod`.
