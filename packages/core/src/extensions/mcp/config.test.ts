import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadMCPConfig } from "./config.js";

describe("loadMCPConfig", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-mcp-test-"));

  afterEach(() => {
    // Clean up test files
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("returns empty config when file does not exist", () => {
    const config = loadMCPConfig(path.join(tmpDir, "nonexistent.json"));
    expect(config.mcpServers).toEqual({});
  });

  it("parses a valid mcp.json", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@anthropic-ai/mcp-server-filesystem"],
          },
        },
      })
    );

    const config = loadMCPConfig(configPath);
    expect(config.mcpServers.filesystem).toBeDefined();
    expect(config.mcpServers.filesystem.transport).toBe("stdio");
    expect(config.mcpServers.filesystem.command).toBe("npx");
  });

  it("resolves ${VAR} in headers from environment", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          api: {
            transport: "sse",
            url: "http://localhost:3001/sse",
            headers: {
              Authorization: "Bearer ${TEST_TOKEN}",
            },
          },
        },
      })
    );

    process.env.TEST_TOKEN = "secret123";
    const config = loadMCPConfig(configPath);
    delete process.env.TEST_TOKEN;

    expect(config.mcpServers.api.headers?.Authorization).toBe("Bearer secret123");
  });

  it("parses SSE transport config", () => {
    const configPath = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          remote: {
            transport: "sse",
            url: "http://localhost:3001/sse",
          },
        },
      })
    );

    const config = loadMCPConfig(configPath);
    expect(config.mcpServers.remote.transport).toBe("sse");
    expect(config.mcpServers.remote.url).toBe("http://localhost:3001/sse");
  });
});
