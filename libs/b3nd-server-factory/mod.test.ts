import { assertEquals } from "@std/assert";
import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  createServers,
  type ServerComposition,
  type ServerResolver,
  type TransportServer,
} from "./mod.ts";

const stubRig = {} as Rig;

function fakeResolver(
  transport: string,
): ServerResolver & {
  created: TransportServer[];
  lastComposition?: ServerComposition;
} {
  const created: TransportServer[] = [];
  const r = {
    transport,
    created,
    lastComposition: undefined as ServerComposition | undefined,
    create(rig: Rig, composition?: ServerComposition): TransportServer {
      assertEquals(rig, stubRig);
      r.lastComposition = composition;
      const server: TransportServer = {
        transport,
        address: `${transport}://0.0.0.0:0`,
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      };
      created.push(server);
      return server;
    },
  };
  return r;
}

Deno.test("createServers returns one server per resolver", () => {
  const http = fakeResolver("http");
  const grpc = fakeResolver("grpc");

  const servers = createServers(stubRig, [http, grpc]);

  assertEquals(servers.length, 2);
  assertEquals(servers[0].transport, "http");
  assertEquals(servers[1].transport, "grpc");
});

Deno.test("createServers with empty resolvers returns empty array", () => {
  const servers = createServers(stubRig, []);
  assertEquals(servers.length, 0);
});

Deno.test("createServers passes composition to every resolver", () => {
  const r1 = fakeResolver("a");
  const r2 = fakeResolver("b");

  createServers(stubRig, [r1, r2], { cors: "*" });

  assertEquals(r1.lastComposition, { cors: "*" });
  assertEquals(r2.lastComposition, { cors: "*" });
});

Deno.test("TransportServer lifecycle", async () => {
  let started = false;
  let stopped = false;

  const resolver: ServerResolver = {
    transport: "test",
    create(): TransportServer {
      return {
        transport: "test",
        address: "test://0.0.0.0:0",
        start() {
          started = true;
          return Promise.resolve();
        },
        stop() {
          stopped = true;
          return Promise.resolve();
        },
      };
    },
  };

  const [server] = createServers(stubRig, [resolver]);
  await server.start();
  assertEquals(started, true);
  await server.stop();
  assertEquals(stopped, true);
});
