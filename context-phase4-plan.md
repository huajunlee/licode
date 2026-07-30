# Phase 4 实现计划:工具输出溢出保护

> **状态**:计划冻结,待 TDD 实现
>
> **冻结日期**:2026-07-31(基于 worktree `context-management-improvement` commit `14ee6a5` 的代码快照)
>
> **上位文档**:[context-improvement-plan.md](./context-improvement-plan.md) Phase 4
>
> **说明**:Phase 1(校准式 token 计数)与 Phase 2+3(合并:预算感知 + 结构感知压缩替换硬停)已完成。本 Phase 接活休眠的 `overflowToolResult`,把大工具输出落盘 + 返回可恢复指针,让巨量内容永不进入会话。沿用 Phase 1/2 的"冻结事实 / 目标 / 边界 / 设计决策 / TDD 步骤 / 验收 / 风险"格式。

---

## 一、冻结事实(本 Phase 相关)

1. **`overflowToolResult`**(`context/overflow.ts:10`):死代码(仅 `index.ts:104` export + 单测)。content > `maxInlineBytes`(默认 64KB)时落盘到 `.licode/overflow/<ts>-<rand>.txt`,返回 `{status:"success", content: "Tool output exceeded inline limit. Full output written to <relativePath>.", metadata:{overflowPath}}`;≤limit 原样返回。**返回的是裸指针,无预览**。已有单测 `context.test.ts`(断言 `content` 含路径、文件全文 === 原内容)。
2. **`ToolExecutor.executeOne`**(`executor.ts:31`):`tool.execute(parsed.data, context)`(`:71`)后直接返回 ToolResult,**无溢出处理**。`executeParallel`(`:22`)= `Promise.all(executeOne)`。`executeOne` 内 `workingDirectory = options?.workingDirectory ?? process.cwd()`(`:55`);AgentLoop 调 `this.executor.executeParallel(response.toolUses)`(**不传 options**)-> workingDirectory 落到 `process.cwd()`。
3. **`ToolExecutorConfig`**(`executor.ts:12`):`{ permissionGuard?: ToolPermissionGuard }`,无溢出配置。AgentLoop 构造 `new ToolExecutor(config.tools)`(`loop.ts` 构造器),不传 config。
4. **`read.ts`**:**无上限**。整文件(或 `offset`/`limit` 切片)读出后带行号返回(`:31-42`),`content: formatted || "(empty file)"`。支持 `offset`/`limit` 分页。大文件直接灌爆上下文。
5. **`bash.ts`**:`maxBuffer: 10 * 1024 * 1024`(`:34`,10MB 硬上限,超则抛错);返回 `stdout || stderr || "(no output)"`(`:39-42`)。stdout 可达 10MB 全量入上下文。
6. **`grep.ts`**:**自带截断** `stdout.length > 10000 ? stdout.slice(0, 10000) + "\n... (truncated)" : stdout`(`:38-39`),有损、不可恢复。`maxBuffer: 10MB`(`:35`)。**无 grep 单测**。
7. **`addToolMessages`**(`manager.ts:64`):把 `r.content` 字符串塞进 `ToolResultBlock`(`tool_use_id` + `content` + `is_error`),**metadata 丢弃**。所以指针文本里必须含路径,模型靠文本取回。
8. **offload 模式参考**(`docs/clipboard/11-context-offload.md`):大结果落盘 + 返回 system-reminder 指针,提示"用 `read_file()` 取回"。正是 `overflowToolResult` 的设计意图。
9. **与 Phase 2 压缩的关系**:压缩在每轮 LLM 调用**前**对已入会话的消息做(`AgentLoop.run` while 循环);溢出在**工具执行时**发生(结果入会话前)。-> 巨量内容**永不进入会话**,压缩面对的本来就是更小会话。二者天然协同,无需特殊接线;溢出指针是轻量 tool_result,压缩时随所属轮次整体保留或摘要。
10. **`ContextConfig`**(`loop.ts`):已有 `outputReserve`/`compressThreshold`/`keepRecentTurns`/`summarizerModel`,可扩 `overflowMaxBytes`。
11. **`contextCommand`**(`extensions/commands/builtin/context.ts`):展示 Model/Tokens/Messages/Session/Window/Remaining/Memory。`context.workingDirectory` 可用。
12. **worktree 无 grep/executor 单测文件**--新增测试不冲突。

---

## 二、目标

- **G1 统一溢出接入**:`ToolExecutor` 对 `success` + string 大结果统一溢出--单条 > `overflowMaxBytes` 落盘到 `.licode/overflow/`,上下文仅留"指针 + 头部预览 + 行数 + 翻页提示"。
- **G2 指针可恢复**:模型经 `read`(用 `offset`/`limit` 翻页)取回溢出全文;不新增工具。
- **G3 grep 统一**:移除 grep 自带截断,走统一溢出(≤64KB 全显、>64KB 落盘可恢复)。
- **G4 可配**:`overflowMaxBytes` 默认 64KB,挂 `ContextConfig`,经 AgentLoop 传入 ToolExecutor。
- **G5 `/context`**:展示溢出文件数。
- **G6 零回归**:小输出直接内联;error 透传不溢出;零新依赖。

---

## 三、问题边界(范围)

**本 Phase 做**:
- 增强 `overflowToolResult`:返回指针 + 头部预览(前 ~50 行,字节封顶)+ 总行数 + 翻页提示。
- `ToolExecutor.executeOne` 包裹:`tool.execute` 后对 `success`+string 结果按 `overflowMaxBytes` 溢出。
- `ToolExecutorConfig` 增 `overflowMaxBytes`(默认 64KB);`ContextConfig` 增 `overflowMaxBytes`;AgentLoop 构造 executor 时传入。
- 移除 `grep.ts` 的 10000 字符截断。
- `contextCommand` 增溢出文件计数。

**本 Phase 不做(显式排除)**:
- ❌ 专用 `read_overflow` 工具--复用 `read`(已支持 offset/limit)。
- ❌ 溢出文件 GC/自动清理--transient,手动清(记为 caveat)。
- ❌ 结构化/索引化溢出--原始文本文件即可。
- ❌ 改 `bash` 的 `maxBuffer`(保留 10MB 硬上限作安全网)。
- ❌ 对 `error` 结果做溢出--错误通常很小,原样透传。
- ❌ Phase 5 滚动演化摘要。

---

## 四、设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| D1 接入点 | `ToolExecutor.executeOne` 包裹(`tool.execute` 后) | 一处接入、覆盖所有工具;小输出工具(edit/write/glob)检查即 no-op |
| D2 grep 截断 | 移除,走统一溢出 | 行为统一:≤64KB 全显(优于现在 10000 字符截断)、>64KB 可恢复落盘 |
| D3 指针内容 | 指针 + 头部预览(前 50 行,字节封顶 4096)+ 总行数 + "用 read offset/limit 翻页"提示 | 裸指针让模型盲;预览+行数助决策;翻页提示避免全量 read 再次灌爆 |
| D4 `overflowMaxBytes` | 默认 64KB,挂 `ContextConfig`,经 AgentLoop 传入 `ToolExecutorConfig` | 与现有默认一致;可调;复用 ContextConfig 通道 |
| D5 取回方式 | 复用 `read` 工具(读 `.licode/overflow/xxx.txt`,offset/limit 翻页) | 不新增工具;read 已支持分页 |
| D6 仅 success | 只对 `status:"success"` 的 string content 溢出;error 原样透传 | 错误通常很小 |
| D7 workingDirectory | `executeOne` 内 `options?.workingDirectory ?? process.cwd()`(同 ToolContext 现状) | 与 `.licode/` 落位一致;不改 AgentLoop 调用签名 |
| D8 bash maxBuffer | 保留 10MB 硬上限(安全网),64KB 软溢出 | 不改硬上限;软溢出保护上下文 |
| D9 溢出文件 | 原始全文落盘(无行号);指针预览带行号呈现 | 文件保真;预览可读;read 取回时再加分页行号 |

### 4.1 指针内容格式

```
Tool output exceeded inline limit ({{bytes}} bytes, {{lines}} lines). Full output written to {{relativePath}}.
First {{N}} lines:
{{head preview, 前 50 行, 字节封顶 ~4KB}}
... use Read with offset/limit on {{relativePath}} to page through the full output.
```

- `bytes` = `Buffer.byteLength(content)`;`lines` = `content.split("\n").length`。
- 预览 = 前 50 行;若合计字节 > 4096 则截到 4096 字节并附 `…`。
- 溢出文件 = 原始 `content` 全文(无修改)。

### 4.2 数据流(工具执行 -> 入会话)

```
ToolExecutor.executeOne:
  result = await tool.execute(...)
  if result.status==="success" && typeof result.content==="string"
        && Buffer.byteLength(result.content) > overflowMaxBytes:
    result = await overflowToolResult(result.content, {workingDirectory, maxInlineBytes: overflowMaxBytes})
        // 落盘 + 返回指针+预览(+metadata.overflowPath)
  return result
-> AgentLoop.addToolMessages(result)  // 只 content 入会话(指针+预览,小)
```

---

## 五、实现步骤(TDD 循环)

严格红-绿-重构。

```
=== A. overflowToolResult 增强(指针+预览) ===
Cycle 1  超限返回的 content 含头部预览(前 N 行)(红:现裸指针)
Cycle 2  content 含总行数与字节数(红)
Cycle 3  content 含翻页提示(提及 read + offset/limit + 路径)(红)
Cycle 4  预览字节封顶:超长行/巨量行不灌爆预览(红)
Cycle 5  小内容(≤limit)原样内联返回(回归)

=== B. ToolExecutor 包裹 ===
Cycle 6  ToolExecutorConfig.overflowMaxBytes(默认 64KB)
Cycle 7  executeOne: success+string 大结果 -> 溢出(返回指针+预览, metadata.overflowPath)(红)
Cycle 8  小 success 结果原样透传(回归)
Cycle 9  error 结果原样透传、不溢出(回归)
Cycle 10 非 string content(array 等)原样透传(边界)

=== C. grep 统一 ===
Cycle 11 移除 grep 10000 字符截断;大 grep 经执行器溢出(红:断言大 grep 返回指针+预览)

=== D. 配置链路 ===
Cycle 12 ContextConfig.overflowMaxBytes;AgentLoop 构造 ToolExecutor 时传入(红:小配置阈值下小输出也溢出)

=== E. /context 溢出计数 ===
Cycle 13 contextCommand 展示 .licode/overflow/ 文件数(红)

=== F. 收尾 ===
Cycle 14 全量 pnpm test + pnpm build,零回归
```

---

## 六、验收结论

- [ ] 单条工具输出 >64KB 落盘,上下文仅留指针+预览(Cycle 7 绿)
- [ ] 指针含头部预览 + 总行数/字节数 + 翻页提示(Cycle 1-3 绿)
- [ ] 预览字节封顶,巨长行不灌爆(Cycle 4 绿)
- [ ] 模型可经 `read`(offset/limit)取回溢出全文(手动验;文件全文 === 原输出)
- [ ] 小输出直接内联、零变化(Cycle 8 绿)
- [ ] error 结果透传不溢出(Cycle 9 绿)
- [ ] grep 移除截断、走统一溢出(Cycle 11 绿)
- [ ] `overflowMaxBytes` 可配,经 ContextConfig -> AgentLoop -> ToolExecutor 生效(Cycle 12 绿)
- [ ] `/context` 展示溢出文件数(Cycle 13 绿)
- [ ] 旧 `overflowToolResult` 单测仍绿(文件全文 === 原内容)
- [ ] `pnpm test` 全绿、`pnpm build` 零 TS 错、零新依赖

---

## 七、风险与 caveat

- **grep 无单测**:移除截断无测试要改;Cycle 11 顺手补一条大 grep 溢出测试。
- **预览字节封顶**:预览本身必须封顶(~4KB),否则单行极长(如 minified JS)仍会灌爆指针内容。Cycle 4 锁定。
- **溢出文件累积无 GC**:`.licode/overflow/` 会堆积,本 Phase 不清理(transient);后续可加按 session/时间的清理。手动 `rm .licode/overflow/*` 即可。
- **取回依赖模型主动分页**:提示引导用 `read` offset/limit,但不强制;模型若全量 read 大溢出文件仍会临时占上下文(下一轮压缩可兜底)。
- **workingDirectory 经 `process.cwd()`**:AgentLoop 不给 executor 传 options,溢出目录用 `process.cwd()`,与 `.licode/` 现状一致;若未来 AgentLoop 显式传 workingDirectory,溢出随之正确。
- **read 取回的行号**:溢出文件是原始全文(无行号),`read` 取回时加 `cat -n` 行号,与原工具输出(如 read 自带行号、grep 无行号)可能不一致--仅为取回可读性,不影响正确性。
