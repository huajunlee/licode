import * as fs from "node:fs";
import * as path from "node:path";

export interface SpecKitOptions {
  cwd?: string;
}

export interface SpecInfo {
  name: string;
  path: string;
  status: string;
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function getCwd(options?: SpecKitOptions): string {
  return options?.cwd ?? process.cwd();
}

export function specsDir(options?: SpecKitOptions): string {
  return path.join(getCwd(options), "docs", "specs");
}

export function templatePath(fileName: string): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "..",
    "templates",
    fileName
  );
}

export async function readTemplate(fileName: string): Promise<string> {
  return fs.promises.readFile(templatePath(fileName), "utf-8");
}

export function readStatus(specContent: string): string {
  const match = specContent.match(/\*\*状态\*\*:\s*([^\n]+)/);
  return match?.[1].trim() ?? "unknown";
}
