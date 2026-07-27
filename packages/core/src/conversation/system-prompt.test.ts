import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SystemPrompt, SystemPromptLayer, loadDefaultLayers } from "./system-prompt.js";

function makeLayer(
  name: string,
  priority: number,
  always: boolean,
  content: string
): SystemPromptLayer {
  return { name, priority, always, content };
}

describe("SystemPrompt", () => {
  it("assembles layers in priority order", () => {
    const sp = new SystemPrompt();
    sp.addLayer(makeLayer("role", 0, true, "ROLE CONTENT"));
    sp.addLayer(makeLayer("safety", 1, true, "SAFETY CONTENT"));

    const result = sp.assemble(Infinity);
    expect(result).toContain("ROLE CONTENT");
    expect(result).toContain("SAFETY CONTENT");
    const roleIdx = result.indexOf("ROLE CONTENT");
    const safetyIdx = result.indexOf("SAFETY CONTENT");
    expect(roleIdx).toBeLessThan(safetyIdx);
  });

  it("always layers are never trimmed", () => {
    const sp = new SystemPrompt();
    sp.addLayer(
      makeLayer("role", 0, true, "ROLE CONTENT THAT IS VERY IMPORTANT")
    );
    sp.addLayer(
      makeLayer("optional", 10, false, "OPTIONAL CONTENT")
    );

    // Very tight budget - role (always) should still appear
    const result = sp.assemble(5);
    expect(result).toContain("ROLE");
  });

  it("optional layers are trimmed when budget is tight", () => {
    const sp = new SystemPrompt();
    sp.addLayer(makeLayer("role", 0, true, "ROLE"));
    sp.addLayer(
      makeLayer(
        "big-optional",
        10,
        false,
        "A very long optional content that should be trimmed"
      )
    );

    const result = sp.assemble(5);
    expect(result).toContain("ROLE");
    expect(result).not.toContain("A very long optional");
  });

  it("all optional layers included when budget is large", () => {
    const sp = new SystemPrompt();
    sp.addLayer(makeLayer("role", 0, true, "ROLE"));
    sp.addLayer(makeLayer("opt1", 10, false, "OPT1"));
    sp.addLayer(makeLayer("opt2", 20, false, "OPT2"));

    const result = sp.assemble(10000);
    expect(result).toContain("ROLE");
    expect(result).toContain("OPT1");
    expect(result).toContain("OPT2");
  });

  it("removeLayer removes a layer by name", () => {
    const sp = new SystemPrompt();
    sp.addLayer(makeLayer("role", 0, true, "ROLE"));
    sp.addLayer(makeLayer("safety", 1, true, "SAFETY"));
    sp.removeLayer("safety");

    const result = sp.assemble(Infinity);
    expect(result).toContain("ROLE");
    expect(result).not.toContain("SAFETY");
  });

  it("returns empty string with no layers", () => {
    const sp = new SystemPrompt();
    expect(sp.assemble(Infinity)).toBe("");
  });
});

describe("loadDefaultLayers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-templates-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads role.md and safety.md from templates directory", () => {
    fs.writeFileSync(
      path.join(tmpDir, "role.md"),
      "You are a test role.",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "safety.md"),
      "Safety rules here.",
      "utf-8"
    );

    const layers = loadDefaultLayers(tmpDir);
    const names = layers.map((l) => l.name);

    expect(names).toContain("role");
    expect(names).toContain("safety");
  });

  it("returns always=true layers first in the result", () => {
    fs.writeFileSync(
      path.join(tmpDir, "role.md"),
      "Role content.",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "safety.md"),
      "Safety content.",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "tool-use.md"),
      "Tool content.",
      "utf-8"
    );

    const layers = loadDefaultLayers(tmpDir);
    const alwaysLayers = layers.filter((l) => l.always);
    const optionalLayers = layers.filter((l) => !l.always);

    expect(alwaysLayers).toHaveLength(2); // role + safety
    expect(optionalLayers).toHaveLength(1); // tool-use
  });

  it("skips template files that don't exist", () => {
    // Only write safety.md, not role.md or tool-use.md
    fs.writeFileSync(
      path.join(tmpDir, "safety.md"),
      "Safety rules.",
      "utf-8"
    );

    const layers = loadDefaultLayers(tmpDir);
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe("safety");
  });

  it("skips empty template files", () => {
    fs.writeFileSync(path.join(tmpDir, "role.md"), "", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "safety.md"), "Safety.", "utf-8");

    const layers = loadDefaultLayers(tmpDir);
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe("safety");
  });

  it("returns empty array when directory has no matching files", () => {
    const layers = loadDefaultLayers(tmpDir);
    expect(layers).toEqual([]);
  });

  it("loads memory-guide.md as the memory-guide layer (priority 4, optional)", () => {
    fs.writeFileSync(
      path.join(tmpDir, "memory-guide.md"),
      "Memory guidance.",
      "utf-8"
    );

    const layers = loadDefaultLayers(tmpDir);
    const layer = layers.find((l) => l.name === "memory-guide");

    expect(layer).toBeDefined();
    expect(layer?.priority).toBe(4);
    expect(layer?.always).toBe(false);
    expect(layer?.content).toBe("Memory guidance.");
  });
});
