import type { Message, ToolUseBlock, ToolResultBlock } from "./provider.js";
import { TokenCalibrator } from "./token-calibrator.js";

const EN_CHARS_PER_TOKEN = 4;
const ZH_CHARS_PER_TOKEN = 1.5;
const SYMBOL_CHARS_PER_TOKEN = 2;

/**
 * Heuristic token estimator — Phase 1 uses character-ratio approximation.
 * Phase 4 replaces this with a precise tokenizer (e.g., tiktoken).
 */
export class TokenCounter {
  private calibrator = new TokenCalibrator();

  /** Correction ratio learned from real backend usage (1 = uncalibrated). */
  get ratio(): number {
    return this.calibrator.ratio;
  }

  /**
   * Feed a real token count (from usage.input_tokens) back into the
   * calibrator alongside the base estimate it was predicted from.
   */
  observe(baseEstimate: number, realTokens: number): void {
    this.calibrator.observe(baseEstimate, realTokens);
  }

  estimate(text: string): number {
    let chineseChars = 0;
    let alphaNumChars = 0;
    let symbolChars = 0;
    let whitespaceChars = 0;

    for (const ch of text) {
      if (/[一-鿿㐀-䶿]/.test(ch)) {
        chineseChars++;
      } else if (/[A-Za-z0-9]/.test(ch)) {
        alphaNumChars++;
      } else if (/\s/.test(ch)) {
        whitespaceChars++;
      } else {
        // Punctuation and other symbols tend to form their own tokens.
        symbolChars++;
      }
    }

    return Math.ceil(
      chineseChars / ZH_CHARS_PER_TOKEN +
        alphaNumChars / EN_CHARS_PER_TOKEN +
        symbolChars / SYMBOL_CHARS_PER_TOKEN +
        whitespaceChars / EN_CHARS_PER_TOKEN
    );
  }

  estimateMessages(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        total += this.estimate(msg.content);
      } else {
        // ToolUseMessage or ToolResultMessage: estimate the meaningful text of
        // each block (content for results, name+input for tool calls) rather
        // than the raw JSON, so opaque ids don't inflate the count.
        for (const block of msg.content) {
          total += this.estimate(this.blockText(block));
        }
      }
    }
    return total;
  }

  private blockText(block: ToolUseBlock | ToolResultBlock): string {
    // ToolResultBlock carries a string content; ToolUseBlock carries name+input.
    if ("content" in block) return block.content;
    return `${block.name}${JSON.stringify(block.input)}`;
  }
}
