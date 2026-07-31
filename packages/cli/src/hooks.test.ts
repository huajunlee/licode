import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "./hooks.js";

describe("createEventBus", () => {
  it("refreshes the token display from the calibrated count on agent-loop-complete", () => {
    const setTokenCount = vi.fn();
    const setContextWindow = vi.fn();
    const bus = createEventBus(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      setTokenCount,
      () => 1337,
      setContextWindow,
      () => 200000
    );

    bus.emit({
      type: "agent-loop-complete",
      message: "done",
      usage: { input: 10, output: 5 },
    });

    // The status bar should show the conversation's calibrated token count,
    // not the stale 0 left by the dead tokenCountingMiddleware.
    expect(setTokenCount).toHaveBeenCalledWith(1337);
    // The context window is also refreshed so the percentage stays accurate.
    expect(setContextWindow).toHaveBeenCalledWith(200000);
  });

  it("surfaces a compression notice on context-compressed", () => {
    const setCommandMessage = vi.fn();
    const setTokenCount = vi.fn();
    const setContextWindow = vi.fn();
    const bus = createEventBus(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      setTokenCount,
      () => 42,
      setContextWindow,
      () => 50000,
      setCommandMessage
    );

    bus.emit({ type: "context-compressed", method: "summarize", removedMessages: 7 });

    expect(setCommandMessage).toHaveBeenCalledWith(
      expect.stringContaining("7")
    );
    expect(setCommandMessage).toHaveBeenCalledWith(
      expect.stringContaining("摘要")
    );
    // Status bar refreshed with the post-compression count.
    expect(setTokenCount).toHaveBeenCalledWith(42);
    expect(setContextWindow).toHaveBeenCalledWith(50000);
  });
});
