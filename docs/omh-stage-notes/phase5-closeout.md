# Phase 5 Closeout: Multi-Agent Support

## What was completed

Phase 5 now has the basic multi-agent building blocks.

`Agent` is available as a tool adapter around `SubAgentManager`. The manager accepts an injected runner, so the current code can be tested without starting a real LLM loop.

`WorktreeManager` wraps `git worktree add` and `git worktree remove` behind an injectable git runner. This keeps the production path ready for real git isolation while tests stay local and fast.

`/subagent on|off|status` is registered as a slash command through the Phase 3 startup path. The startup helper can also register the `Agent` tool when a subagent runner is supplied.

## Important files

- `packages/core/src/multi-agent/types.ts`
- `packages/core/src/multi-agent/subagent.ts`
- `packages/core/src/multi-agent/agent-tool.ts`
- `packages/core/src/multi-agent/worktree.ts`
- `packages/core/src/multi-agent/commands.ts`
- `packages/core/src/multi-agent/multi-agent.test.ts`
- `packages/core/src/extensions/startup.ts`
- `packages/core/src/extensions/startup.test.ts`

## Evidence

Focused TDD test:

```bash
pnpm vitest run packages/core/src/multi-agent/multi-agent.test.ts
pnpm vitest run packages/core/src/extensions/startup.test.ts
```

Result: multi-agent unit tests and startup registration tests passed.

## What to read next

Read `packages/core/src/multi-agent/agent-tool.ts` to see the main contract. Then read `packages/core/src/multi-agent/worktree.ts` for filesystem isolation.
