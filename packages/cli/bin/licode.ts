#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import App from "../src/app.js";

function parseArgs(): {
  sessionId?: string;
  model?: string;
  baseUrl?: string;
  help: boolean;
} {
  const args = process.argv.slice(2);
  const result: {
    sessionId?: string;
    model?: string;
    baseUrl?: string;
    help: boolean;
  } = { help: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && i + 1 < args.length) {
      result.sessionId = args[i + 1];
      i++;
    } else if (args[i] === "--model" && i + 1 < args.length) {
      result.model = args[i + 1];
      i++;
    } else if (args[i] === "--base-url" && i + 1 < args.length) {
      result.baseUrl = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    }
  }

  return result;
}

async function main() {
  const { sessionId, model, baseUrl, help } = parseArgs();

  if (help) {
    console.log(`LICode - AI Coding Assistant

Usage: licode [options]

Options:
  --session <id>    Resume an existing session
  --model <name>    Specify the model (default: claude-sonnet-4-6)
  --base-url <url>  LLM API base URL. Supports Anthropic-compatible APIs.
                    DeepSeek example: --base-url https://api.deepseek.com/anthropic
                    Also set via ANTHROPIC_BASE_URL env var.
  --help, -h        Show this help message
`);
    process.exit(0);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("Set it with: export ANTHROPIC_API_KEY=<your-api-key>");
    process.exit(1);
  }

  const resolvedBaseUrl = baseUrl ?? process.env.ANTHROPIC_BASE_URL;

  // List existing sessions
  const { ConversationManager } = await import("@licode/core");
  const sessions = await ConversationManager.listSessions();

  render(
    React.createElement(App, {
      apiKey,
      model,
      sessionId,
      baseUrl: resolvedBaseUrl,
      existingSessions: sessions,
    })
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
