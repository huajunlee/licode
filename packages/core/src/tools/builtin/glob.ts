import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.js";

const GlobParams = z.object({
  pattern: z.string().describe("Glob pattern to match files (e.g., **/*.ts)"),
  path: z.string().optional().describe("Base directory for the search"),
});

function globSync(
  baseDir: string,
  pattern: string,
  maxResults = 500
): string[] {
  const results: string[] = [];
  const segments = pattern.split("/");

  function walk(dir: string, segIndex: number) {
    if (results.length >= maxResults) return;

    if (segIndex >= segments.length) {
      results.push(path.relative(baseDir, dir));
      return;
    }

    const seg = segments[segIndex];

    if (seg === "**") {
      // Match current dir and recurse
      if (segIndex === segments.length - 1) {
        // "**" at end matches everything under
        walk(dir, segIndex + 1);
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, segIndex);
            else if (results.length < maxResults) results.push(path.relative(baseDir, full));
          }
        } catch { /* skip permission errors */ }
      } else {
        const nextSeg = segments[segIndex + 1];
        // First, try matching ** as zero segments
        walk(dir, segIndex + 1);
        // Then recurse into subdirectories
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const full = path.join(dir, entry.name);
              // Try matching from this subdir with current **
              walk(full, segIndex);
            }
          }
        } catch { /* skip */ }
      }
      return;
    }

    // Simple glob matching
    const regex = new RegExp(
      "^" + seg.replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$"
    );

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (regex.test(entry.name)) {
          const full = path.join(dir, entry.name);
          if (segIndex === segments.length - 1) {
            if (results.length < maxResults) {
              results.push(path.relative(baseDir, full));
            }
          } else if (entry.isDirectory()) {
            walk(full, segIndex + 1);
          }
        }
      }
    } catch { /* skip permission errors */ }
  }

  walk(baseDir, 0);
  return results;
}

export const globTool: Tool<typeof GlobParams> = {
  name: "Glob",
  description:
    "Finds files matching a glob pattern. " +
    "Supports * (single segment) and ** (recursive) wildcards.",
  parameters: GlobParams,

  async execute(input, context) {
    const baseDir = input.path
      ? path.resolve(context.workingDirectory, input.path)
      : context.workingDirectory;

    if (!fs.existsSync(baseDir)) {
      return {
        status: "error",
        error: `Directory not found: ${input.path ?? baseDir}`,
        errorType: "execution",
      };
    }

    try {
      const results = globSync(baseDir, input.pattern);
      const content = results.join("\n") || "(no matches)";
      return {
        status: "success",
        content: content.length > 10000 ? content.slice(0, 10000) + "\n... (truncated)" : content,
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        errorType: "execution",
      };
    }
  },
};
