export interface TerminationConfig {
  maxSteps?: number;
  maxTokens?: number;
  maxTimeMs?: number;
}

export interface TerminationStats {
  steps: number;
  timeMs: number;
}

const DEFAULTS: Required<TerminationConfig> = {
  maxSteps: 50,
  maxTokens: 200_000,
  maxTimeMs: 600_000,
};

export class TerminationError extends Error {
  stats: TerminationStats;
  constructor(message: string, stats: TerminationStats) {
    super(message);
    this.name = "TerminationError";
    this.stats = stats;
  }
}

export class TerminationPolicy {
  private steps = 0;
  private readonly startTime: number;
  private readonly config: Required<TerminationConfig>;

  constructor(config: TerminationConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.startTime = Date.now();
  }

  check(currentTokens: number): void {
    const elapsed = Date.now() - this.startTime;
    const stats: TerminationStats = { steps: this.steps, timeMs: elapsed };

    if (this.steps >= this.config.maxSteps) {
      throw new TerminationError(
        `Reached max steps (${this.config.maxSteps}). Agent loop stopped.`,
        stats
      );
    }
    if (currentTokens >= this.config.maxTokens) {
      throw new TerminationError(
        `Token budget exhausted (${currentTokens}/${this.config.maxTokens}).`,
        stats
      );
    }
    if (elapsed >= this.config.maxTimeMs) {
      throw new TerminationError(
        `Agent loop timed out after ${Math.round(elapsed / 1000)}s.`,
        stats
      );
    }
  }

  incrementStep(): void {
    this.steps++;
  }

  getStats(): TerminationStats {
    return { steps: this.steps, timeMs: Date.now() - this.startTime };
  }
}
