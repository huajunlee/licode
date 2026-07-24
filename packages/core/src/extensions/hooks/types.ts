export type HookPosition = `before:${string}` | `after:${string}`;

export interface HookConfig {
  events: string[];
  command: string;
  position?: string;
  timeout?: number;
  blocking?: boolean;
}

export interface RegisteredHook extends HookConfig {
  name: string;
  resolvedPosition: HookPosition;
}
