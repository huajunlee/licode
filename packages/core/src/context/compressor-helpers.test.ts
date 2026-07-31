import { describe, expect, it } from "vitest";
import type { Message } from "../llm/provider.js";
import {
  SUMMARY_PREFIX,
  isSummaryMessage,
  extractExistingSummary,
  classifyMiddleTurns,
} from "./compressor.js";

const ts = () => new Date().toISOString();
const U = (c: string): Message => ({ role: "user", content: c, timestamp: ts() });
const A = (c: string): Message => ({ role: "assistant", content: c, timestamp: ts() });
const aT = (id: string, name: string, input: Record<string, unknown>): Message => ({
  role: "assistant", content: [{ id, name, input }], timestamp: ts(),
});
const uR = (id: string, content: string, isError = false): Message => ({
  role: "user", content: [{ tool_use_id: id, content, is_error: isError }], timestamp: ts(),
});

describe("summary detection", () => {
  it("detects and extracts the existing rolling summary text", () => {
    const msg: Message = { role: "assistant", content: `${SUMMARY_PREFIX}prior work`, timestamp: ts() };
    expect(isSummaryMessage(msg)).toBe(true);
    expect(isSummaryMessage(A("not a summary"))).toBe(false);
    expect(extractExistingSummary([U("x"), msg, A("y")])).toBe("prior work");
    expect(extractExistingSummary([U("x"), A("y")])).toBeNull();
  });
});

describe("classifyMiddleTurns", () => {
  it("marks error turns must-keep-error, write turns must-keep-write, others candidate", () => {
    const turns = [
      [U("t1"), aT("e1", "read", {}), uR("e1", "boom", true), A("recovered")], // error
      [U("t2"), aT("w1", "Write", { file_path: "a.ts", content: "x" }), uR("w1", "ok")], // write
      [U("t3"), A("plain")], // candidate
    ];
    const c = classifyMiddleTurns(turns, { selectiveRetention: true });
    expect(c[0].kind).toBe("must-keep-error");
    expect(c[1].kind).toBe("must-keep-write");
    expect(c[1].alreadyCompacted).toBe(false);
    expect(c[2].kind).toBe("candidate");
    expect(c.every((x) => x.complete)).toBe(true);
  });

  it("treats turns not starting with a user-text message as fold (orphan run-0 tail)", () => {
    const c = classifyMiddleTurns([[A("orphan")]], { selectiveRetention: true });
    expect(c[0].kind).toBe("fold");
    expect(c[0].complete).toBe(false);
  });

  it("with selectiveRetention off, everything is a candidate", () => {
    const turns = [[U("t1"), aT("w1", "Write", { file_path: "a", content: "x" }), uR("w1", "ok")]];
    const c = classifyMiddleTurns(turns, { selectiveRetention: false });
    expect(c[0].kind).toBe("candidate");
  });
});
