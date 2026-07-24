import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus, specsDir, type SpecInfo, type SpecKitOptions } from "./utils.js";

export async function listSpecs(options?: SpecKitOptions): Promise<SpecInfo[]> {
  const root = specsDir(options);
  if (!fs.existsSync(root)) return [];

  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const specs: SpecInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const specPath = path.join(root, entry.name);
    const specFile = path.join(specPath, "spec.md");
    if (!fs.existsSync(specFile)) continue;
    const content = await fs.promises.readFile(specFile, "utf-8");
    specs.push({
      name: entry.name,
      path: specPath,
      status: readStatus(content),
    });
  }

  return specs.sort((a, b) => a.name.localeCompare(b.name));
}
