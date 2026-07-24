import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type MessageHandler = (msg: JSONRPCMessage) => void;

export interface MCPTransport {
  connect(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  disconnect(): Promise<void>;
}

export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private handlers: MessageHandler[] = [];
  private readline: ReturnType<typeof createInterface> | null = null;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>
  ) {}

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      try {
        this.process = spawn(this.command, this.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: this.env ? { ...process.env, ...this.env } : undefined,
        });
      } catch (err) {
        reject(err);
        return;
      }

      this.process.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.readline = createInterface({ input: this.process.stdout! });

      this.readline.on("line", (line: string) => {
        try {
          const msg = JSON.parse(line) as JSONRPCMessage;
          for (const handler of this.handlers) {
            handler(msg);
          }
        } catch {
          // Ignore non-JSON lines
        }
      });

      this.process.stderr?.on("data", () => {
        // stderr is intentionally not parsed
      });

      // Defer resolve so async error events from spawn have time to fire
      setImmediate(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error("Transport not connected");
    }
    const line = JSON.stringify(message) + "\n";
    this.process.stdin.write(line);
  }

  async disconnect(): Promise<void> {
    this.readline?.close();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.handlers = [];
  }
}
