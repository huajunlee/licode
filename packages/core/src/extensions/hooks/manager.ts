import { spawn } from "node:child_process";
import type { PipelineEvent, Middleware } from "../../events/types.js";
import type { HookConfig, HookPosition, RegisteredHook } from "./types.js";

export { HookPosition } from "./types.js";

function spawnHook(command: string, event: PipelineEvent, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, timeoutMs);

    proc.on("close", () => {
      clearTimeout(timer);
      resolve();
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve();
    });

    proc.stdin!.write(JSON.stringify(event));
    proc.stdin!.end();
  });
}

export class HookManager {
  private groups: Map<HookPosition, RegisteredHook[]> = new Map();

  load(configs: Record<string, HookConfig>): void {
    this.groups.clear();

    for (const [name, config] of Object.entries(configs)) {
      const resolvedPosition = resolvePosition(config.position ?? "before:agentLoop");
      const hook: RegisteredHook = { name, ...config, resolvedPosition };

      const group = this.groups.get(resolvedPosition) ?? [];
      group.push(hook);
      this.groups.set(resolvedPosition, group);
    }
  }

  getHooksAt(position: HookPosition): RegisteredHook[] {
    return this.groups.get(position) ?? [];
  }

  getPositions(): HookPosition[] {
    return [...this.groups.keys()];
  }

  async onEvent(event: PipelineEvent, hooks: RegisteredHook[]): Promise<void> {
    const matched = hooks.filter((h) => this.matches(h.events, event.type));

    const tasks = matched.map(async (hook) => {
      try {
        const promise = spawnHook(hook.command, event, hook.timeout ?? 30000);
        if (hook.blocking) {
          await promise;
        }
        // Non-blocking: fire and forget
      } catch {
        // Hook failure never propagates
      }
    });

    await Promise.allSettled(tasks);
  }

  private matches(patterns: string[], eventType: string): boolean {
    return patterns.some((p) => {
      const regex = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
      return regex.test(eventType);
    });
  }
}

export function resolvePosition(raw: string): HookPosition {
  const aliases: Record<string, HookPosition> = {
    "pre-agent": "before:agentLoop",
    "post-agent": "after:agentLoop",
    "post-render": "after:renderer",
  };
  return aliases[raw] ?? (raw as HookPosition);
}

export function hookMiddleware(
  hooks: HookManager,
  position: HookPosition
): Middleware {
  const hooksAtPosition = hooks.getHooksAt(position);
  if (hooksAtPosition.length === 0) {
    return (_event, next) => next();
  }

  return async (event, next) => {
    await hooks.onEvent(event, hooksAtPosition);
    await next();
  };
}
