import * as fs from "node:fs";
import * as path from "node:path";
import type { MCPConfig } from "./client.js";

const DEFAULT_CONFIG_PATH = ".licode/mcp/config.json";

export function loadMCPConfig(configPath?: string): MCPConfig {
  const resolvedPath = path.resolve(configPath ?? DEFAULT_CONFIG_PATH);

  if (!fs.existsSync(resolvedPath)) {
    return { mcpServers: {} };
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  // Resolve ${VAR} environment variables before JSON parse
  const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    return process.env[name] ?? "";
  });

  const config = JSON.parse(resolved);

  return {
    mcpServers: config.mcpServers ?? {},
  };
}
