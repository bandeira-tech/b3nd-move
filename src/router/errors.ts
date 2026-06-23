/**
 * @module
 * Wire-adapter errors thrown by routes — caught by the transport's
 * dispatcher and rendered on the wire.
 *
 * These represent things that never reach the rig: malformed wire
 * input, bad URI encoding, validation failure, missing resources at
 * the route layer. They are not domain errors — by the time the rig
 * sees a call, these have been weeded out. The HTTP dispatcher
 * renders them as `Response(message, { status })` — plain text body,
 * status code carries the category, no envelope.
 *
 * The vocabulary is HTTP-status-shaped because that's the cheapest
 * universal taxonomy. Other transports (gRPC, WS) catching these
 * later can map the status to their own error code space.
 */

/** Base for every wire-adapter error. Subclasses fix the status. */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — wire input malformed (bad JSON, schema mismatch, bad encoding). */
export class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/** 401 — request authenticity could not be verified (bad/missing signature). */
export class Unauthorized extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

/** 404 — the addressed resource doesn't exist. */
export class NotFound extends HttpError {
  constructor(message = "Not Found") {
    super(404, message);
  }
}

/**
 * 500 — wire-adapter failure that wasn't the caller's fault (hook
 * threw, encoder produced unrecognisable shape, …). Anything thrown
 * that isn't an `HttpError` becomes one of these at the dispatcher.
 */
export class InternalError extends HttpError {
  constructor(message: string) {
    super(500, message);
  }
}
