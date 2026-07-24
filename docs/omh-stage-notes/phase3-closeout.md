# Phase 3 Closeout: Extension Startup

## What was completed

Phase 3 now has a startup integration path. LICode can initialize MCP servers, local skills, built-in slash commands, and hook configuration from one core helper.

The CLI chat startup calls this helper after the system prompt and built-in tools are created. Hook middleware is then inserted around the agent loop.

## Important files

- `packages/core/src/extensions/startup.ts`
- `packages/core/src/extensions/startup.test.ts`
- `packages/cli/src/hooks.ts`
- `packages/core/src/index.ts`

## Evidence

Focused TDD test:

```bash
pnpm vitest run packages/core/src/extensions/startup.test.ts
```

Result: 2 tests passed.

The test creates a temporary `.licode` project with MCP, skill, and hook config. It verifies that MCP tools, skill tools, skill prompt layers, slash commands, and hook middleware are registered.

## What to read next

Read `packages/core/src/extensions/startup.ts` first. It is the main entry point for Phase 3 integration.
