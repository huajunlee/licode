import { StdioTransport } from "./transport.js";
import type { MCPTransport, JSONRPCMessage } from "./transport.js";
import { mcpToolToAdapter } from "./adapter.js";
import type { MCPCallResult, MCPTool } from "./adapter.js";
import type { Tool } from "../../tools/types.js";

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface ServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export class MCPServerConnection {
  readonly name: string;
  private transport: MCPTransport | null = null;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (msg: JSONRPCMessage) => void;
    reject: (err: Error) => void;
  }>();
  private _connected = false;

  constructor(private config: MCPServerConfig) {
    this.name = config.name;
  }

  get connected(): boolean {
    return this._connected;
  }

  async start(): Promise<void> {
    if (this.config.transport === "stdio") {
      this.transport = new StdioTransport(
        this.config.command!,
        this.config.args ?? [],
        this.config.env
      );
    } else {
      throw new Error(`Transport ${this.config.transport} not implemented yet`);
    }

    await this.transport.connect();

    this.transport.onMessage((msg) => {
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!.resolve(msg);
        this.pending.delete(msg.id);
      }
    });

    // Handshake
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "licode", version: "0.1.0" },
    });
    await this.sendNotification("notifications/initialized", {});

    this._connected = true;
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> {
    if (!this.transport) throw new Error("Transport not connected");

    const id = this.nextId++;
    const msg: JSONRPCMessage = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport!.send(msg).catch(reject);
    });
  }

  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.transport) throw new Error("Transport not connected");
    await this.transport.send({ jsonrpc: "2.0", method, params });
  }

  async listTools(): Promise<MCPTool[]> {
    const response = await this.sendRequest("tools/list", {});
    if (response.error) {
      throw new Error(`tools/list failed: ${response.error.message}`);
    }
    const result = response.result as { tools: MCPTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    if (!this.transport) throw new Error("not connected");
    const response = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
    if (response.error) {
      return {
        content: [{ type: "text", text: response.error.message }],
        isError: true,
      };
    }
    return response.result as MCPCallResult;
  }

  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.disconnect();
      this.transport = null;
    }
    this._connected = false;
  }
}

export class MCPClientManager {
  private servers: Map<string, MCPServerConnection> = new Map();
  private serverStatuses: Map<string, ServerStatus> = new Map();
  private serverTools: Map<string, Tool[]> = new Map();

  async initialize(config: MCPConfig): Promise<void> {
    const entries = Object.entries(config.mcpServers);
    for (const [name, serverConfig] of entries) {
      await this.connect({ ...serverConfig, name });
    }
  }

  async connect(config: MCPServerConfig): Promise<void> {
    const conn = new MCPServerConnection(config);
    this.servers.set(config.name, conn);

    try {
      await conn.start();
      const mcpTools = await conn.listTools();
      const tools = mcpTools.map((t) => mcpToolToAdapter(t, config.name, conn));
      this.serverTools.set(config.name, tools);
      this.serverStatuses.set(config.name, {
        name: config.name,
        connected: true,
        toolCount: mcpTools.length,
      });
    } catch (err) {
      this.serverStatuses.set(config.name, {
        name: config.name,
        connected: false,
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const [, t] of this.serverTools) {
      tools.push(...t);
    }
    return tools;
  }

  listServers(): ServerStatus[] {
    return [...this.serverStatuses.values()];
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.servers.get(name);
    if (conn) {
      await conn.stop();
      this.serverStatuses.set(name, {
        ...this.serverStatuses.get(name)!,
        connected: false,
        toolCount: 0,
      });
    }
  }
}
