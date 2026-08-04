import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";
import type { LLMToolDefinition } from "../llm/provider.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private jsonSchemaCache = new Map<string, Record<string, unknown>>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    const schema = zodToJsonSchema(tool.parameters, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    this.jsonSchemaCache.set(tool.name, schema);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    const exact = this.tools.get(name);
    if (exact) return exact;
    // Fallback: case-insensitive match. Some models emit tool names with
    // wrong casing (e.g. deepseek-chat sending "read" for "Read"); tolerate
    // it so a stray lowercase call still resolves to the registered tool.
    const lower = name.toLowerCase();
    for (const tool of this.tools.values()) {
      if (tool.name.toLowerCase() === lower) return tool;
    }
    return undefined;
  }

  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  toLLMTools(): LLMToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: this.jsonSchemaCache.get(t.name)!,
    }));
  }

  unregister(name: string): boolean {
    this.jsonSchemaCache.delete(name);
    return this.tools.delete(name);
  }

  filterForAgent(whitelist: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const name of whitelist) {
      const tool = this.tools.get(name);
      if (tool) filtered.register(tool);
    }
    return filtered;
  }
}
