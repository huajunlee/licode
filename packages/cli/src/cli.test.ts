import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, initializeConversationRuntime } from "./cli.js";

describe("runCli", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("handles spec subcommands without starting the Ink app", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-cli-"));

    const init = await runCli(["spec", "init", "todo app"], {
      cwd: dir,
      env: {},
      renderApp: async () => {},
    });
    const list = await runCli(["spec", "list"], {
      cwd: dir,
      env: {},
      renderApp: async () => {},
    });

    expect(init).toMatchObject({ code: 0, stdout: expect.stringContaining("todo-app") });
    expect(list).toMatchObject({ code: 0, stdout: expect.stringContaining("todo-app") });
  });

  it("loads CLAUDE.md and active specs into the conversation system prompt", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-cli-context-"));
    mkdirSync(path.join(dir, "docs", "specs", "demo"), { recursive: true });
    writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\nUse strict TDD.");
    writeFileSync(
      path.join(dir, "docs", "specs", "demo", "spec.md"),
      "# Demo\n\n**状态**: draft\n"
    );
    writeFileSync(path.join(dir, "docs", "specs", "demo", "tasks.md"), "# Tasks\n");
    writeFileSync(path.join(dir, "docs", "specs", "demo", "checklist.md"), "# Checklist\n");

    const runtime = await initializeConversationRuntime({
      cwd: dir,
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "http://localhost",
    });

    const layerNames = runtime.manager.systemPrompt
      .getLayers()
      .map((layer) => layer.name);
    expect(layerNames).toEqual(expect.arrayContaining(["claude", "spec:demo"]));
    await runtime.extensions.shutdown();
  });
});
