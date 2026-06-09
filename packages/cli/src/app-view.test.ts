import { describe, it, expect } from "vitest";
import { createAppViewState, appViewReducer } from "./app-view.js";

describe("app view state", () => {
  it("starts at welcome when no sessionId", () => {
    const state = createAppViewState();
    expect(state.view).toBe("welcome");
  });

  it("starts at chat when sessionId is provided", () => {
    const state = createAppViewState("abc-123");
    expect(state.view).toBe("chat");
  });

  it("transitions from welcome to chat on enter-chat", () => {
    const state = createAppViewState();
    const next = appViewReducer(state, "enter-chat");
    expect(next.view).toBe("chat");
  });

  it("go-back from chat returns to welcome", () => {
    const next = appViewReducer({ view: "chat" }, "go-back");
    expect(next.view).toBe("welcome");
  });

  it("go-back from welcome is a no-op", () => {
    const next = appViewReducer({ view: "welcome" }, "go-back");
    expect(next.view).toBe("welcome");
  });

  it("enter-chat from chat stays in chat", () => {
    const next = appViewReducer({ view: "chat" }, "enter-chat");
    expect(next.view).toBe("chat");
  });
});
