/**
 * @module
 * Shared URI extractor for `/api/v1/content/<encoded-uri>` routes.
 *
 * Both `http-get-content` and `http-post-content` pull the same URI
 * out of the same path. This helper is that one extraction, so the
 * two facets can't drift on prefix, encoding, or error shape.
 *
 * Returns either `{ uri }` for the extracted URI or a fully-formed
 * `Response` for the failure case — callers plug straight into a
 * `HttpRoute.build` return.
 */

/** Fixed route prefix shared by both content facets. */
export const CONTENT_PREFIX = "/api/v1/content/";

export type ContentUriResult = { uri: string } | Response;

/**
 * Pull the URL-encoded URI from `<CONTENT_PREFIX><encoded>`.
 *
 * - path not under the prefix             → `404`
 * - empty URI after the prefix            → `404`
 * - `decodeURIComponent` throws           → `400`
 * - otherwise                             → `{ uri: decoded }`
 *
 * Method matching is the caller's job — the same path is reached by
 * both GET (read facet) and POST (write facet).
 */
export function extractContentUri(req: Request): ContentUriResult {
  const path = new URL(req.url).pathname;
  if (
    !path.startsWith(CONTENT_PREFIX) || path.length === CONTENT_PREFIX.length
  ) {
    return new Response("Not Found", { status: 404 });
  }
  try {
    return { uri: decodeURIComponent(path.slice(CONTENT_PREFIX.length)) };
  } catch {
    return new Response("Bad Request: invalid URI encoding", { status: 400 });
  }
}
