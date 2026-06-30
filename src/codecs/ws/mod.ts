/**
 * @module
 * WS batch codecs catalog. Operators import from here:
 *
 * ```ts
 * import { wsJsonEnvelope } from "@bandeira-tech/b3nd-move/codecs/ws";
 * wsApi(rig, { codec: wsJsonEnvelope() });
 * ```
 *
 * `wsJsonEnvelopeBase64` will be added in Task 10.
 */

export { wsJsonEnvelope } from "./json-envelope.ts";
export type { WsJsonEnvelopeOptions } from "./json-envelope.ts";
