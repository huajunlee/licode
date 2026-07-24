import * as fs from "node:fs";
import * as path from "node:path";
import { ConversationManager } from "../conversation/manager.js";

export interface SessionSummary {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
}

export class SessionManager {
  constructor(private dir: string = ".licode/sessions") {}

  getDirectory(): string {
    return this.dir;
  }

  async save(conversation: ConversationManager): Promise<void> {
    await conversation.save(path.join(this.dir, `${conversation.id}.json`));
  }

  async load(id: string): Promise<ConversationManager | null> {
    const filePath = await this.resolve(id);
    if (!filePath) return null;
    return ConversationManager.load(filePath);
  }

  async list(): Promise<SessionSummary[]> {
    return ConversationManager.listSessions(this.dir);
  }

  private async resolve(id: string): Promise<string | null> {
    const exactPath = path.join(this.dir, `${id}.json`);
    if (fs.existsSync(exactPath)) return exactPath;
    if (!fs.existsSync(this.dir)) return null;

    const matches = (await fs.promises.readdir(this.dir))
      .filter((file) => file.endsWith(".json"))
      .filter((file) => file.startsWith(id));

    if (matches.length !== 1) return null;
    return path.join(this.dir, matches[0]);
  }
}
