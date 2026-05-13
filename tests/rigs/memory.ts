/**
 * Rig backed by `SimpleClient` + `MemoryStore` — accepts all URIs on
 * every route. Used by the in-Deno `pinContract` suite for round-trip
 * assertions (write something, read it back).
 *
 * Note: the rig+store integration is the responsibility of
 * `@bandeira-tech/b3nd-stores`; this rig exists so b3nd-move can
 * verify that the wire faithfully carries values across, not to
 * re-prove storage semantics.
 */

import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import { MemoryStore } from "@bandeira-tech/b3nd-stores/memory";
import { SimpleClient } from "@bandeira-tech/b3nd-stores/adapters";

export function memoryRig(): Rig {
  const route = connection(new SimpleClient(new MemoryStore()), ["*"]);
  return new Rig({
    routes: { receive: [route], read: [route], observe: [route] },
  });
}
