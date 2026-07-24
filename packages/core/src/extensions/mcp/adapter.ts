import { z, ZodTypeAny } from "zod";
import type { Tool } from "../../tools/types.js";
import type { MCPServerConnection } from "./client.js";

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPCallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

export function jsonSchemaToZod(schema: Record<string, unknown>): ZodTypeAny {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: ZodTypeAny;

    switch (prop.type) {
      case "string":
        zodType = z.string();
        break;
      case "number":
      case "integer":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      default:
        zodType = z.any();
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description as string);
    }

    if (prop.default !== undefined) {
      zodType = zodType.default(prop.default);
    } else if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

export function mcpToolToAdapter(
  mcpTool: MCPTool,
  serverName: string,
  connection: MCPServerConnection
): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: `[MCP:${serverName}] ${mcpTool.description}`,
    parameters: jsonSchemaToZod(mcpTool.inputSchema),

    async execute(input) {
      const result: MCPCallResult = await connection.callTool(mcpTool.name, input);
      const content = result.content.map((c) => c.text).join("\n");

      if (result.isError) {
        return { status: "error", error: content, errorType: "execution" };
      }
      return { status: "success", content };
    },
  };
}
