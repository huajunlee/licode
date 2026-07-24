import type { MemoryEntry } from "./types.js";

export class MemoryExtractor {
  extract(text: string): MemoryEntry[] {
    const normalized = text.trim();
    if (!normalized) return [];

    const entries: MemoryEntry[] = [];

    // Pattern: "my name is X" / "我叫X" / "我的名字是X"
    {
      const m =
        normalized.match(/\bmy name is\s+(.+)/i) ??
        normalized.match(/我叫\s*(.+)/) ??
        normalized.match(/我的名字是\s*(.+)/) ??
        normalized.match(/我的名字叫\s*(.+)/);
      if (m) {
        const name = m[1].replace(/[.。！!]\s*$/, "").trim();
        entries.push({
          id: `memory-${this.hash(`name:${name}`)}`,
          title: "User Name",
          content: `The user's name is ${name}.`,
          tags: ["identity"],
        });
      }
    }

    // Pattern: "call me X" / "请叫我X" / "喊我X"
    {
      const m =
        normalized.match(/\bcall me\s+(.+)/i) ??
        normalized.match(/请叫我\s*(.+)/) ??
        normalized.match(/喊我\s*(.+)/) ??
        normalized.match(/称呼我\s*(.+)/);
      if (m) {
        const name = m[1].replace(/[.。！!]\s*$/, "").trim();
        entries.push({
          id: `memory-${this.hash(`callme:${name}`)}`,
          title: "Preferred Name",
          content: `The user prefers to be called ${name}.`,
          tags: ["identity"],
        });
      }
    }

    // Pattern: "I am a X" / "I'm a X" / "我是X" / "我是一名X"
    {
      const m =
        normalized.match(/\bi(?:'m| am)\s+(a\s+.+)/i) ??
        normalized.match(/我是(?:一名|一个)?\s*(.+)/);
      if (m) {
        const identity = m[1].replace(/[.。！!]\s*$/, "").trim();
        entries.push({
          id: `memory-${this.hash(`iam:${identity}`)}`,
          title: "User Identity",
          content: `The user is ${identity}.`,
          tags: ["identity"],
        });
      }
    }

    // Pattern: "remember that I prefer/like/use/want X" / "记住我喜欢/偏好X"
    {
      const m =
        normalized.match(
          /\b(?:remember that|note that)\s+i\s+(prefer|like|use|want)\s+(.+)/i
        ) ??
        normalized.match(
          /(?:记住|请注意)(?:我)?\s*(喜欢|偏好|使用|想要|希望)\s*(.+)/
        );
      if (m) {
        const verb = this.mapChineseVerb(m[1]);
        const detail = m[2].replace(/[.。！!]\s*$/, "").trim();
        const content = `The user ${verb} ${detail}.`;
        entries.push({
          id: `memory-${this.hash(content)}`,
          title: "Preference",
          content,
          tags: ["preference"],
        });
      }
    }

    // Pattern: General "remember that X" / "记住X" (catch-all)
    if (entries.length === 0) {
      const m =
        normalized.match(/\b(?:remember that|note that)\s+(.+)/i) ??
        normalized.match(/(?:记住|请注意)\s*(.+)/);
      if (m) {
        const content = m[1].replace(/[.。！!]\s*$/, "").trim();
        entries.push({
          id: `memory-${this.hash(content)}`,
          title: "Memory",
          content,
          tags: ["general"],
        });
      }
    }

    return entries;
  }

  private mapChineseVerb(verb: string): string {
    const map: Record<string, string> = {
      喜欢: "likes",
      偏好: "prefers",
      使用: "uses",
      想要: "wants",
      希望: "wants",
    };
    return map[verb] ?? verb.toLowerCase();
  }

  private hash(value: string): string {
    let hash = 0;
    for (const char of value) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return hash.toString(36);
  }
}
