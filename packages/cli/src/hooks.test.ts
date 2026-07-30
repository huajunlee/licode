import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "./hooks.js";

describe("createEventBus", () => {
  it("refreshes the token display from the calibrated count on agent-loop-complete", () => {
    const setTokenCount = vi.fn();
    const bus = createEventBus(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      setTokenCount,
      () => 1337
    );

    bus.emit({
      type: "agent-loop-complete",
      message: "done",
      usage: { input: 10, output: 5 },
    });

    // The status bar should show the conversation's calibrated token count,
    // not the stale 0 left by the dead tokenCountingMiddleware.
    expect(setTokenCount).toHaveBeenCalledWith(1337);
  });
});
