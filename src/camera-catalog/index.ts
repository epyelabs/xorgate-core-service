/**
 * The camera sensor catalog (plans/support-other-camera-models).
 *
 *   schema.ts         the rules an entry must satisfy (zod) and the types
 *   data.ts           the entries: every sensor the platform knows
 *   catalog.ts        the validated catalog, its serialization, lookups
 *   sensor-choice.ts  validation of a `{ sensor, options }` pair against it
 *                     (read its header before writing the Phase 2 namespace)
 *   message.ts        quoting untrusted input in a message
 *   camera-catalog.json  the emitted artifact (generated; never edit by hand)
 *
 * Nothing in the service reads the catalog yet. Phase 2's `cameraSensors`
 * config namespace is its first consumer.
 *
 * The artifact's compatibility rule (what a consumer must tolerate, and what
 * bumps `schemaVersion`) is beside `CAMERA_CATALOG_SCHEMA_VERSION` in
 * `schema.ts`.
 */
export * from './schema';
export * from './catalog';
export * from './sensor-choice';
export { CAMERA_CATALOG_VERSION } from './data';
