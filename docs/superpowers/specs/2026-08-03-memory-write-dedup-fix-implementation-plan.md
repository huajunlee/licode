# Memory Write-Dedup Instruction Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the agent from `Read`-ing irrelevant existing memories when asked to remember a brand-new topic, by fixing the write-dedup instruction in `memory-guide.md`.

**Architecture:** Single-file prose edit to the memory-guide template. Replace the unconditional "Read before create" bullet with a conditional "check the index; Read+update only on a same-topic match; otherwise Write directly" bullet, plus a bullet forbidding reading old memories as format templates. A content-assertion test guards the wording; behavioral verification is manual replay. Zero `.ts` logic change.

**Tech Stack:** TypeScript, vitest, markdown template loaded at runtime via `loadDefaultLayers` (`packages/core/src/conversation/system-prompt.ts`).

## Global Constraints

- 零代码逻辑改动：只改 `packages/core/src/conversation/templates/memory-guide.md` 的措辞，不碰任何 `.ts` 逻辑文件。
- 测试用 vitest，co-located `.test.ts`，显式 `import { describe, it, expect } from "vitest"`，`node:` 前缀的内置模块。
- 模板分隔符为全角中文标点；第 48 行 "是否存在" 与 "更新它" 之间是**两个 em-dash（U+2014 U+2014，渲染为 `--`）**，不是 ASCII 连字符。Edit 的 old_string 必须逐字节匹配。
- 不改召回系统（`recall.ts`）、不改 dream/curation、不加新工具、不动 MEMORY.md 索引格式或记忆 frontmatter 结构。
- 设计 spec：`docs/superpowers/specs/2026-08-03-memory-write-dedup-fix-design.md`。

---

## File Structure

- **Modify:** `packages/core/src/conversation/templates/memory-guide.md`（"如何保存" 小节，第 48 行那条 bullet）
- **Create:** `packages/core/src/conversation/memory-guide.test.ts`（断言模板内容，单一职责）

`memory-guide.md` 是运行时由 `loadDefaultLayers()` 读取并注入 system prompt 的 `memory-guide` 层（priority 4，optional）。它的措辞直接驱动主 Agent 写记忆时的工具调用决策。本次 bug 根因即其中一条 bullet 对"新主题"场景无合法目标，逼模型 `Read` 无关旧记忆。

现有 `system-prompt.test.ts` 用 tmpDir 测 `loadDefaultLayers` 的**加载机制**，不断言真实模板内容。本计划新增一个聚焦文件断言真实 `memory-guide.md` 的关键措辞，作为回归守卫。

---

## Task 1: 修复 memory-guide 写时查重指令（TDD）

**Files:**
- Create: `packages/core/src/conversation/memory-guide.test.ts`
- Modify: `packages/core/src/conversation/templates/memory-guide.md:48`

**Interfaces:**
- Consumes: 无（独立测试，读真实模板文件）
- Produces: `memory-guide.md` 第 48 行由单条 bullet 变为两条；`memory-guide.test.ts` 守卫其措辞

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/conversation/memory-guide.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const templatesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "templates"
);
const memoryGuidePath = path.join(templatesDir, "memory-guide.md");

describe("memory-guide.md write-dedup instruction", () => {
  const content = fs.readFileSync(memoryGuidePath, "utf-8");

  it("不再无条件要求'创建前先用 Read 查重'", () => {
    // 旧指令对新主题无合法目标，逼模型 Read 无关旧记忆（bug 根因）
    expect(content).not.toContain("先用 Read 检查同主题文件是否存在");
  });

  it("Read 条件化：有同主题才 Read 并更新，无则直接 Write 新文件", () => {
    expect(content).toContain("直接 Write 新文件");
    expect(content).toContain("不要 Read 任何不相关的旧记忆");
  });

  it("禁止把旧记忆当格式模板 Read", () => {
    expect(content).toContain("不要为看格式去 Read 旧记忆");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/core/src/conversation/memory-guide.test.ts`
Expected: FAIL。第一条 `not.toContain` 失败（旧措辞仍在），后两条 `toContain` 失败（新措辞尚未写入）。

- [ ] **Step 3: 编辑 memory-guide.md**

用 Edit 替换第 48 行。`old_string` 必须逐字节匹配（注意 "是否存在" 与 "更新它" 之间是两个 em-dash `--`）。

`old_string`（单条 bullet，精确匹配）：
```
- 创建前先用 Read 检查同主题文件是否存在--更新它，而非新建重复文件
```

`new_string`（两条 bullet）：
```
- 创建前先看索引（已注入上下文）判断有无同主题条目：有则 Read 该文件并更新；无则直接 Write 新文件，不要 Read 任何不相关的旧记忆
- 需要文件格式时参照上方 frontmatter 模板，不要为看格式去 Read 旧记忆
```

> 实现者注意：先 Read 该文件确认第 48 行的精确内容（em-dash 在某些编辑器里渲染与 ASCII 连字符相似），复制原文作为 `old_string`，不要手敲。

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/core/src/conversation/memory-guide.test.ts`
Expected: PASS，3 条用例全绿。

- [ ] **Step 5: 跑 conversation 全套，确认无回归**

Run: `npx vitest run packages/core/src/conversation/`
Expected: 全绿。`system-prompt.test.ts` 的 `loadDefaultLayers` 用 tmpDir、不依赖真实模板内容，不受影响；确认无意外连带失败。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/conversation/templates/memory-guide.md \
        packages/core/src/conversation/memory-guide.test.ts
git commit -m "fix(memory): 写时查重指令条件化，新主题直接 Write 不 Read 旧记忆

旧指令'创建前先用 Read 检查同主题文件是否存在'对新主题无合法目标，
弱模型会抓无关旧记忆（如番茄炒蛋）当目标。改为：看索引，有同主题才
Read+更新，无则直接 Write；并禁止把旧记忆当格式模板 Read。
加 memory-guide.test.ts 守卫措辞。"
```

---

## Task 2: 手动行为验证

**Files:** 无（验证步骤，不产生代码）

单元测试只守卫措辞存在，不证明模型行为改变。本任务手动回放确认 deepseek-chat 在新措辞下行为正确。

前置（重要）：`@licode/core` 的 `main` 是 `./dist/index.js`，`pnpm start`（`tsx packages/cli/bin/licode.ts`）经 workspace 解析后**从 dist 加载 core**，`loadDefaultLayers` 因此读 `dist/conversation/templates/memory-guide.md`。所以改完 src **必须先 `pnpm build`**（即 `pnpm -r build`，core 的 build 脚本 `tsc && cp -r src/conversation/templates dist/conversation/` 会把改后的模板拷到 dist）。注意 `pnpm dev`（`tsc --watch`）**不拷模板**，watch 模式下改 .md 不会生效。

单元测试不受影响：vitest 从 src 跑，`memory-guide.test.ts` 经 `import.meta.url` 读的是 `src/conversation/templates/memory-guide.md`，无需 build。

- [ ] **Step 0: 构建以同步模板到 dist**

Run: `pnpm build`
Expected: 成功。core 的 build 脚本把改后的 `src/conversation/templates/memory-guide.md` 拷到 `dist/conversation/templates/`。验证：`grep "直接 Write 新文件" dist/conversation/templates/memory-guide.md` 应命中。

- [ ] **Step 1: 新主题场景——首个工具调用应为 Write，不 Read**

在 `.licode/memory/` 确保有至少一条无关的 user 记忆（如 `favorite-dish-tomato-egg.md`，现状已有）。起一个新会话，发送：

```
记住我决定今年12月回趟家
```

Expected: 模型第一个工具调用是 `Write`（创建 `.licode/memory/project/return-home-dec-2026.md` 之类），**不**出现对 `favorite-dish-tomato-egg.md` 或任何其他旧记忆的 `Read`。

记录实际工具调用序列。若出现无关 Read，记录读了哪个文件，转入"残余风险"升级路径（见 spec）。

- [ ] **Step 2: 同主题场景——应先 Read 再 Write 更新**

同一会话或新会话，发送一条与已有 `favorite-dish-tomato-egg.md` 同主题的消息：

```
记住我其实更爱吃糖醋排骨
```

Expected: 模型先 `Read` `.licode/memory/user/favorite-dish-tomato-egg.md`，再 `Write` 更新该文件（改写内容为含糖醋排骨），**不**新建重复文件。

记录实际工具调用序列。

- [ ] **Step 3: 记录验证结果**

在 PR 描述或提交说明里记录两个场景的实际工具调用序列与结论（通过/失败）。无需提交代码。

若 Step 1 仍出现无关 Read：本次修复对 deepseek-chat 不足够，升级到 Approach B（加 `memory_save` 服务端查重工具，移除模型自主 Read 的 agency）——超出本计划范围，回到 brainstorming 重新设计。

---

## Self-Review

**1. Spec 覆盖：**
- 根因（`memory-guide.md:48` 两个缺陷）-> Task 1 Step 3 替换该行 ✓
- 方案 A2（条件化 + 堵"当模板读"）-> Task 1 Step 3 两条新 bullet ✓
- 成功标准（新主题首调用 Write / 同主题先 Read 再 Write）-> Task 2 Step 1-2 ✓
- 验证计划（手动回放为主）-> Task 2 ✓
- 残余风险与升级路径 -> Task 2 Step 3 ✓
- 不在范围内（不改召回/dream/curation/工具/索引格式）-> Global Constraints ✓

**2. 占位符扫描：** 无 TBD/TODO；测试代码完整；Edit 的 old/new_string 完整给出 ✓

**3. 类型一致性：** 无跨任务类型/签名依赖（单文件措辞改动）✓
