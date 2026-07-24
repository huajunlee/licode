import { describe, it, expect } from "vitest";
import { mcpToolToAdapter, jsonSchemaToZod } from "./adapter.js";
import type { Tool } from "../../tools/types.js";
import type { MCPServerConnection } from "./client.js";

// Minimal mock connection — only used for tool execution
function mockConnection(result: unknown): MCPServerConnection {
  return {
    callTool: async () => result,
    name: "test-server",
  } as unknown as MCPServerConnection;
}

describe("jsonSchemaToZod", () => {
  it("converts string property", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
      },
    };
    const zodSchema = jsonSchemaToZod(schema);
    expect(zodSchema.safeParse({ name: "hello" }).success).toBe(true);
    expect(zodSchema.safeParse({ name: 123 }).success).toBe(false);
  });

  it("converts number property", () => {
    const schema = {
      type: "object" as const,
      properties: {
        count: { type: "number" as const },
      },
    };
    const zodSchema = jsonSchemaToZod(schema);
    expect(zodSchema.safeParse({ count: 42 }).success).toBe(true);
    expect(zodSchema.safeParse({ count: "not-a-number" }).success).toBe(false);
  });

  it("converts boolean property", () => {
    const schema = {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" as const },
      },
    };
    const zodSchema = jsonSchemaToZod(schema);
    expect(zodSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(zodSchema.safeParse({ enabled: "yes" }).success).toBe(false);
  });

  it("handles optional properties (no required array)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        age: { type: "number" as const },
      },
    };
    const zodSchema = jsonSchemaToZod(schema);
    expect(zodSchema.safeParse({ name: "hello" }).success).toBe(true);
    expect(zodSchema.safeParse({}).success).toBe(true);
  });

  it("handles required properties", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        age: { type: "number" as const },
      },
      required: ["name"],
    };
    const zodSchema = jsonSchemaToZod(schema);
    expect(zodSchema.safeParse({ name: "hello" }).success).toBe(true);
    expect(zodSchema.safeParse({ age: 30 }).success).toBe(false);
  });

  it("handles default values", () => {
    const schema = {
      type: "object" as const,
      properties: {
        max_results: { type: "number" as const, default: 10 },
      },
    };
    const zodSchema = jsonSchemaToZod(schema);
    const result = zodSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_results).toBe(10);
    }
  });

  it("handles empty properties", () => {
    const schema = {
      type: "object" as const,
      properties: {},
    };
    const zodSchema = jsonSchemaToZod(schema);
    expect(zodSchema.safeParse({}).success).toBe(true);
  });
});

describe("mcpToolToAdapter", () => {
  it("wraps an MCP tool with namespaced name", () => {
    const tool = mcpToolToAdapter(
      {
        name: "search",
        description: "Search files",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
          },
          required: ["query"],
        },
      },
      "filesystem",
      mockConnection({ content: [{ type: "text", text: "found" }], isError: false })
    );

    expect(tool.name).toBe("mcp__filesystem__search");
    expect(tool.description).toBe("[MCP:filesystem] Search files");
  });

  it("executes via the connection and returns success result", async () => {
    const tool = mcpToolToAdapter(
      {
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: { type: "string" as const },
          },
          required: ["path"],
        },
      },
      "fs",
      mockConnection({ content: [{ type: "text", text: "file contents" }], isError: false })
    );

    const result = await tool.execute(
      { path: "/tmp/test.txt" },
      { workingDirectory: "/tmp", sessionId: "s1" }
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.content).toBe("file contents");
    }
  });

  it("returns error result when MCP tool reports isError", async () => {
    const tool = mcpToolToAdapter(
      {
        name: "bad-tool",
        description: "Always fails",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      "bad",
      mockConnection({ content: [{ type: "text", text: "Something went wrong" }], isError: true })
    );

    const result = await tool.execute({}, { workingDirectory: "/tmp", sessionId: "s1" });

    expect(result.status).toBe("error");
  });

  it("concatenates multiple content items", async () => {
    const tool = mcpToolToAdapter(
      {
        name: "list",
        description: "List items",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      "lst",
      mockConnection({
        content: [
          { type: "text", text: "item1" },
          { type: "text", text: "item2" },
        ],
        isError: false,
      })
    );

    const result = await tool.execute({}, { workingDirectory: "/tmp", sessionId: "s1" });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.content).toBe("item1\nitem2");
    }
  });
});
