/**
 * @module
 * Shared base64 helpers used by codecs that need to represent `Uint8Array`
 * payloads as a JSON-safe tagged string (`{ "$bytes": "<base64>" }`).
 *
 * Uses the Latin-1 idiom (charCode per byte) to stay Deno-native without
 * pulling in a Node/npm dependency:
 *   - encode: `String.fromCharCode(byte)` per byte, then `btoa`.
 *   - decode: `atob`, then `charCodeAt(i)` per character.
 *
 * Extracted from `src/codecs/http/ndjson.ts` in Task 10 (second consumer).
 */

/**
 * Encode a `Uint8Array` to a base64 string.
 * Uses the Latin-1 idiom: one byte → one char code, then `btoa`.
 */
export function base64FromBytes(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

/**
 * Decode a base64 string back to a `Uint8Array`.
 * Uses `atob` then reads `charCodeAt` per character.
 */
export function bytesFromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
