import * as fs from "node:fs";
import * as path from "node:path";
import {
  getCwd,
  readTemplate,
  slugify,
  specsDir,
  type SpecKitOptions,
} from "./utils.js";

export interface InitSpecResult {
  name: string;
  directory: string;
  files: string[];
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return values[key] ?? "";
  });
}

export async function initSpec(
  rawName: string,
  options?: SpecKitOptions
): Promise<InitSpecResult> {
  const name = slugify(rawName);
  if (!name) throw new Error("Spec name is required");

  const cwd = getCwd(options);
  const directory = path.join(specsDir(options), name);
  await fs.promises.mkdir(directory, { recursive: true });

  const values = {
    name,
    date: new Date().toISOString().slice(0, 10),
  };
  const files: string[] = [];
  for (const fileName of ["spec.md", "tasks.md", "checklist.md"]) {
    const target = path.join(directory, fileName);
    const template = await readTemplate(fileName);
    await fs.promises.writeFile(target, render(template, values), "utf-8");
    files.push(target);
  }

  const claudePath = path.join(cwd, "CLAUDE.md");
  if (!fs.existsSync(claudePath)) {
    await fs.promises.writeFile(
      claudePath,
      await readTemplate("CLAUDE.md"),
      "utf-8"
    );
  }

  return { name, directory, files };
}
