/**
 * Ambient per-invocation request context, so error bodies can carry the
 * gateway's request id without threading the event through every helper.
 *
 * `utils/responses.ts` has ~200 call sites that build error envelopes with no
 * access to the event; passing the id explicitly would touch all of them for a
 * field that is pure telemetry. A module-level slot is safe here because a
 * Node Lambda container processes exactly one event at a time; the wrapper in
 * `utils/api-handler.ts` sets it on entry and clears it on exit (including the
 * throw path), so a stale id can never bleed into the next invocation.
 *
 * The id is `event.requestContext.requestId`, the API Gateway id that appears
 * in the access log, which is what makes a quoted id from a support ticket
 * findable. The caller-supplied `X-Request-ID` header is deliberately NOT
 * echoed here: it is a client-side correlation id (the SDK generates one per
 * request) and nothing server-side logs it.
 */

let currentRequestId: string | undefined;

export function setRequestId(id: string | undefined): void {
  currentRequestId = id;
}

export function getRequestId(): string | undefined {
  return currentRequestId;
}
