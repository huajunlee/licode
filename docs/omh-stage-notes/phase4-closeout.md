# Phase 4 Closeout: Engineering Modules

## What was completed

Phase 4 now has core engineering modules for safety, context, memory, and session persistence.

The safety module adds a `PermissionGuard` that can stop approved tools before execution. `ToolExecutor` accepts an optional permission guard and stays compatible with existing callers.

The safety module also includes a macOS Seatbelt sandbox selector that wraps commands with writable roots. The Bash tool can use a sandbox from its tool context.

The context module adds token budget measurement, context compression, summarization, and long tool-output overflow files. A context middleware can compress the conversation before the next user message is handled.

The memory module stores Markdown memories, extracts simple explicit preferences, injects stored memories into `SystemPrompt`, and includes middleware that stores explicit preferences from user messages.

The session module wraps existing conversation persistence and can recover the latest session.

## Important files

- `packages/core/src/safety/permissions.ts`
- `packages/core/src/safety/sandbox.ts`
- `packages/core/src/safety/types.ts`
- `packages/core/src/tools/builtin/bash.ts`
- `packages/core/src/context/token-budget.ts`
- `packages/core/src/context/compressor.ts`
- `packages/core/src/context/middleware.ts`
- `packages/core/src/context/summarizer.ts`
- `packages/core/src/context/overflow.ts`
- `packages/core/src/memory/store.ts`
- `packages/core/src/memory/loader.ts`
- `packages/core/src/memory/extractor.ts`
- `packages/core/src/memory/middleware.ts`
- `packages/core/src/session/manager.ts`
- `packages/core/src/session/recovery.ts`
- `packages/core/src/tools/executor.ts`
- `packages/core/src/conversation/manager.ts`

## Evidence

Focused TDD test:

```bash
pnpm vitest run packages/core/src/safety/permissions.test.ts packages/core/src/context/context.test.ts packages/core/src/memory/memory.test.ts packages/core/src/session/session.test.ts
pnpm vitest run packages/core/src/safety/sandbox.test.ts packages/core/src/context/summarizer.test.ts packages/core/src/memory/extractor.test.ts
pnpm vitest run packages/core/src/tools/builtin/bash-sandbox.test.ts packages/core/src/context/middleware.test.ts packages/core/src/memory/middleware.test.ts
```

Result: focused Phase 4 tests passed.

## What to read next

Start with `packages/core/src/tools/executor.ts` to see where permission checks happen. Then read the individual module tests for the expected behavior.
