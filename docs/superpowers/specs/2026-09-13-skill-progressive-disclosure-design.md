# Skill 渐进式披露设计（Progressive Disclosure for Skills）

- 日期：2026-09-13
- 范围：`packages/core`（`extensions/skills/`、`extensions/startup.ts`）+ `packages/cli`（技能斜杠命令展示）
- 状态：设计稿，待评审

## 1. 背景与动机

LICode 的 skill 机制目前把 skill 正文**急切注入** system prompt：`SkillLoader` 读 `skill.md`，把 body 当作 `description`，`skillToPromptLayer` 把整段 body 包成一个 SystemPromptLayer（priority 15、always false），启动时 `addLayer`（`startup.ts:79-89`）。

两个问题：

1. **浪费上下文，且可能反而不在**。skill 正文无论本轮用不用得上都进 system prompt；而它是**可裁剪层**（`always:false`），预算紧时会被整段砍掉--真正需要时反而没了。
2. **与业界做法不一致**。Claude Agent Skills 采用**渐进披露**：启动只预载 `name` + `description` 元数据（每个 skill 约 100 token），正文在模型判断相关时才按需读取，附件与脚本更靠后。

同时，LICode 的 skill 格式（frontmatter 的 `name`/`version`/`tools`，脚本登记为 `skill__xxx` 工具）与 Claude 的 `SKILL.md` 格式**不通用**，写一份不能两边用。

**本轮只修机制，不动 decide 与 profile_recall。** 把这两个工具改造成 skill 是下一轮的事；书架搭好并验证后再搬。

## 2. 目标与非目标

**目标**

1. 启动只加载 skill 的元数据（name + description），正文按需读取。
2. 采用 Claude 的 `SKILL.md` 格式，做到一份 skill 两边通用。
3. 脚本经既有 Bash 工具执行、附件经既有 Read 工具读取，**不新增任何工具**。

**非目标**

- 不迁移 decide / profile_recall（下一轮）。
- 不实现 skill 之间的引用/组合（官方亦无此机制）。
- 不实现"读完回收"（正文进对话历史后不主动卸载，与 Claude Code 行为一致）。

## 3. 现状（代码事实）

- **加载**：`SkillLoader.loadAll(userDir, projectDir)` 扫描每个子目录的 `skill.md`，解析 YAML frontmatter，body 当作 `description`，`tools[]` 作为工具声明（`loader.ts:16-65`）。
- **注入**：`skillToPromptLayer(skill)` 返回 `{name:"skill:<name>", priority:15, always:false, content:body}`（`adapter.ts:86-93`）。
- **工具**：frontmatter 的 `tools[]` 逐个 `skillToolToAdapter` 成 `skill__<name>`，执行时 spawn 脚本（`adapter.ts:48-84`）。
- **装配**：`initializeExtensions` 对每个 skill 调 `addLayer` + `registerAll(tools)`（`startup.ts:79-89`）。
- **落点**：system prompt 经 `buildMessages` 包成 `{role:"system"}`（`manager.ts:142-152`），再由 `extractSystem` 提到 API 顶层 `system` 字段（`anthropic.ts:158,196-201`）。
- **CLI**：已把 skill 注册成 `/技能名` 斜杠命令并展示其 `description`（`hooks.ts:545-574`）。

## 4. 设计

### 4.1 加载什么、落在哪

| 内容 | 何时加载 | 落在哪 |
|---|---|---|
| 书目（每 skill 一行：name + description + 目录约定） | 启动，常驻 | system prompt 的一个层（`always:true`） |
| `SKILL.md` 正文 | 模型判断相关时用 Read 读 | 对话历史里的 tool_result |
| 附件文件 | 需要时用 Read 读 | 对话历史里的 tool_result |
| 脚本 | 需要时用 Bash 跑 | 对话历史里的 tool_result（仅输出进上下文） |

**关键**：书目常驻 `system` 字段（每轮重发，但每 skill 仅一行）；正文读进对话历史后**不主动回收**，直到被压缩器处理--这与 Claude Code 一致。

### 4.2 格式：认 Claude 的 `SKILL.md`

- 文件名 `SKILL.md`；frontmatter **必须**有 `name` 与 `description`。
- body 即完整指令。
- 附件平铺在技能目录**根**（只许一层深，不套娃）。
- 脚本放 `scripts/`。
- 移除 LICode 旧字段 `version`、`tools`；移除 `skill__xxx` 工具注册。

### 4.3 书目层

启动时构建**一个**层（不再每技能一层）：

```
## 可用技能
技能位于 <cwd>/.licode/skills/ 下，每个技能一个目录，内含 SKILL.md。
当任务与某个技能描述相符时，用 Read 读取它的 SKILL.md 全文；
附件用 Read 读，脚本用 Bash 执行。
- <name>：<description>
```

设 `always:true`--丢书单等于模型不知道有技能，不能让它被预算裁掉。

注：`loadAll` 支持 user 目录，但 CLI 目前**不传** `userSkillsDirectory`（`cli.ts:187-192`），实践中只加载项目技能，故书目模板只声明项目根。若将来启用 user 目录，书目需逐条带上各自的实际目录。

### 4.4 模型如何取书

- 正文：`Read` → `<cwd>/.licode/skills/<name>/SKILL.md`
- 附件：`Read`
- 脚本：`Bash`

不新增任何工具。

### 4.5 触发

- 默认：模型按 description 自主判断是否读取。
- 保留现有 `/技能名` 斜杠命令（`hooks.ts:562-574`），不改。

### 4.6 容错

- 缺 `name`/`description` 的技能：**跳过**，不中断启动。
- 技能目录不存在：书目为空。
- 旧 `skill.md`（小写、带 `tools`）：不再加载。

### 4.7 安全收益（副产品）

脚本改走 Bash 后经过 `PermissionGuard`；现状 `skill__xxx` 是直接 spawn、**绕过权限**的。

## 5. 影响面（改动清单）

| 文件 | 改动 |
|---|---|
| `extensions/skills/loader.ts` | 认 `SKILL.md`；`Skill` 接口收窄为 `{name, description, dir}`--**正文不进内存**，需要时由模型自行 Read；不再解析 `tools` |
| `extensions/skills/parser.ts` | 收窄契约：name/description 必填；删除 `SkillToolDef`/`skillParamsToZod` |
| `extensions/skills/adapter.ts` | `skillToPromptLayer` 改为构建书目层；删除 `skillToolToAdapter` |
| `extensions/startup.ts` | 改为构建单个书目层；不再 `registerAll` skill 工具 |
| `cli/src/hooks.ts` | 斜杠命令展示沿用 `skill.description`（现在是简介，展示更准） |

## 6. 验证

- **单测**：解析器读得懂 Claude 格式；书目层**只含** name+description+目录约定，**不含**正文。
- **端到端**：放一个测试技能进 `.licode/skills/`，启动后确认 system 里只有书目；模型能自行 Read 出正文并执行脚本。

## 7. 未决 / 后续

- **下一轮**：把 decide、profile_recall 迁成 skill（需先回答"取证由谁做"）。
- 技能数量增多时书目层 token 线性增长，届时考虑分组或按 `paths` 条件加载。
