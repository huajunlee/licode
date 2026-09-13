import { bashTool } from "/Users/lixiaohua/Project/agent/LICode/.claude/worktrees/skill-progressive-disclosure/packages/core/dist/tools/builtin/index.js";

const ctx = { workingDirectory: "/Users/lixiaohua/.claude/jobs/2f01f74e/tmp/ws", sessionId: "s" };

// 记录第 5 条原样重放：一次跑一串诊断，最后一条失败
const rec5 = 'pwd; ls -la .licode 2>/dev/null; echo "---people---"; ls -la .licode/people 2>/dev/null; echo "---memory---"; ls -la .licode/memory 2>/dev/null';

for (const [name, cmd] of [
  ["记录第 5 条（原来只回一句 Command failed）", rec5],
  ["成功但 stderr 有警告", "echo 构建完成; echo 'warning: 3 deprecated deps' 1>&2"],
]) {
  const r = await bashTool.execute({ command: cmd, timeout: 10000 }, ctx);
  console.log(`=== ${name}`);
  console.log("status:", r.status);
  console.log(r.status === "success" ? r.content : r.error);
  console.log("");
}
