import type { SystemPrompt } from "../conversation/system-prompt.js";
import type { MemoryStore } from "./store.js";

export class MemoryLoader {
  constructor(private store: MemoryStore) {}

  async loadInto(systemPrompt: SystemPrompt): Promise<void> {
    const entries = await this.store.list();
    if (entries.length === 0) return;

    const content = entries
      .map((entry) => `## ${entry.title}\n${entry.content}`)
      .join("\n\n");

    systemPrompt.addLayer({
      name: "memory",
      priority: 8,
      always: false,
      content: `# Memory\n\n${content}`,
    });
  }
}
