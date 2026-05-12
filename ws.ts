/**
 * @module
 * WebSocket subpath — server resolver + handler.
 *
 * For finer-grained imports:
 *   @bandeira-tech/b3nd-servers/ws/api    — `wsApi(rig)` handler (Deno today)
 *   @bandeira-tech/b3nd-servers/ws/server — `wsServer` resolver (Deno only)
 *
 * The WebSocket client lives in `@bandeira-tech/b3nd-core` —
 * `WebSocketClient` from `@bandeira-tech/b3nd-core/client-ws`.
 */

export { wsApi, wsServer } from "./libs/b3nd-server-ws/mod.ts";
export type { WsServerOptions } from "./libs/b3nd-server-ws/mod.ts";
