export interface SandboxCommand {
  command: string;
  args: string[];
}

export interface Sandbox {
  wrapCommand(command: string): SandboxCommand;
}

export interface SandboxOptions {
  platform?: NodeJS.Platform;
  writableRoots?: string[];
}

class MacOSSandbox implements Sandbox {
  constructor(private writableRoots: string[]) {}

  wrapCommand(command: string): SandboxCommand {
    const writeRules = this.writableRoots
      .map((root) => `(allow file-write* (subpath "${root}"))`)
      .join("\n");
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow file-read*)",
      writeRules,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      command: "sandbox-exec",
      args: ["-p", profile, "sh", "-lc", command],
    };
  }
}

export function createSandbox(options: SandboxOptions = {}): Sandbox | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;
  return new MacOSSandbox(options.writableRoots ?? [process.cwd()]);
}
