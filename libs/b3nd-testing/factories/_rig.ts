/**
 * @module
 * Shared rig factory for the test harness. Every transport factory
 * boots the same backend so contract failures point at the transport,
 * not the store.
 */

import {
  connection,
  MemoryStore,
  Rig,
  SimpleClient,
} from "@bandeira-tech/b3nd-core";

/** SimpleClient over MemoryStore, accepting all uris on every route. */
export function defaultRig(): Rig {
  const route = connection(new SimpleClient(new MemoryStore()), ["*"]);
  return new Rig({
    routes: { receive: [route], read: [route], observe: [route] },
  });
}
