import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest } from './responses';

/**
 * Shared query-param parsing for collection ("list") endpoints, so every list
 * route speaks the same dialect: `limit` / `offset` / `order` / `sort` /
 * `status`, and returns a `page` block alongside its items. Modelled on the
 * `GET /devices/{id}/telemetry/readings` handler (the first endpoint that did
 * this), whose validation messages this mirrors.
 *
 *   const parsed = parseListParams(event, {
 *     sortable: ['createdAt', 'startedAt'],
 *     defaultSort: 'createdAt',
 *     statusValues: ['completed', 'failed'],
 *   });
 *   if ('error' in parsed) return parsed.error;
 *   const { limit, offset, order, sortBy, status } = parsed;
 *   ...
 *   return ok({ items: rows, page: pageMeta(parsed, total) });
 */

export type Order = 'asc' | 'desc';

export interface ListParams {
  limit: number;
  offset: number;
  order: Order;
  // The validated sort column (one of `opts.sortable`, or `defaultSort`). The
  // caller maps this string to an actual Drizzle column.
  sortBy: string;
  // Present only when a non-empty, non-"any" `status` was supplied (and valid).
  status?: string;
  // Validated ISO-8601 time-range bounds (normalized). The caller applies these
  // to its natural timestamp column via `tsParam` (see utils/sql.ts).
  from?: string;
  to?: string;
}

export interface ListParamsOptions {
  defaultLimit?: number;
  maxLimit?: number;
  defaultOrder?: Order;
  // Allowed values for the `sort` param. Omit to disallow client-driven sorting.
  sortable?: readonly string[];
  defaultSort?: string;
  // Allowed values for the `status` filter. Omit to accept any non-empty status.
  statusValues?: readonly string[];
}

export interface PageMeta {
  limit: number;
  offset: number;
  order: Order;
  total: number;
}

export function pageMeta(params: ListParams, total: number): PageMeta {
  return { limit: params.limit, offset: params.offset, order: params.order, total };
}

export function parseListParams(
  event: APIGatewayProxyEventV2,
  opts: ListParamsOptions = {},
): { error: APIGatewayProxyResultV2 } | ListParams {
  const {
    defaultLimit = 100,
    maxLimit = 500,
    defaultOrder = 'desc',
    sortable,
    defaultSort,
    statusValues,
  } = opts;
  const qs = event.queryStringParameters ?? {};

  let limit = defaultLimit;
  if (qs.limit !== undefined) {
    if (!/^\d+$/.test(qs.limit)) return { error: badRequest('"limit" must be a positive integer') };
    limit = Number(qs.limit);
    if (limit < 1) return { error: badRequest('"limit" must be a positive integer') };
    if (limit > maxLimit) limit = maxLimit;
  }

  let offset = 0;
  if (qs.offset !== undefined) {
    if (!/^\d+$/.test(qs.offset)) return { error: badRequest('"offset" must be a non-negative integer') };
    offset = Number(qs.offset);
  }

  let order: Order = defaultOrder;
  if (qs.order !== undefined) {
    if (qs.order !== 'asc' && qs.order !== 'desc') return { error: badRequest('"order" must be "asc" or "desc"') };
    order = qs.order;
  }

  let sortBy = defaultSort ?? (sortable ? sortable[0] : '');
  if (qs.sort !== undefined && qs.sort !== '') {
    if (!sortable || !sortable.includes(qs.sort)) {
      return {
        error: badRequest(`"sort" must be one of: ${(sortable ?? []).join(', ') || '(none)'}`),
      };
    }
    sortBy = qs.sort;
  }

  // Treat empty / "any" as "no status filter" (the frontend uses "any" for the
  // unfiltered state).
  let status: string | undefined;
  if (qs.status !== undefined && qs.status !== '' && qs.status !== 'any') {
    if (statusValues && !statusValues.includes(qs.status)) {
      return { error: badRequest(`"status" must be one of: ${statusValues.join(', ')}`) };
    }
    status = qs.status;
  }

  // Optional ISO-8601 time-range bounds; both optional and independent.
  let from: string | undefined;
  let to: string | undefined;
  if (qs.from !== undefined && qs.from !== '') {
    const ms = Date.parse(qs.from);
    if (Number.isNaN(ms)) return { error: badRequest('"from" must be a valid ISO-8601 timestamp') };
    from = new Date(ms).toISOString();
  }
  if (qs.to !== undefined && qs.to !== '') {
    const ms = Date.parse(qs.to);
    if (Number.isNaN(ms)) return { error: badRequest('"to" must be a valid ISO-8601 timestamp') };
    to = new Date(ms).toISOString();
  }
  if (from && to && Date.parse(from) >= Date.parse(to)) {
    return { error: badRequest('"from" must be earlier than "to"') };
  }

  return { limit, offset, order, sortBy, status, from, to };
}
