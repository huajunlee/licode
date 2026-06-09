import type { Message } from "./provider.js";

const EN_CHARS_PER_TOKEN = 4;
const ZH_CHARS_PER_TOKEN = 1.5;

/**
 * Heuristic token estimator — Phase 1 uses character-ratio approximation.
 * Phase 4 replaces this with a precise tokenizer (e.g., tiktoken).
 */
export class TokenCounter {
  estimate(text: string): number {
    let chineseChars = 0;
    let otherChars = 0;

    for (const ch of text) {
      if (/[一-鿿㐀-䶿]/.test(ch)) {
        chineseChars++;
      } else {
        otherChars++;
      }
    }

    return Math.ceil(
      chineseChars / ZH_CHARS_PER_TOKEN + otherChars / EN_CHARS_PER_TOKEN
    );
  }

  estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimate(msg.content);
    }
    return total;
  }
}
