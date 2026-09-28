import {
  buildCatalogPayload,
  coreCatalog,
  type Catalog,
  type NodeExecutor,
  type NodeTypeDef,
  type WorkflowCatalogPayload,
} from '@xorgate/workflow-engine';

/**
 * The ONE catalog instance the platform serves, validates against, routes on
 * and executes (wf-engine-integration design §3.1). Every consumer imports
 * from here, never from the package's `coreCatalog` directly, so registering a
 * node pack later is a one-line change in this file and the served payload,
 * publish validation, capability computation and both engine targets move
 * together. No filtered catalogs per target: a graph validates identically
 * everywhere, and a target refuses what it cannot run pre-flight.
 */
export const platformCatalog: Catalog = coreCatalog;

/**
 * The catalog hash this service was built against. `npm run smoke` asserts
 * the served payload hashes to it, so an engine bump that moves the hash is a
 * conscious edit here (design §3.9). Deployed dev/prod expose it as
 * `GET /workflow-catalog` `.catalogVersion` and as the response ETag.
 */
export const EXPECTED_CATALOG_VERSION = 'f8861576c807e382';

/** The served `GET /workflow-catalog` payload: computed once per process, ETag'd by hash. */
export const platformCatalogPayload: WorkflowCatalogPayload = buildCatalogPayload(platformCatalog);

if (platformCatalogPayload.catalogVersion !== EXPECTED_CATALOG_VERSION) {
  // Never fatal at import (every workflow Lambda loads this); the smoke
  // gate is where a drift fails the build.
  console.warn(
    `workflows/catalog: served catalogVersion ${platformCatalogPayload.catalogVersion} differs from EXPECTED_CATALOG_VERSION ${EXPECTED_CATALOG_VERSION}; update src/workflows/catalog.ts after reviewing the engine bump`,
  );
}

export function getNodeType(type: string): NodeTypeDef | undefined {
  return platformCatalog.getNodeType(type);
}

export function getExecutor(type: string): NodeExecutor | undefined {
  return platformCatalog.getExecutor(type);
}
