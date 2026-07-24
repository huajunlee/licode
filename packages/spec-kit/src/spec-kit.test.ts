import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemPrompt } from "../../core/src/conversation/system-prompt.js";
import { initSpec } from "./init.js";
import { listSpecs } from "./list.js";
import { loadCLAUDE, loadSpecFiles } from "./loaders.js";
import { specStatus } from "./status.js";
import { validateSpec } from "./validate.js";

describe("spec-kit workflow", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("initializes, lists, reports status, validates, and loads spec context", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "licode-spec-"));

    const created = await initSpec("login system", { cwd: dir });
    expect(created.files.map((file) => path.basename(file))).toEqual([
      "spec.md",
      "tasks.md",
      "checklist.md",
    ]);

    const specs = await listSpecs({ cwd: dir });
    expect(specs).toEqual([
      expect.objectContaining({ name: "login-system", status: "draft" }),
    ]);

    const status = await specStatus({ cwd: dir });
    expect(status.total).toBe(1);
    expect(status.active).toBe(1);

    const validation = await validateSpec("login-system", { cwd: dir });
    expect(validation.ok).toBe(true);

    const prompt = new SystemPrompt();
    await loadSpecFiles(prompt, { cwd: dir });
    await loadCLAUDE(prompt, { cwd: dir });

    const layers = prompt.getLayers();
    expect(layers.map((layer) => layer.name)).toContain("spec:login-system");
    expect(layers.find((layer) => layer.name === "claude")?.content).toContain(
      "Project Instructions"
    );
  });
});
