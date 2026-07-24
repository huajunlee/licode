import * as fs from "node:fs";
import * as path from "node:path";
import { specsDir, type SpecKitOptions } from "./utils.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export async function validateSpec(
  name: string,
  options?: SpecKitOptions
): Promise<ValidationResult> {
  const dir = path.join(specsDir(options), name);
  const required = ["spec.md", "tasks.md", "checklist.md"];
  const errors: string[] = [];

  for (const fileName of required) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing ${fileName}`);
      continue;
    }
    const content = await fs.promises.readFile(filePath, "utf-8");
    if (!content.trim()) errors.push(`${fileName} is empty`);
  }

  return { ok: errors.length === 0, errors };
}
