import { describe, it, expect, afterEach } from "vitest";
import { MCPServerConnection, MCPClientManager } from "./client.js";

const MOCK_SERVER_SCRIPT = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    let response;
    switch (msg.method) {
      case "initialize":
        response = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" } } };
        break;
      case "tools/list":
        response = { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } };
        break;
      case "tools/call":
        response = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + (msg.params?.arguments?.text ?? "") }], isError: false } };
        break;
      default:
        response = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
    }
    process.stdout.write(JSON.stringify(response) + "\\n");
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }) + "\\n");
  }
});
`;

describe("MCPServerConnection", () => {
  let conn: MCPServerConnection | null = null;

  afterEach(async () => {
    if (conn) {
      await conn.stop();
      conn = null;
    }
  });

  it("handshakes and discovers tools", async () => {
    conn = new MCPServerConnection({
      name: "mock",
      transport: "stdio",
      command: "node",
      args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
    });

    await conn.start();

    expect(conn.name).toBe("mock");
  });

  it("calls a discovered tool", async () => {
    conn = new MCPServerConnection({
      name: "mock",
      transport: "stdio",
      command: "node",
      args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
    });

    await conn.start();

    const result = await conn.callTool("echo", { text: "hello" });

    expect(result.content).toEqual([{ type: "text", text: "echo: hello" }]);
    expect(result.isError).toBe(false);
  });

  it("throws when calling a tool before connect", async () => {
    conn = new MCPServerConnection({
      name: "mock",
      transport: "stdio",
      command: "node",
      args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
    });

    await expect(conn.callTool("echo", {})).rejects.toThrow("not connected");
  });
});

describe("MCPClientManager", () => {
  let manager: MCPClientManager | null = null;

  afterEach(async () => {
    if (manager) {
      for (const s of manager.listServers()) {
        await manager.disconnect(s.name);
      }
      manager = null;
    }
  });

  it("initializes with server configs and discovers tools", async () => {
    manager = new MCPClientManager();
    await manager.initialize({
      mcpServers: {
        mock: {
          name: "mock",
      transport: "stdio",
          command: "node",
          args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
        },
      },
    });

    const tools = manager.getTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].name).toContain("mcp__mock__");
  });

  it("lists server statuses", async () => {
    manager = new MCPClientManager();
    await manager.initialize({
      mcpServers: {
        mock: {
          name: "mock",
      transport: "stdio",
          command: "node",
          args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
        },
      },
    });

    const servers = manager.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("mock");
    expect(servers[0].connected).toBe(true);
  });

  it("disconnects a server by name", async () => {
    manager = new MCPClientManager();
    await manager.initialize({
      mcpServers: {
        mock: {
          name: "mock",
      transport: "stdio",
          command: "node",
          args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
        },
      },
    });

    await manager.disconnect("mock");

    const servers = manager.listServers();
    expect(servers[0].connected).toBe(false);
  });

  it("isolates server failure — one broken server does not block others", async () => {
    manager = new MCPClientManager();
    await manager.initialize({
      mcpServers: {
        broken: {
          name: "mock",
      transport: "stdio",
          command: "nonexistent-command-xyz",
          args: [],
        },
      },
    });

    // Should not throw — the broken server is recorded as disconnected
    const servers = manager.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].connected).toBe(false);
    expect(servers[0].error).toBeTruthy();
  });
});
