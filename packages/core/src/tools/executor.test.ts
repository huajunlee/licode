import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

function bigOutputTool(output: string): Tool {
  return {
    name: "big",
    description: "returns configurable output",
    parameters: z.object({}),
    execute: async () => ({ status: "success" as const, content: output }),
  };
}

describe("ToolExecutor overflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-exec-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("spills oversized success output and returns a pointer+preview (config threshold)", async () => {
    const registry = new ToolRegistry();
    registry.register(bigOutputTool("z".repeat(1000)));
    const executor = new ToolExecutor(registry, { overflowMaxBytes: 100 });

    const result = await executor.executeOne(
      { id: "t1", name: "big", input: {} },
      { workingDirectory: dir }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.content).toContain(".licode/overflow/");
    expect(result.metadata?.overflowPath).toBeTruthy();
    expect(fs.readFileSync(result.metadata!.overflowPath as string, "utf-8")).toBe(
      "z".repeat(1000)
    );
  });

  it("passes small success output through unchanged", async () => {
    const registry = new ToolRegistry();
    registry.register(bigOutputTool("small output"));
    const executor = new ToolExecutor(registry, { overflowMaxBytes: 100 });

    const result = await executor.executeOne(
      { id: "t1", name: "big", input: {} },
      { workingDirectory: dir }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.content).toBe("small output");
    expect(result.metadata?.overflowPath).toBeUndefined();
  });

  it("passes error results through without overflowing", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "always errors",
      parameters: z.object({}),
      execute: async () => ({
        status: "error" as const,
        error: "fail",
        errorType: "execution" as const,
      }),
    });
    const executor = new ToolExecutor(registry, { overflowMaxBytes: 10 });

    const result = await executor.executeOne(
      { id: "t1", name: "boom", input: {} },
      { workingDirectory: dir }
    );

    expect(result.status).toBe("error");
    if (result.status !== "success") {
      expect(result.error).toBe("fail");
    }
  });

  it("default threshold is 64KB (output just under stays inline)", async () => {
    const registry = new ToolRegistry();
    // 60KB - under the 64KB default, should stay inline.
    registry.register(bigOutputTool("a".repeat(60 * 1024)));
    const executor = new ToolExecutor(registry); // no overflowMaxBytes -> default 64KB

    const result = await executor.executeOne(
      { id: "t1", name: "big", input: {} },
      { workingDirectory: dir }
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.metadata?.overflowPath).toBeUndefined();
    expect(result.content.length).toBe(60 * 1024);
  });
});

describe("ToolExecutor tool resolution", () => {
  it("resolves tool names case-insensitively (e.g. deepseek 'read' -> 'Read')", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Read",
      description: "read",
      parameters: z.object({}),
      execute: async () => ({ status: "success" as const, content: "ok" }),
    });
    const executor = new ToolExecutor(registry);

    const result = await executor.executeOne({ id: "t1", name: "read", input: {} });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.content).toBe("ok");
  });

  it("still errors on a truly unknown tool name", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Read",
      description: "read",
      parameters: z.object({}),
      execute: async () => ({ status: "success" as const, content: "ok" }),
    });
    const executor = new ToolExecutor(registry);

    const result = await executor.executeOne({ id: "t1", name: "nope", input: {} });
    expect(result.status).toBe("error");
    if (result.status !== "success") {
      expect(result.error).toContain("Unknown tool");
    }
  });
});
