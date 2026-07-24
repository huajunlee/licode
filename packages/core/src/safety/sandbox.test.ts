import { describe, expect, it } from "vitest";
import { createSandbox } from "./sandbox.js";

describe("createSandbox", () => {
  it("selects a macOS seatbelt sandbox and wraps commands with writable roots", () => {
    const sandbox = createSandbox({
      platform: "darwin",
      writableRoots: ["/tmp/project"],
    });

    const wrapped = sandbox?.wrapCommand("node script.js");

    expect(wrapped?.command).toBe("sandbox-exec");
    expect(wrapped?.args).toEqual(
      expect.arrayContaining([
        "-p",
        expect.stringContaining("(allow file-write* (subpath \"/tmp/project\"))"),
        "sh",
        "-lc",
        "node script.js",
      ])
    );
  });
});
