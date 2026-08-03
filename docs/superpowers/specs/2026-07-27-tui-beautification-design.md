# TUI 美化（极简现代方向）— 设计文档

**日期**: 2026-07-27（2026-08-02 修订）
**状态**: 已确认（修订中）
**范围**: LICode CLI 前端（`packages/cli`）视觉重设计 — 主题系统、ASCII Art 横幅、Markdown 渲染、欢迎屏、对话屏

---

## 0. 背景与已确认决策

用户反馈当前 TUI "太丑"。经头脑风暴确认的问题（按优先级）：

- **布局与信息密度** — 会话列表是文本墙；帮助文本冗长常驻；状态栏是笨重的大边框盒子
- **消息呈现** — 用户/助手消息无层次区分；助手输出没有 Markdown 渲染（标题、列表、代码块全是原始字符）
- **品牌与第一印象** — 欢迎屏只有一行粗体文字，无视觉焦点

已确认决策：

| 决策点 | 结论 |
|---|---|
| 技术栈 | 留在 Ink v5，不迁移 OpenTUI |
| 风格方向 | **A · 极简现代**（Claude Code / Linear 式审美：单 accent + 灰阶层级，几何符号替代 emoji） |
| Logo | **纯文本 ASCII Art 横幅**，类似 Spring Boot 启动时控制台打印的 banner |
| 测试方式 | **TDD** — 先写失败测试用例，再写实现（RED → GREEN → REFACTOR） |

**非目标（YAGNI）：** OpenTUI 迁移；代码块语法高亮；Markdown 表格渲染；主题切换/用户自定义主题；鼠标支持与滚动区。

---

## 1. 架构与改动范围

改动集中在 `packages/cli`。`@licode/core` 唯一改动是**纯增量**的：`ConversationManager.listSessions()` 返回值新增可选 `summary` 字段（会话首条 string 类型 user 消息的摘要，供会话列表在标题缺失时展示；不改变任何现有行为）。

```
packages/cli/src/
├── theme.ts                    # 重写：真彩色调色板 + 几何图标集 + 排版规范
├── banner.ts                   # 新增：ASCII Art 资产（纯字符串常量）
├── components/
│   ├── markdown.ts             # 新增纯函数：marked tokens → 渲染视图模型
│   ├── markdown-text.tsx       # 新增组件：视图模型 → Ink 元素树
│   ├── relative-time.ts        # 新增纯函数：ISO 时间 → 中文相对时间
│   ├── session-row.ts          # 新增纯函数：会话 → 单行格式化（含截断/对齐）
│   ├── session-list.tsx        # 重写渲染（逻辑 hook use-session-selector 不动）
│   ├── chat-view.tsx           # 重写：用户/助手消息分层 + Markdown
│   ├── stream-renderer.tsx     # 流式输出走 Markdown 渲染
│   ├── tool-call-card.tsx      # 大圆角卡片 → 单行状态行
│   ├── status-bar.tsx          # 盒子 → 分割线 + 单行
│   ├── thinking-accordion.tsx  # 去 emoji，图标统一
│   ├── input-box.tsx           # 提示行压缩，样式统一
│   └── welcome-input.tsx       # 提示符/占位符统一
└── app.tsx                     # 欢迎屏布局重排（接入 banner）
```

```
packages/core/src/conversation/manager.ts   # listSessions 返回新增 summary?: string（增量）
```

**新增依赖：** `marked`（仅 `packages/cli`）。只用其 `lexer()` 做 Markdown 解析，渲染层自研（Ink 原生元素，不走 ANSI 字符串）。

---

## 2. 主题系统（theme.ts 重写）

### 2.1 调色板

真彩色 hex 值；Ink v5 经 chalk 按终端能力自动降级（truecolor → 256 → 16 色），无需手工兜底。

```ts
export const COLORS = {
  accent: "#E5A567",   // 暖琥珀：提示符 ❯、选中项、内联代码、运行中状态、banner
  text:   "#C8CCD8",   // 主文本
  muted:  "#8A8F9E",   // 次级文本：标签、工具详情、摘要
  faint:  "#565B68",   // 最弱：帮助行、分割线、会话 id、状态栏
  success:"#9ECE6A",   // 工具完成 ●、✓
  warning:"#E0AF68",   // 命令消息
  error:  "#F7768E",   // 错误、失败工具 ✗
} as const;
```

### 2.2 图标集（全部替换 emoji）

```ts
export const ICONS = {
  prompt: "❯",        // 输入提示符、选中光标、用户消息前缀
  assistant: "◆",     // 助手轮次开头标记
  toolDone: "●",
  toolRunning: "◐",
  toolPending: "○",
  toolError: "✗",
  inlineOk: "✓",
  expand: "▸",        // thinking 手风琴聚焦标记
  newSession: "＋",    // 全角加号，与中文等宽对齐
  codeBorder: "│",    // 代码块左边线（faint 色）
  separator: "─",     // 分割线单元
  spinnerFrames: [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏],  // 沿用现有 braille 帧
} as const;
```

**被移除的 emoji：** 🆕 🤔 ⏳ 📖 🔍 ✏️ ⚙（thinking 目的标签改纯文字："读取代码 / 搜索代码库 / 编辑文件 / 分析逻辑 / 思考中"）。

### 2.3 排版规范

Ink 无字号概念，排版层级靠三件套表达：**bold > 常规 > faint/muted**。标题用 bold，正文用 text，辅助信息用 muted/faint；同一行不超过 2 个层级。

---

## 3. ASCII Art 横幅（banner.ts）

Spring Boot 风格：启动（欢迎屏）时顶部打印的纯 ASCII 艺术字，accent 色；下方一行 faint 色标语 + 版本。

```
 _      ___   ____           _
| |    |_ _| / ___|___    __| | ___
| |     | | | |   / _ \  / _` |/ _ \
| |___  | | | |__| (_) || (_| |  __/
|_____|___| \____\___/  \__,_|\___|
  终端里的 AI 编程伙伴 · v0.1.0
```

约束（有测试保证）：

- 仅 ASCII 可打印字符（码点 ≤ 127），无 emoji、无 Unicode 方块/制表符
- 所有行等宽，且 ≤ 60 列（窄终端安全）
- 固定 5 行艺术字；banner 只在欢迎屏出现，对话屏不重复打印

---

## 4. Markdown 渲染（markdown.ts + markdown-text.tsx）

### 4.1 数据流

```
Message.content (string)
  → marked.lexer()                    // 容错：未闭合代码块按 CommonMark 规则延伸到文末
  → buildViewModel(tokens)            // 纯函数：tokens → 视图模型（行/缩进/行内样式段）
  → <MarkdownText>                    // 视图模型 → Ink 元素树（颜色取自 theme）
  → 任何异常 → fallback 为原始纯文本 <Text>
```

### 4.2 v1 支持的语法子集

| 语法 | 渲染 |
|---|---|
| `#` 标题 | bold + accent |
| `##` 标题 | bold + accent，下方一行 faint `────` |
| `###` 及以下 | bold + text 色 |
| `-` `*` 无序列表 | `•` + 2 空格缩进，嵌套每层 +2 |
| `1.` 有序列表 | 保留编号 + 2 空格缩进 |
| `` `内联代码` `` | accent 色 |
| ` ``` ` 代码块 | 每行 faint `│ ` 前缀；首行 `┌ ` + 语言名（muted）；**不做语法高亮** |
| `**粗体**` `*斜体*` | Ink bold / italic |
| `[文本](url)` | 文本 + 空格 + faint 色 url |
| `> 引用` | muted 色 + `│ ` 前缀 |
| `---` 分隔线 | faint `────`（固定 40 列） |
| 表格 / 图片 | 按原始文本行透传（非目标） |

### 4.3 流式渲染

`stream-renderer.tsx` 对每个流式快照整体走 Markdown 渲染，末尾追加闪烁的 accent `█` 光标（沿用现有 500ms 闪烁逻辑）。

---

## 5. 欢迎屏（app.tsx + banner + session-list + welcome-input）

```
 _      ___   ____           _
| |    |_ _| / ___|___    __| | ___
| |     | | | |   / _ \  / _` |/ _ \
| |___  | | | |__| (_) || (_| |  __/
|_____|___| \____\___/  \__,_|\___|
  终端里的 AI 编程伙伴 · v0.1.0

  最近会话
  ❯ ＋ 新建会话
    a3f9c21e   修复登录 bug                  12 条 · 3 天前
    b7e2d408   重构 auth 模块                 3 条 · 5 天前
    c91fa556   添加单元测试                  47 条 · 昨天
    … 还有 4 个会话

  ↑↓ 选择 · enter 进入 · ctrl+n 新建 · --session <id> 恢复

❯ --session <id> 或直接 Enter
```

行为规则：

- **会话行**（`session-row.ts` 纯函数）：`id`（faint，前 8 位）+ 标题 + 右对齐的 `N 条 · 相对时间`（faint）。标题缺失时取会话首条 user 消息摘要（去换行，按显示宽度截断至 24 列，CJK 计 2 列，超出加 `…`）。行总宽 = 终端列宽 - 边距，标题过长时末尾截断加 `…`
- **相对时间**（`relative-time.ts`）：< 1 分钟"刚刚"；< 60 分钟"N 分钟前"；< 24 小时"N 小时前"；< 30 天"N 天前"；否则 `YYYY/M/D`
- 列表不再显示 model（保留在对话屏状态栏）
- 帮助文本压缩为一行（faint）；**删除**常驻的"📖 新用户指南"行
- 输入提示符 `❯` accent 色，占位符 muted
- 上下截断提示沿用现状（"… 上方还有 N 个会话"），颜色改 faint
- `use-session-selector` hook 逻辑不动

---

## 6. 对话屏（chat-view / tool-call-card / status-bar / thinking-accordion / input-box）

```
❯ 帮我修复 login 的 bug

◆ 先读 login.ts，确认 verifyToken() 的调用链，再看
  middleware 怎么处理过期 token。

  分析
  ────
  • 读取 login.ts
  • 检查 auth middleware
  • 定位过期逻辑

  ┌ auth.ts
  │ export function verifyToken(t: string) {
  │   return jwt.verify(t, SECRET);
  │ }

  ● Read      src/login.ts        ✓
  ● Grep      verifyToken         ✓ 12 处匹配
  ◐ Edit      src/auth.ts         运行中 ⠋

❯ ▍
enter 发送 · / 命令 · ctrl+q 返回
──────────────────────────────────────────────
deepseek-v4-pro · 1,234 tok · a3f9c21e
```

### 6.1 消息分层（chat-view.tsx）

- **用户消息**：accent `❯` 前缀 + text 色正文，不加额外缩进
- **助手消息**：首行 accent `◆` 开头，正文经 Markdown 渲染、整体缩进 2 列
- 工具结果消息（tool result）不再以 `✓/✗ + 截断100字符` 的原始形式出现在消息流中——工具结果由 ToolCallCards 区域承载；chat-view 过滤 `role === "system"` 的现有逻辑保留，tool_result 消息跳过渲染
- 助手 tool_use 消息（历史回看时）：渲染为单行 muted `● 调用工具: name1, name2`，替代现有 `[调用工具: names]`
- 空会话占位改为 `开始对话…`（faint）

### 6.2 工具调用（tool-call-card.tsx）

大圆角边框卡片 → **单行状态行**：

```
<状态图标> <工具名 bold>  <详情 muted，截断>  <结果摘要 muted，仅 done>
```

- `done`：单行，`●` success 色 + 结果摘要内联截断（40 列，CJK 计 2 列）
- `running`：单行，`◐` accent 色 + braille spinner
- `pending`：单行，`○` muted
- `error`：`✗` error 色，错误详情在下一行缩进展开（保留现有 truncate 逻辑，上限 200 字符）

### 6.3 Thinking 手风琴（thinking-accordion.tsx）

- 图标去 emoji：聚焦 `▸`（accent），非聚焦 faint
- 目的标签纯文字（见 §2.2）
- 流式中显示 `思考中…` + braille spinner 帧，替代 `🤔 正在推理中... ⏳`
- 展开/聚焦交互逻辑不动

### 6.4 状态栏（status-bar.tsx）

边框盒子 → 两行：faint 分割线（`─` × 终端列宽减边距）+ 单行信息 `model · N tok · sessionId`（全 faint）。快捷键说明不再出现在状态栏（输入框提示行已覆盖，且随上下文变化）。

### 6.5 输入区（input-box.tsx）

- 提示行压缩：`enter 发送 · / 命令 · ctrl+q 返回`（faint，一行）
- 建议面板打开时：`tab 补全 · ↑↓ 选择 · enter 发送`
- 建议面板边框去掉，改为选中行 accent `❯` 前缀 + 非选中行缩进，与全局极简风格一致
- loading 时 `⏳` 替换为 braille spinner 帧

---

## 7. 兼容性与错误处理

| 场景 | 行为 |
|---|---|
| 终端不支持真彩色 | chalk 自动降级到 256/16 色，不报错 |
| `marked.lexer()` 抛异常 | markdown-text 捕获并 fallback 渲染原始纯文本 |
| 窄终端（< 80 列） | `useStdout()` 读列宽：会话行标题截断；状态栏缩为 `model · tok`（< 60 列）；banner ≤ 60 列天然安全 |
| 会话无标题且无消息 | 摘要显示 `（无消息）`（faint） |
| 流式中文本残缺（未闭合代码块/行内码） | CommonMark 容错：未闭合 fence 延伸到文末；未闭合行内码按普通文本 |

---

## 8. 测试策略（TDD）

**流程纪律：每个单元先写失败测试（RED）→ 最小实现通过（GREEN）→ 重构。** 实现时调用 `test-driven-development` 技能。延续项目现有模式：只测纯函数，不引入组件测试库。

新增/更新的测试用例（先写这些测试，再写实现）：

| 测试文件 | 用例 |
|---|---|
| `theme.test.ts`（更新） | 调色板值快照；每个 ICON 不含被移除的 emoji 字符（⏳🤔🆕📖🔍✏⚙）、不含 ≥ U+1F000 码点、不含变体选择符 FE0F |
| `banner.test.ts`（新增） | 5 行；每行等宽且 ≤ 60 列；全部字符码点 ≤ 127 |
| `markdown.test.ts`（新增） | `#`/`##`/`###` 标题层级；无序/有序/嵌套列表缩进；内联代码 → accent 段；代码块 → `│` 前缀行 + 语言标签；**未闭合代码块**仍渲染为代码块；`**bold**`；`[t](u)` → 文本 + url 段；`> 引用`；`---`；表格按原文透传；空串/纯文本透传 |
| `relative-time.test.ts`（新增） | 刚刚 / N 分钟前 / N 小时前 / N 天前 / 绝对日期 的边界值 |
| `session-row.test.ts`（新增） | 有标题用标题；无标题用 summary 并截断；无标题且无 summary 显示"（无消息）"；行总宽 == 终端列宽 - 边距；右列右对齐 |
| `manager.test.ts`（core，更新） | `listSessions` 返回的 `summary` 取首条 string 内容的 user 消息（去换行、截断）；无 user 消息时 `summary` 为 `undefined` |
| `status-bar` 纯函数测试（新增） | 宽格式 `model · N tok · id`；窄格式（< 60 列）`model · tok`；`formatTokens` 千分位（沿用） |
| `tool-call-card` 纯函数测试（更新） | 单行格式按状态组合（图标 + 名称 + 截断详情 + 结果摘要） |

`app-view` 状态机、`history-navigator`、`use-session-selector`、`waiting-indicator`（纯函数部分）的既有测试不受影响，需保持全绿。

**验收标准：**

- `pnpm test` 全绿（含上表全部新用例）
- `packages/cli/src` 中 grep 不到被移除的 emoji
- 手工验证：iTerm2 / Terminal.app / VS Code 集成终端下两屏渲染正常（含 16 色降级）
- 视觉效果与 §5、§6 的 mockup 一致


---

## 9. 修订记录（2026-08-02：合并 master + 重新裁定）

本 spec 初版（2026-07-27）基于当时的 master。此后 master 前进 126 commit，新增第二大脑日记系统（`packages/core/src/diary/`）、decide 工具、memory/context 改造。原 spec 未考虑日记系统。

**已执行**：master 合并进 `worktree-tui-beautification`（merge commit `938cc2c`，无冲突）。worktree 现同时拥有 v2 美化底座 + master 全部新功能。

**重新裁定的任务状态**（对照旧计划）：

| 旧 Task | 状态 | 依据 |
|---|---|---|
| 0 marked 依赖 | ✅ 已提交 | `marked ^18.0.7` |
| 1 主题 v2 | ✅ 已提交 | theme.test 5 绿 |
| 2 banner | ✅ 已提交 | banner.test 5 绿 |
| 3 markdown 视图模型 | ✅ 已提交 | markdown.test 18 绿 |
| 4 MarkdownText 渲染器 | ✅ 已提交 | tsc 绿 |
| 5 relative-time | 🟡 半完成 | 测试已写（未跟踪，TDD-RED），缺 `relative-time.ts` 实现 |
| 6 core summary | ❌ 未做 | master 的 "summary" 只是 `getStats()` 注释，`listSessions` 无 `summary?` 字段 |
| 7–15 | ❌ 未做 | 仍 v1 风格 |
| 新增 A 基线 | — | merge 已解决 dream-indicator 缺失；剩"补 Task 5 实现"。`startup.test.ts` 的 MCP mock 失败是 master 既有/环境依赖，与本计划无关、不阻断 |
| 新增 B `/diary` 切换 | ❌ 未做 | 日记系统已在（merge 带来），见 §11 |

**基线**：`pnpm build` 仅因未跟踪的 `relative-time.test.ts` 红（Task 5 完成即绿）；`pnpm test` 615 绿 / 1 红（`startup.test.ts` MCP mock，既有不阻断）。

本次修订新增设计：§10（Enter 选中）、§11（`/diary` 风格切换）。原 §1–§8 仍然有效。

---

## 10. 建议面板 Enter 选中（优先级 #1）

### 10.1 问题
`input-box.tsx`：输入以 `/` 开头时弹出建议面板，`↑↓` 移动选中、`Tab` 补全，但 `Enter` 未被拦截，穿透到 `TextInput.onSubmit` → `handleSubmit` → 直接发送。提示文案"Enter 发送"。所以工具/skill 无法用 Enter 选中。

### 10.2 设计
面板打开时 `Enter` = 接受高亮项填入输入框 + 关闭面板 + **不发送**；再按 `Enter`（面板已关）才发送。

实现：在 `handleSubmit`（`input-box.tsx`）最前面加守卫：
```ts
if (showSuggestions && suggestions.length > 0) {
  completeSuggestion();   // 已有逻辑：setValue(选中名 + " ")
  return;                  // 不发送
}
```
- 单点修改，不动 `useInput`（避免与 TextInput 双重触发）。
- `completeSuggestion` 后值变 `/diary `（带尾空格）→ query 含空格 → 无匹配 → 面板自动关闭。
- 提示文案改为：`Enter 选中 · 再按 Enter 发送 · Tab 补全 · ↑↓ 选择`。

### 10.3 测试
抽纯函数 `shouldSelectSuggestion(value, suggestions): boolean` 单测：面板空 / 有项 / 已完整输入边界。

---

## 11. /diary 日记模式风格切换（优先级 #2）

### 11.1 现状与缺口
日记系统已在（merge 带来）：`/diary` 系列在 `packages/core/src/diary/dispatch.ts` 的 `handleDiaryInput` 早于路由拦截（`hooks.ts` handleSubmit 内）。生命周期：`/diary` 开启 → 后续纯文本捕获为片段 → `/diary-end` 关闭并由 side-model 抽取 `DiaryEntry` 存盘。

**缺口**：日记会话存于 `diarySessionRef`（`useRef`，`hooks.ts`），进/出不触发重渲染 → 整个 TUI 无"日记模式"观感，唯一反馈是一行 `commandMessage`。

### 11.2 风格：日记卡片边框（已确认）
进入日记模式时，ChatApp 用 `<DiaryPage>` **替换**正常 ChatView+indicators+InputBox 区域（日记页自带输入）：
```
┌ ✎ 日记 · 2026/8/2 ──────────────────┐   borderStyle="round"，标题=日期，diaryAccent
│ ✓ 已记下（继续描述，或 /diary-end）  │   commandMessage
│                                      │
│   今天完成了 LICode 日记系统对接，   │   diarySegments[].content（缩进 2）
│   和团队对齐了 second-brain 架构。   │
│                                      │
│ ✎ ▍                                  │   InputBox（diary 样式：✎ 提示符 + 日记 hint）
│ 口述经历 · /diary-end 结束 · Esc 取消│
└──────────────────────────────────────┘
```
退出（`/diary-end` → `diaryMode=false`）→ 恢复正常 ChatView。

### 11.3 状态提升（hooks.ts）
```ts
const [diaryMode, setDiaryMode] = useState(false);
const [diarySegments, setDiarySegments] = useState<DiarySegment[]>([]);
const [diaryDate, setDiaryDate] = useState("");
// 保留 diarySessionRef 给 dispatch（避免闭包陈旧），并行镜像到 state 给渲染
```
在 `handleDiaryInput` 返回非 null 分支（hooks.ts 约 623-648 行）：
- 进入（`nextSession` 非空且原不在模式）：`setDiaryMode(true); setDiarySegments([]); setDiaryDate(session.date)`
- 捕获（`nextSession` 非空且已在模式）：`setDiarySegments([...nextSession.segments])`
- 结束（`wasEnd`）：`setDiaryMode(false); setDiarySegments([]); setDiaryDate("")`

从 `useConversation` 暴露 `diaryMode/diarySegments/diaryDate`。

### 11.4 主题：新增 diaryAccent
```ts
diaryAccent: "#7DC9BF",  // 沉静青绿：日记/手账感，与琥珀 accent 明显区分
```
"明显"靠三件套：① 整屏 accent 换色（边框/标题/提示符/状态栏）② `✎` 替代 `❯`/`>` ③ 边框包裹成"日志页"。`StatusBar` 传 `diaryMode`，分割线改 `diaryAccent`。

### 11.5 边界
- 日记模式中 `Ctrl+Q`（返回）应同时退出日记模式。
- `Esc` 提示取消（若实现取消则走 `/diary-end`，否则仅提示）。
- 风格切换在 `/diary` **提交后**触发（会话建立），非输入字符时；切回 = `/diary-end`（`wasEnd`）。

### 11.6 测试
纯函数 `diaryStateReducer(input, prev)` 单测：`/diary` 进入、捕获片段、`/diary-end` 退出三态。`DiaryPage` 渲染层用 `pnpm build` + 既有测试全绿验证。

---

## 12. 测试策略补充（2026-08-02）

延续 §8 的 TDD 与"只测纯函数"原则。新增：
- `shouldSelectSuggestion`（§10）：面板空 / 有项 / 已完整输入。
- `diaryStateReducer`（§11）：进入 / 捕获 / 退出三态。
- `theme.test.ts` 追加：`diaryAccent` 存在且为 hex truecolor。


---

## 图标/emoji 决策补充（2026-08-02）

用户最终裁定：**保留 v2 几何图标集**（❯ ◆ ● ◐ ○ ✗ ✓ ▸ ＋ │ ─ ✎），**移除所有 emoji**（含 master 功能代码里的 🌙 ✨ 👤 ⚠️ 🤔，含 dingbat-emoji ✨）。此裁定覆盖之前"✨ 允许"的约束。Task 15 已据此执行（commit 5fb2d41）：移除 legacy 主题别名 + 清扫全部 emoji。packages/cli/src 现仅余 v2 几何图标，无任何 emoji。
