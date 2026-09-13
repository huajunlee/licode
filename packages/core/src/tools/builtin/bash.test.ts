import { describe, expect, it } from "vitest";
import { bashTool } from "./bash.js";

const ctx = { workingDirectory: process.cwd(), sessionId: "s" };

// 注意：失败时 Node 会把整条命令回显进错误信息，所以断言不能挑命令里出现过的字面量，
// 一律用「命令里没有、只有输出才会有的」标记（$((6*7)) -> 42）。
describe("bashTool 输出回报", () => {
  it("命令失败时保留 stdout，不只剩 stderr", async () => {
    // 模型常跑「一串诊断命令」，其中一条失败不该把成功的输出一起吞掉
    const r = await bashTool.execute(
      { command: "echo $((6*7)); ls /nonexistent-xyz-abc", timeout: 10000 },
      ctx
    );
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toContain("42");
      expect(r.error).toContain("No such file");
    }
  });

  it("失败时带上退出码", async () => {
    const r = await bashTool.execute({ command: "exit 3", timeout: 10000 }, ctx);
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error).toContain("退出码 3");
  });

  it("成功时 stderr 非空也带出来", async () => {
    const r = await bashTool.execute(
      { command: "echo ok; echo $((6*7)) 1>&2", timeout: 10000 },
      ctx
    );
    expect(r.status).toBe("success");
    if (r.status === "success") {
      expect(r.content).toContain("ok");
      expect(r.content).toContain("42");
    }
  });

  it("成功且无 stderr 时 content 就是纯 stdout（不额外装饰）", async () => {
    const r = await bashTool.execute({ command: "printf hello", timeout: 10000 }, ctx);
    expect(r).toEqual({ status: "success", content: "hello" });
  });

  it("成功且完全无输出时给出 (no output)", async () => {
    const r = await bashTool.execute({ command: "true", timeout: 10000 }, ctx);
    expect(r).toEqual({ status: "success", content: "(no output)" });
  });
});
