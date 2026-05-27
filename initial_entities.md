# Initial Entities

Conventions: ids are UUIDs, timestamps are `timestamptz` (UTC), `created_at` / `updated_at` on every mutable row. `payload` / `config` jsonb fields are validated by SDK-side schemas, not the DB, so workflow definitions and sensor payloads can evolve loosely. Every business-domain row is reachable to an `organization_id` (directly or via `project_id`) for tenant scoping.

### Tenancy & access

#### organizations

Tenant root.

- `id`, `name`, `slug`, `created_at`

#### users

Platform users.

- `id`, `email`, `name`, `created_at`

#### memberships

User ↔ org with role.

- `id`, `user_id` → users.id, `organization_id` → organizations.id, `role` (owner / admin / member / viewer), `created_at`

#### api_keys

SDK and edge auth.

- `id`, `organization_id` → organizations.id, `name`, `hashed_key`, `scope` (edge / cloud / client), `last_used_at`, `revoked_at`, `created_at`

#### projects

Workspace per use case (e.g. "Fleet Safety Pilot").

- `id`, `organization_id` → organizations.id, `name`, `slug`, `description`, `created_at`

### Hardware

#### device_models

Kit catalog — rugged trackers, dashcams, custom enterprise kits.

- `id`, `name`, `sku`, `sensor_capabilities` (jsonb: camera / gps / accel / env), `firmware_channel`, `created_at`

#### devices

Physical units in the field.

- `id`, `project_id` → projects.id, `device_model_id` → device_models.id, `serial`, `name`, `firmware_version`, `sim_iccid`, `status` (provisioned / online / offline / decommissioned), `last_seen_at`, `last_location` (geography point), `created_at`
