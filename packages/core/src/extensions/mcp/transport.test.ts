import { describe, it, expect, afterEach } from "vitest";
import { StdioTransport } from "./transport.js";
import type { MCPTransport } from "./transport.js";

/**
 * A simple JSON-RPC echo server used as the child process for transport tests.
 * Reads newline-delimited JSON from stdin, writes newline-delimited JSON to stdout.
 */
const ECHO_SERVER_SCRIPT = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    // Echo back with the same id so the test can match requests to responses
    process.stdout.write(JSON.stringify({ ...msg, echoed: true }) + "\\n");
  } catch {
    process.stdout.write(JSON.stringify({ error: "parse error" }) + "\\n");
  }
});
`;

describe("StdioTransport", () => {
  let transport: MCPTransport | null = null;

  afterEach(async () => {
    if (transport) {
      await transport.disconnect();
      transport = null;
    }
  });

  it("connects and spawns a child process", async () => {
    transport = new StdioTransport(
      "node",
      ["--input-type=module", "-e", ECHO_SERVER_SCRIPT]
    );

    await transport.connect();
    // connect() succeeded — the child process is alive
    expect(transport).toBeDefined();
  });

  it("sends a message and receives a response", async () => {
    transport = new StdioTransport(
      "node",
      ["--input-type=module", "-e", ECHO_SERVER_SCRIPT]
    );

    const received: unknown[] = [];
    transport.onMessage((msg) => {
      received.push(msg);
    });

    await transport.connect();

    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    // Wait for the response to arrive (short delay for IPC)
    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const response = received[0] as Record<string, unknown>;
    expect(response.id).toBe(1);
    expect(response.echoed).toBe(true);
  });

  it("handles multiple messages in sequence", async () => {
    transport = new StdioTransport(
      "node",
      ["--input-type=module", "-e", ECHO_SERVER_SCRIPT]
    );

    const received: unknown[] = [];
    transport.onMessage((msg) => {
      received.push(msg);
    });

    await transport.connect();

    await transport.send({ jsonrpc: "2.0", id: 1, method: "a" });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "b" });

    await new Promise((r) => setTimeout(r, 100));

    expect(received.length).toBe(2);
  });

  it("disconnects and kills the child process", async () => {
    transport = new StdioTransport(
      "node",
      ["--input-type=module", "-e", ECHO_SERVER_SCRIPT]
    );

    await transport.connect();
    await transport.disconnect();

    // disconnect() should complete without error
    expect(true).toBe(true);
  });

  it("handles message with no listeners gracefully", async () => {
    transport = new StdioTransport(
      "node",
      ["--input-type=module", "-e", ECHO_SERVER_SCRIPT]
    );

    await transport.connect();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    // Should not throw even without onMessage listener
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true);
  });
});
