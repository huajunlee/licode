import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CommandRouter } from "./commands/router.js";
import { initializeExtensions, registerExtensionMiddleware } from "./startup.js";
import { EventPipeline } from "../events/pipeline.js";
import { SystemPrompt } from "../conversation/system-prompt.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import type { PipelineEvent } from "../events/types.js";

const MOCK_SERVER_SCRIPT = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo" }], isError: false } }) + "\\n");
  }
});
`;

describe("initializeExtensions", () => {
  let workspace: string | null = null;

  afterEach(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = null;
    }
  });

  it("loads MCP tools, skill tools, prompt layers, commands, and hooks from project config", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "licode-ext-"));
    const licodeDir = path.join(workspace, ".licode");
    const skillDir = path.join(licodeDir, "skills", "hello");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      path.join(licodeDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          mock: {
            transport: "stdio",
            command: "node",
            args: ["--input-type=module", "-e", MOCK_SERVER_SCRIPT],
          },
        },
      })
    );
    writeFileSync(
      path.join(skillDir, "skill.md"),
      [
        "---",
        "name: hello",
        "version: 1.0.0",
        "tools:",
        "  - name: greet",
        "    description: Greet someone",
        "    script: greet.js",
        "    parameters:",
        "      name:",
        "        type: string",
        "        description: Name to greet",
        "---",
        "Use this skill to greet people.",
      ].join("\n")
    );
    writeFileSync(path.join(skillDir, "greet.js"), "#!/usr/bin/env node\n");
    writeFileSync(
      path.join(licodeDir, "hooks.json"),
      JSON.stringify({
        announce: {
          events: ["user-message"],
          command: "node -e 'process.exit(0)'",
          position: "pre-agent",
        },
      })
    );

    const tools = new ToolRegistry();
    const builtinTool: Tool = {
      name: "builtin",
      description: "existing tool",
      parameters: z.object({}),
      async execute() {
        return { status: "success", content: "ok" };
      },
    };
    tools.register(builtinTool);

    const systemPrompt = new SystemPrompt();
    const commands = new CommandRouter();

    const extensions = await initializeExtensions({
      workingDirectory: workspace,
      toolRegistry: tools,
      systemPrompt,
      commandRouter: commands,
    });

    expect(tools.list()).toEqual(
      expect.arrayContaining(["builtin", "mcp__mock__echo", "skill__greet"])
    );
    expect(systemPrompt.getLayers().map((layer) => layer.name)).toContain(
      "skill:hello"
    );
    expect(commands.list().map((cmd) => cmd.name)).toEqual(
      expect.arrayContaining(["help", "clear", "context", "memory"])
    );
    expect(extensions.mcp.listServers()[0]).toMatchObject({
      name: "mock",
      connected: true,
      toolCount: 1,
    });
    expect(extensions.hooks.getHooksAt("before:agentLoop")).toHaveLength(1);

    await extensions.shutdown();
  });

  it("registers the Agent tool when a subagent runner is configured", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "licode-agent-tool-"));

    const tools = new ToolRegistry();
    const extensions = await initializeExtensions({
      workingDirectory: workspace,
      toolRegistry: tools,
      systemPrompt: new SystemPrompt(),
      commandRouter: new CommandRouter(),
      subAgentRunner: async (input) => ({
        status: "success",
        content: `subagent:${input.task}`,
      }),
    });

    expect(tools.list()).toContain("Agent");

    await extensions.shutdown();
  });
});

describe("registerExtensionMiddleware", () => {
  it("adds hook middleware around the agent loop positions", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "licode-hooks-"));
    const licodeDir = path.join(workspace, ".licode");
    mkdirSync(licodeDir, { recursive: true });
    writeFileSync(
      path.join(licodeDir, "hooks.json"),
      JSON.stringify({
        noop: {
          events: ["user-message"],
          command: "node -e 'process.exit(0)'",
          position: "pre-agent",
        },
      })
    );

    const extensions = await initializeExtensions({
      workingDirectory: workspace,
      toolRegistry: new ToolRegistry(),
      systemPrompt: new SystemPrompt(),
      commandRouter: new CommandRouter(),
    });

    const pipeline = new EventPipeline();
    registerExtensionMiddleware(pipeline, extensions, "before:agentLoop");
    pipeline.use("agentLoop", async (_event, next) => next());

    async function* events(): AsyncIterable<PipelineEvent> {
      yield { type: "user-message", content: "hello" };
    }

    await pipeline.run(events());
    expect(pipeline.listMiddleware().map((entry) => entry.name)).toEqual([
      "hook:before:agentLoop",
      "agentLoop",
    ]);

    await extensions.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  });
});
