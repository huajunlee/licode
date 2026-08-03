import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar } from "./status-bar.js";

describe("StatusBar token display", () => {
  it("shows percentage + absolute when contextWindow is known", () => {
    const { lastFrame } = render(
      <StatusBar model="m" tokens={24600} contextWindow={200000} sessionId="abcdefgh" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/12%/);
    expect(frame).toMatch(/24,600/);
  });

  it("shows only absolute tokens before the window is published (0)", () => {
    const { lastFrame } = render(
      <StatusBar model="m" tokens={500} contextWindow={0} sessionId="abcdefgh" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/%/);
    expect(frame).toMatch(/500/);
  });
});
