/**
 * @module
 * Small HTTP wire helpers shared by the generic-API route files.
 *
 * Kept tiny on purpose — anything that's not a one-liner belongs in a
 * route file (where the call site is visible) or in the router layer
 * (where it's transport-wide). These two cover the only patterns
 * status / receive / read / observe routes share: emit a JSON body
 * with a status, and pull a JSON request body or fail with
 * `BadRequest`.
 */

import { BadRequest } from "../router/errors.ts";

/** `JSON.stringify(data)` Response with `application/json` content-type. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `await req.json()` or throw `BadRequest("Invalid JSON body")`. Use
 * inside route `decode`s so the dispatcher renders the 400 plain-text
 * response uniformly.
 */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("Invalid JSON body");
  }
}
