import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Rig } from "@bandeira-tech/b3nd-core";
import {
  type AuthenticatedMessage,
  exportPrivateKeyPem,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  IdentityKey,
} from "@bandeira-tech/b3nd-canon/encrypt";

export interface McpServerOptions {
  name?: string;
  version?: string;
}

const TOOLS = [
  {
    name: "b3nd_read",
    description:
      "Read data from a B3nd URI. Returns the stored record with data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uri: {
          type: "string",
          description: "The B3nd URI to read (e.g., 'mutable://users/alice/profile')",
        },
      },
      required: ["uri"],
    },
  },
  {
    name: "b3nd_receive",
    description:
      "Store data at a B3nd URI. Accepts a message tuple [uri, data] — the unified interface for all state changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: {
          type: "array",
          description: "Message tuple [uri, data] — uri is the B3nd URI, data is the payload",
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ["message"],
    },
  },
  {
    name: "b3nd_list",
    description:
      "List items under a B3nd URI prefix. Returns all stored URIs under the path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uri: {
          type: "string",
          description: "The B3nd URI path to list (e.g., 'mutable://users/')",
        },
      },
      required: ["uri"],
    },
  },
  {
    name: "b3nd_delete",
    description: "Delete data at a B3nd URI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uri: {
          type: "string",
          description: "The B3nd URI to delete",
        },
      },
      required: ["uri"],
    },
  },
  {
    name: "b3nd_status",
    description: "Get the health and capabilities of the B3nd rig.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "b3nd_keygen",
    description:
      "Generate an Ed25519 signing keypair + X25519 encryption keypair. Returns private key PEM, public key hex, and encryption key hex.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "b3nd_sign",
    description:
      "Sign a payload with an Ed25519 private key. Returns an AuthenticatedMessage envelope { auth: [{pubkey, signature}], payload }.",
    inputSchema: {
      type: "object" as const,
      properties: {
        privateKeyPem: {
          type: "string",
          description: "Ed25519 private key in PEM format",
        },
        publicKeyHex: {
          type: "string",
          description: "Ed25519 public key as hex string",
        },
        payload: {
          type: "object",
          description: "The data to sign",
        },
      },
      required: ["privateKeyPem", "publicKeyHex", "payload"],
    },
  },
  {
    name: "b3nd_node_config_push",
    description:
      "Sign a node config with the operator key and write it to mutable://accounts/{operatorKeyHex}/nodes/{nodeId}/config.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operatorKeyPem: {
          type: "string",
          description: "Operator Ed25519 private key in PEM format",
        },
        operatorKeyHex: {
          type: "string",
          description: "Operator Ed25519 public key as hex string",
        },
        nodeId: {
          type: "string",
          description: "Node public key hex (used as node ID)",
        },
        config: {
          type: "object",
          description: "The node configuration object to push",
        },
      },
      required: ["operatorKeyPem", "operatorKeyHex", "nodeId", "config"],
    },
  },
  {
    name: "b3nd_node_config_get",
    description:
      "Read a node's config from mutable://accounts/{operatorKeyHex}/nodes/{nodeId}/config.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operatorKeyHex: {
          type: "string",
          description: "Operator public key hex",
        },
        nodeId: {
          type: "string",
          description: "Node public key hex (used as node ID)",
        },
      },
      required: ["operatorKeyHex", "nodeId"],
    },
  },
  {
    name: "b3nd_node_status",
    description: "Read a node's status from mutable://accounts/{nodeKeyHex}/status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodeKeyHex: {
          type: "string",
          description: "Node public key hex",
        },
      },
      required: ["nodeKeyHex"],
    },
  },
];

export function buildMcpServer(rig: Rig, opts: McpServerOptions = {}): Server {
  const server = new Server(
    { name: opts.name ?? "b3nd-mcp", version: opts.version ?? "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "b3nd_read": {
          const { uri } = args as { uri: string };
          const [result] = await rig.read(uri);
          if (result.success) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ success: true, uri, data: result.record?.data }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ success: false, uri, error: result.error }, null, 2),
            }],
            isError: true,
          };
        }

        case "b3nd_receive": {
          const { message } = args as { message: [string, unknown] };
          const [result] = await rig.receive([message]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ accepted: result.accepted, uri: message[0], error: result.error }, null, 2),
            }],
            isError: !result.accepted,
          };
        }

        case "b3nd_list": {
          const { uri } = args as { uri: string };
          const listUri = uri.endsWith("/") ? uri : uri + "/";
          const results = await rig.read(listUri);
          const items = results.map((r) =>
            r.success ? { uri: r.uri, data: r.record?.data } : { uri: r.uri, error: r.error }
          );
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ success: true, uri, items }, null, 2),
            }],
          };
        }

        case "b3nd_delete": {
          const { uri } = args as { uri: string };
          const [result] = await rig.receive([[uri, null]]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ accepted: result.accepted, uri, error: result.error }, null, 2),
            }],
            isError: !result.accepted,
          };
        }

        case "b3nd_status": {
          const result = await rig.status();
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case "b3nd_keygen": {
          const signingPair = await generateSigningKeyPair();
          const encPair = await generateEncryptionKeyPair();
          const privateKeyPem = await exportPrivateKeyPem(signingPair.privateKey, "PRIVATE KEY");
          const encPrivateKeyBytes = new Uint8Array(
            await crypto.subtle.exportKey("pkcs8", encPair.privateKey),
          );
          const encPrivateKeyHex = Array.from(encPrivateKeyBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          return {
            content: [{
              type: "text",
              text: JSON.stringify(
                {
                  signing: { publicKeyHex: signingPair.publicKeyHex, privateKeyPem },
                  encryption: { publicKeyHex: encPair.publicKeyHex, privateKeyHex: encPrivateKeyHex },
                },
                null,
                2,
              ),
            }],
          };
        }

        case "b3nd_sign": {
          const { privateKeyPem, publicKeyHex, payload } = args as {
            privateKeyPem: string;
            publicKeyHex: string;
            payload: unknown;
          };
          const identity = await IdentityKey.fromPem(privateKeyPem, publicKeyHex);
          const signature = await identity.sign(payload);
          const authenticatedMessage: AuthenticatedMessage = {
            auth: [{ pubkey: publicKeyHex, signature }],
            payload,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(authenticatedMessage, null, 2) }],
          };
        }

        case "b3nd_node_config_push": {
          const { operatorKeyPem, operatorKeyHex, nodeId, config: nodeConfig } = args as {
            operatorKeyPem: string;
            operatorKeyHex: string;
            nodeId: string;
            config: unknown;
          };
          const uri = `mutable://accounts/${operatorKeyHex}/nodes/${nodeId}/config`;
          const identity = await IdentityKey.fromPem(operatorKeyPem, operatorKeyHex);
          const signature = await identity.sign(nodeConfig);
          const signedData = { auth: [{ pubkey: operatorKeyHex, signature }], payload: nodeConfig };
          const [result] = await rig.receive([[uri, signedData]]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ accepted: result.accepted, uri, error: result.error }, null, 2),
            }],
            isError: !result.accepted,
          };
        }

        case "b3nd_node_config_get": {
          const { operatorKeyHex, nodeId } = args as { operatorKeyHex: string; nodeId: string };
          const uri = `mutable://accounts/${operatorKeyHex}/nodes/${nodeId}/config`;
          const [result] = await rig.read(uri);
          if (result.success) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ success: true, uri, data: result.record?.data }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ success: false, uri, error: result.error }, null, 2),
            }],
            isError: true,
          };
        }

        case "b3nd_node_status": {
          const { nodeKeyHex } = args as { nodeKeyHex: string };
          const uri = `mutable://accounts/${nodeKeyHex}/status`;
          const [result] = await rig.read(uri);
          if (result.success) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ success: true, uri, data: result.record?.data }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ success: false, uri, error: result.error }, null, 2),
            }],
            isError: true,
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message, tool: name }, null, 2) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const status = await rig.status();
      const schemaResources = (status.schema ?? []).map((program) => ({
        uri: `b3nd://${program}`,
        name: program,
        description: `B3nd program: ${program}`,
        mimeType: "application/json",
      }));
      return {
        resources: [
          {
            uri: "b3nd://status",
            name: "Rig Status",
            description: "Health and capabilities of the B3nd rig",
            mimeType: "application/json",
          },
          ...schemaResources,
        ],
      };
    } catch {
      return { resources: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resourceUri = request.params.uri;

    if (resourceUri === "b3nd://status") {
      const status = await rig.status();
      return {
        contents: [{
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify(status, null, 2),
        }],
      };
    }

    // b3nd://{b3ndUri} — read the URI directly from the rig
    const b3ndUri = resourceUri.replace(/^b3nd:\/\//, "");
    try {
      const [result] = await rig.read(b3ndUri);
      return {
        contents: [{
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify(result.success ? result.record?.data : { error: result.error }, null, 2),
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        contents: [{
          uri: resourceUri,
          mimeType: "application/json",
          text: JSON.stringify({ error: message }),
        }],
      };
    }
  });

  return server;
}
