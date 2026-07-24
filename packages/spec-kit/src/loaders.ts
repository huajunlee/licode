import * as fs from "node:fs";
import * as path from "node:path";
import type { SystemPromptLayer } from "@licode/core";
import { getCwd, specsDir, type SpecKitOptions } from "./utils.js";

interface PromptLike {
  addLayer(layer: SystemPromptLayer): void;
}

export async function loadSpecFiles(
  systemPrompt: PromptLike,
  options?: SpecKitOptions
): Promise<void> {
  const root = specsDir(options);
  if (!fs.existsSync(root)) return;

  const entries = (await fs.promises.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .slice(0, 3);

  for (const name of entries) {
    const dir = path.join(root, name);
    const chunks: string[] = [];
    for (const fileName of ["spec.md", "tasks.md", "checklist.md"]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const content = await fs.promises.readFile(filePath, "utf-8");
      chunks.push(`### ${fileName}\n\n${content}`);
    }
    if (chunks.length === 0) continue;
    systemPrompt.addLayer({
      name: `spec:${name}`,
      priority: 12,
      always: false,
      content: `# Active Spec: ${name}\n\n${chunks.join("\n\n---\n\n")}`,
    });
  }
}

export async function loadCLAUDE(
  systemPrompt: PromptLike,
  options?: SpecKitOptions
): Promise<void> {
  const claudePath = path.join(getCwd(options), "CLAUDE.md");
  if (!fs.existsSync(claudePath)) return;
  const content = await fs.promises.readFile(claudePath, "utf-8");
  systemPrompt.addLayer({
    name: "claude",
    priority: 10,
    always: true,
    content: `# Project Instructions (CLAUDE.md)\n\n${content}`,
  });
}
