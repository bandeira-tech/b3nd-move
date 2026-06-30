/**
 * @module
 * HTTP batch codecs catalog. Operators import from here:
 *
 * ```ts
 * import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http";
 * httpApi(rig, { codec: httpOutputsFrame() });
 * ```
 */

export { httpOutputsFrame } from "./outputs-frame.ts";
export type { HttpOutputsFrameOptions } from "./outputs-frame.ts";
// httpNdjson added in a later task.
