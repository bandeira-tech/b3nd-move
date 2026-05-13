/**
 * @module
 * Shared rig factory for the test harness. Every transport factory
 * boots the same backend so contract failures point at the transport,
 * not the store.
 */

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import { MemoryStore } from "@bandeira-tech/b3nd-stores/memory";
import { SimpleClient } from "@bandeira-tech/b3nd-stores/adapters";

/** SimpleClient over MemoryStore, accepting all uris on every route. */
export function defaultRig(): Rig {
  const route = connection(new SimpleClient(new MemoryStore()), ["*"]);
  return new Rig({
    routes: { receive: [route], read: [route], observe: [route] },
  });
}
