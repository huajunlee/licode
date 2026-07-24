#!/usr/bin/env node
import { runCli } from "../src/cli.js";

async function main() {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
