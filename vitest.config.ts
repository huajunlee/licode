import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@licode/spec-kit": resolve(root, "packages/spec-kit/src/index.ts"),
    },
  },
  test: {
    globals: true,
  },
});
