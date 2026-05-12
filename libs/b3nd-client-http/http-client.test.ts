/**
 * HttpClient Tests
 *
 * Tests the HTTP client implementation using the shared test suite
 * with mock HTTP server
 */

/// <reference lib="deno.ns" />

import { HttpClient } from "./mod.ts";
import { createMockServers } from "../b3nd-testing/mock-http-server.ts";
import { runSharedSuite } from "../b3nd-testing/shared-suite.ts";

// Start mock servers once before any tests
const serversPromise = createMockServers();

// Run shared suite with HttpClient factory functions
runSharedSuite("HttpClient", {
  happy: async () => {
    await serversPromise; // Ensure servers are running
    return new HttpClient({
      url: "http://127.0.0.1:8765",
    });
  },

  validationError: async () => {
    await serversPromise;
    return new HttpClient({
      url: "http://127.0.0.1:8766",
    });
  },

  connectionError: () =>
    new HttpClient({
      url: "http://127.0.0.1:9999", // No server here
      timeout: 1000,
    }),
});

// Cleanup servers after all shared suite tests
Deno.test({
  name: "HttpClient - cleanup servers",
  sanitizeResources: false, // Servers were created before tests started
  sanitizeOps: false,
  fn: async () => {
    const servers = await serversPromise;
    await servers.cleanup();
  },
});

// HttpClient-specific tests
Deno.test("HttpClient - custom headers configuration", () => {
  // Validate construction doesn't throw
  new HttpClient({
    url: "https://api.example.com",
    headers: { "X-Custom": "value", "Authorization": "Bearer token" },
  });
});

Deno.test("HttpClient - instance ID configuration", () => {
  // Validate construction doesn't throw
  new HttpClient({
    url: "https://api.example.com",
  });
});

Deno.test("HttpClient - timeout configuration", () => {
  // Validate construction doesn't throw
  new HttpClient({
    url: "https://api.example.com",
    timeout: 5000,
  });
});
