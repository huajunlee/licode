import type { SystemPrompt } from "../conversation/system-prompt.js";
import type { MemoryStore } from "./store.js";

export class MemoryLoader {
  constructor(private store: MemoryStore) {}

  async loadInto(systemPrompt: SystemPrompt): Promise<void> {
    const indexContent = await this.store.loadIndex();
    if (!indexContent || indexContent.trim().length === 0) return;

    systemPrompt.addLayer({
      name: "memory",
      priority: 5,
      always: false,
      content: indexContent.trim(),
    });
  }
}
