# Phase 6 Closeout: Spec Development Mode

## What was completed

Phase 6 now has a new `@licode/spec-kit` package and CLI subcommands for spec workflow files.

`licode spec init <name>` creates `docs/specs/<name>/spec.md`, `tasks.md`, and `checklist.md`. It also creates `CLAUDE.md` if the project does not already have one.

`licode spec list`, `licode spec status`, and `licode spec validate <name>` read those files and report their state.

The loader functions can inject active spec files and `CLAUDE.md` into `SystemPrompt`.

The CLI startup path now calls those loaders before extension initialization, so normal chat sessions receive project instructions and active specs.

## Important files

- `packages/spec-kit/src/init.ts`
- `packages/spec-kit/src/list.ts`
- `packages/spec-kit/src/status.ts`
- `packages/spec-kit/src/validate.ts`
- `packages/spec-kit/src/loaders.ts`
- `packages/spec-kit/package.json`
- `templates/spec.md`
- `templates/tasks.md`
- `templates/checklist.md`
- `templates/CLAUDE.md`
- `packages/cli/src/cli.ts`
- `packages/cli/src/hooks.ts`
- `packages/cli/bin/licode.ts`

## Evidence

Focused TDD test:

```bash
pnpm vitest run packages/spec-kit/src/spec-kit.test.ts packages/cli/src/cli.test.ts
```

Result: spec-kit workflow tests and CLI spec/context tests passed.

## What to read next

Start with `packages/spec-kit/src/init.ts` to understand the generated files. Then read `packages/cli/src/cli.ts` to see how the `licode spec` commands are routed.
