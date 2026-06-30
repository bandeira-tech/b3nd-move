/**
 * @module
 * WS batch codecs catalog. Operators import from here:
 *
 * ```ts
 * import { wsJsonEnvelope, wsJsonEnvelopeBase64 } from "@bandeira-tech/b3nd-move/codecs/ws";
 * wsApi(rig, { codec: wsJsonEnvelope() });
 * // or, for byte-faithful Uint8Array payloads (M1 fix):
 * wsApi(rig, { codec: wsJsonEnvelopeBase64() });
 * ```
 */

export { wsJsonEnvelope } from "./json-envelope.ts";
export type { WsJsonEnvelopeOptions } from "./json-envelope.ts";

export { wsJsonEnvelopeBase64 } from "./json-envelope-base64.ts";
export type { WsJsonEnvelopeBase64Options } from "./json-envelope-base64.ts";
