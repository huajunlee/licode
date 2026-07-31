/**
 * Online calibrator for token estimates.
 *
 * Learns a correction ratio between a local base estimate and the real token
 * count reported by the backend (usage.input_tokens). The ratio absorbs
 * system-prompt + tool-definition + per-message structural overhead as a single
 * multiplier, so a messages-only base estimate can be scaled toward the true
 * full-request size. Backend-agnostic: works for Anthropic, DeepSeek, etc.
 */
export class TokenCalibrator {
  ratio = 1;
  private observed = false;

  observe(baseEstimate: number, realTokens: number): void {
    const sample = realTokens / baseEstimate;
    const next = this.observed ? 0.7 * this.ratio + 0.3 * sample : sample;
    this.ratio = Math.min(4, Math.max(0.5, next));
    this.observed = true;
  }
}
