import type { Memory, MemoryType } from "./types.js";

/** Question words / patterns that indicate the user is asking, not stating. */
const QUESTION_PATTERNS = [
  /^什么/, /^啥/, /^谁/, /^怎么/, /^哪/, /^多少/, /^几/,
  /^what/i, /^who/i, /^how/i, /^where/i, /^when/i, /^why/i,
  /[？?]$/, /吗$/, /呢$/,
];

function isQuestionLike(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  for (const p of QUESTION_PATTERNS) {
    if (p.test(trimmed)) return true;
  }
  return false;
}

/**
 * @deprecated Use the LLM-based {@link MemoryExtractor} instead.
 * This regex-based extractor is kept for reference but is no longer used
 * in the runtime pipeline since Step 2.
 */
export class RegexMemoryExtractor {
  extract(text: string): Memory[] {
    const normalized = text.trim();
    if (!normalized) return [];

    const now = new Date().toISOString();

    // Pattern: "my name is X" / "我叫X" / "我的名字是X"
    {
      const m =
        normalized.match(/\bmy name is\s+(.+)/i) ??
        normalized.match(/我叫\s*(.+)/) ??
        normalized.match(/我的名字是\s*(.+)/) ??
        normalized.match(/我的名字叫\s*(.+)/);
      if (m) {
        const name = m[1].replace(/[.。！!]\s*$/, "").trim();
        if (!isQuestionLike(name)) {
          return [{
            slug: "user/identity",
            type: "user" as MemoryType,
            name: "User Name",
            description: `The user's name is ${name}.`,
            content: `The user's name is ${name}.`,
            createdAt: now,
            updatedAt: now,
          }];
        }
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
        if (!isQuestionLike(name)) {
          return [{
            slug: "user/identity",
            type: "user" as MemoryType,
            name: "Preferred Name",
            description: `The user prefers to be called ${name}.`,
            content: `The user prefers to be called ${name}.`,
            createdAt: now,
            updatedAt: now,
          }];
        }
      }
    }

    // Pattern: "I am a X" / "I'm a X" / "我是X"
    {
      const m =
        normalized.match(/\bi(?:'m| am)\s+(a\s+.+)/i) ??
        normalized.match(/我是(?:一名|一个)?\s*(.+)/);
      if (m) {
        const identity = m[1].replace(/[.。！!]\s*$/, "").trim();
        if (!isQuestionLike(identity)) {
          return [{
            slug: "user/identity",
            type: "user" as MemoryType,
            name: "User Identity",
            description: `The user is ${identity}.`,
            content: `The user is ${identity}.`,
            createdAt: now,
            updatedAt: now,
          }];
        }
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
        const description = `The user ${verb} ${detail}.`;
        const slug = "user/" + this.hash(description);
        return [{
          slug,
          type: "user" as MemoryType,
          name: "Preference",
          description,
          content: description,
          createdAt: now,
          updatedAt: now,
        }];
      }
    }

    // Pattern: General "remember that X" / "记住X" (catch-all)
    {
      const m =
        normalized.match(/\b(?:remember that|note that)\s+(.+)/i) ??
        normalized.match(/(?:记住|请注意)\s*(.+)/);
      if (m) {
        const content = m[1].replace(/[.。！!]\s*$/, "").trim();
        const slug = "user/" + this.hash(content);
        return [{
          slug,
          type: "user" as MemoryType,
          name: "Memory",
          description: content,
          content,
          createdAt: now,
          updatedAt: now,
        }];
      }
    }

    return [];
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
