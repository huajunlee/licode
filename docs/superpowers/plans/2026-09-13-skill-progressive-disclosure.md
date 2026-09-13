# Skill 渐进式披露 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 LICode 的 skill 机制从"启动即把正文整体注入 system prompt"改成**渐进披露**：启动只放一行行书目（name + description），正文由模型按需用 Read 读取、脚本用 Bash 执行。

**Architecture:** `SkillLoader` 改认 Claude 的 `SKILL.md` 格式，`Skill` 收窄为 `{name, description, dir}`（**正文不进内存**）；`adapter` 用新增的 `skillsToPromptLayer(skills, root)` 产出**单个常驻书目层**，替换原来的"每技能一个正文层 + 每个工具一个 `skill__` 工具"。不新增任何工具——读取走现成的 `Read`，执行走现成的 `Bash`。

**Tech Stack:** TypeScript（ESM，Node ≥20）、vitest、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-13-skill-progressive-disclosure-design.md`

## Global Constraints

- **跑任何测试前，必须先在 worktree 里执行 `pnpm install --frozen-lockfile`。** git worktree 不携带 `node_modules`，不装会报 `Cannot find package 'js-yaml'`。
- 测试命令：`npx vitest run <路径>`；全量 `pnpm test`。构建命令：`pnpm -r build`（每个任务结束都必须构建无错）。
- skill 文件名固定 `SKILL.md`（大写）；书目层的 `name` 固定为字符串 `"skills"`。
- frontmatter 契约同 Claude：`name` 与 `description` 必填；其余字段**容忍并忽略**（不报错）。
- 不新增任何工具；不实现 skill→skill 引用。
- **不动** `decide` / `profile_recall`（下一轮）。
- 沿用现有风格：中文注释、`.js` 后缀 import、双引号、`zod` 定义参数。

## 基线（动手前必读）

1. **`packages/core/src/extensions/startup.test.ts` 在改动前就有 1 个失败**：用例 `loads MCP tools, skill tools, prompt layers, ...` 断言工具列表含 `mcp__mock__echo`，但测试把 MCP 配置写在 `<ws>/.licode/mcp.json`（测试 45-56 行），而代码读 `<ws>/.licode/mcp/config.json`（`startup.ts:76`），所以 mock server 从未加载。
   **这是既有缺陷，不在本计划范围内——不要顺手修它。** 本计划只负责让该用例里 **skill 相关**的断言与新行为一致；每个任务跑完，该文件应仍**只有这一个**失败。
2. `packages/core/src/extensions/skills/` 下三个测试文件（`loader/adapter/parser`）改动前**全绿**。

---

## File Structure

| 文件 | 职责 | 本计划动作 |
|---|---|---|
| `packages/core/src/extensions/skills/parser.ts` | 解析 `SKILL.md` 的 YAML frontmatter | 收窄：删 `SkillToolDef` / `skillParamsToZod` |
| `packages/core/src/extensions/skills/loader.ts` | 扫描目录产出 `Skill[]` | 改认 `SKILL.md`；`Skill` 收窄为 `{name, description, dir}` |
| `packages/core/src/extensions/skills/adapter.ts` | `Skill[]` → system prompt 层 | 新增 `skillsToPromptLayer`；删 `skillToPromptLayer` / `skillToolToAdapter` |
| `packages/core/src/extensions/startup.ts` | 启动装配 | 改用单个书目层；不再注册 skill 工具 |
| `packages/core/src/index.ts` | 包出口 | 同步增删导出 |
| `packages/cli/src/hooks.ts` | CLI 斜杠命令 | **不改**（`/技能名` 沿用；`s.description` 变成真简介，展示更准） |
| `docs/guide/user-guide.md`、`README.md` | 文档 | 更新 §14 与相关行 |

---

### Task 1: loader 认 `SKILL.md`，`Skill` 收窄，移除 skill 工具注册

把"技能正文整体注入 + 脚本登记成工具"这条旧路拆掉，换成"只读 name/description"。

**Files:**
- Modify: `packages/core/src/extensions/skills/loader.ts`
- Modify: `packages/core/src/extensions/skills/loader.test.ts`
- Modify: `packages/core/src/extensions/skills/adapter.ts`（只改 import 行）
- Modify: `packages/core/src/extensions/skills/adapter.test.ts`（修 `Skill` 字面量）
- Modify: `packages/core/src/extensions/startup.ts`（移除 tools 注册）
- Modify: `packages/core/src/extensions/startup.test.ts`（改 fixture 与断言）

**Interfaces:**
- Produces: `export interface Skill { name: string; description: string; dir: string }`
- Produces: `SkillLoader.loadFromDir(dir: string): Promise<Skill[]>`；`SkillLoader.loadAll(userDir?: string, projectDir?: string): Promise<Skill[]>`
- Consumes: `parseYamlFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string }`（本任务不改 parser）

- [ ] **Step 1: 重写 `loader.test.ts` 为新契约**

整体替换 `packages/core/src/extensions/skills/loader.test.ts`：

```ts
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SkillLoader } from "./loader.js";

describe("SkillLoader", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licode-skill-test-"));

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSkillDir(baseDir: string, name: string, content: string): string {
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content);
    return dir;
  }

  it("从 SKILL.md 读取 name 与 description，正文不进 Skill 对象", async () => {
    const dir = createSkillDir(
      tmpDir,
      "web-access",
      [
        "---",
        "name: web-access",
        "description: 搜索网页时使用",
        "---",
        "# Web Access",
        "",
        "这段正文不应出现在 Skill 对象里。",
      ].join("\n")
    );

    const skills = await new SkillLoader().loadFromDir(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: "web-access",
      description: "搜索网页时使用",
      dir,
    });
  });

  it("缺 description 的技能被跳过", async () => {
    createSkillDir(tmpDir, "no-desc", "---\nname: no-desc\n---\nbody");
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("缺 name 的技能被跳过", async () => {
    createSkillDir(tmpDir, "no-name", "---\ndescription: 只有描述\n---\nbody");
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("不认小写的 skill.md（旧格式）", async () => {
    const dir = path.join(tmpDir, "legacy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "skill.md"),
      "---\nname: legacy\ndescription: 旧格式\n---\nbody"
    );
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("目录里没有 SKILL.md 时跳过", async () => {
    const dir = path.join(tmpDir, "empty");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a skill");
    expect(await new SkillLoader().loadFromDir(tmpDir)).toEqual([]);
  });

  it("loadAll 同扫用户与项目目录，同名以项目为准", async () => {
    const userDir = path.join(tmpDir, "user-skills");
    const projectDir = path.join(tmpDir, "project-skills");
    createSkillDir(userDir, "my-skill", "---\nname: my-skill\ndescription: 用户版\n---\nb");
    createSkillDir(projectDir, "my-skill", "---\nname: my-skill\ndescription: 项目版\n---\nb");
    createSkillDir(projectDir, "only-project", "---\nname: only-project\ndescription: 仅项目\n---\nb");

    const skills = await new SkillLoader().loadAll(userDir, projectDir);
    const byName = new Map(skills.map((s) => [s.name, s]));

    expect(skills).toHaveLength(2);
    expect(byName.get("my-skill")?.description).toBe("项目版");
    expect(byName.get("only-project")?.description).toBe("仅项目");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run packages/core/src/extensions/skills/loader.test.ts`
Expected: FAIL —— 报 `Cannot find package` 之类的路径错 **或** 断言失败（旧 loader 读的是小写 `skill.md`，且 `Skill` 含 `version`/`tools`）。

> 若报 `Cannot find package 'js-yaml'`，说明还没装依赖 —— 回 Global Constraints 执行 `pnpm install --frozen-lockfile`。

- [ ] **Step 3: 改 `loader.ts`**

整体替换 `packages/core/src/extensions/skills/loader.ts`：

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { parseYamlFrontmatter } from "./parser.js";

export interface Skill {
  name: string;
  description: string;
  dir: string;
}

export class SkillLoader {
  async loadAll(userDir?: string, projectDir?: string): Promise<Skill[]> {
    const userSkills = userDir ? await this.loadFromDir(userDir) : [];
    const projectSkills = projectDir ? await this.loadFromDir(projectDir) : [];

    // Project-level skills override user-level skills with the same name
    const byName = new Map<string, Skill>();
    for (const skill of userSkills) {
      byName.set(skill.name, skill);
    }
    for (const skill of projectSkills) {
      byName.set(skill.name, skill);
    }

    return [...byName.values()];
  }

  async loadFromDir(dir: string): Promise<Skill[]> {
    if (!fs.existsSync(dir)) return [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = await this.loadSkill(path.join(dir, entry.name));
      if (skill) skills.push(skill);
    }

    return skills;
  }

  private async loadSkill(skillDir: string): Promise<Skill | null> {
    const defPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(defPath)) return null;

    const raw = await fs.promises.readFile(defPath, "utf-8");
    const { frontmatter } = parseYamlFrontmatter(raw);

    // 契约同 Claude 的 SKILL.md：name 与 description 必填，缺任一则跳过该技能
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) return null;

    // 正文刻意不读进内存：模型需要时自行 Read SKILL.md（渐进披露）
    return { name, description, dir: skillDir };
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run packages/core/src/extensions/skills/loader.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 修下游编译错（adapter 的 import 与测试字面量）**

`Skill` 不再有 `version`/`tools`，且 `loader.ts` 不再转发 `SkillToolDef`。两处要改：

`packages/core/src/extensions/skills/adapter.ts` 第 4 行：

```ts
// 改前
import type { Skill, SkillToolDef } from "./loader.js";
// 改后
import type { Skill } from "./loader.js";
import type { SkillToolDef } from "./parser.js";
```

`packages/core/src/extensions/skills/adapter.test.ts` 第 6 行同样拆分；并把 `skillToPromptLayer` 用例里的字面量（约 95-101 行）去掉 `version`/`tools`：

```ts
    const skill: Skill = {
      name: "web-access",
      description: "# Web Access\n\nUse this skill to search the web.",
      dir: "/tmp/web-access",
    };
```

（该用例断言 `layer.content === skill.description`，仍然成立，不用改断言。）

- [ ] **Step 6: 改 `startup.ts`，移除 skill 工具注册**

`packages/core/src/extensions/startup.ts` 第 19 行的 import 改为只引 `skillToPromptLayer`：

```ts
import { skillToPromptLayer } from "./skills/adapter.js";
```

第 84-89 行的循环改为（**本任务仍保留"每技能一层"，Task 2 再合并成书目层**）：

```ts
  for (const skill of skills) {
    options.systemPrompt.addLayer(skillToPromptLayer(skill));
  }
```

- [ ] **Step 7: 改 `startup.test.ts` 的 fixture 与断言**

`packages/core/src/extensions/startup.test.ts`：

(a) 把 skill fixture 从 `skill.md` + `tools` 改成 `SKILL.md` + `name/description`。原 57-75 行的两次写文件改为：

```ts
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: hello",
        "description: 打招呼时使用",
        "---",
        "这是技能正文。",
      ].join("\n")
    );
```

（删掉原 `writeFileSync(path.join(skillDir, "greet.js"), ...)` 那一行。）

(b) 工具断言（原 108-110 行）去掉 `"skill__greet"`：

```ts
    expect(tools.list()).toEqual(
      expect.arrayContaining(["builtin", "mcp__mock__echo"])
    );
```

(c) 层断言（原 111-113 行）保持不变（层名此时仍是 `skill:hello`）：

```ts
    expect(systemPrompt.getLayers().map((layer) => layer.name)).toContain(
      "skill:hello"
    );
```

- [ ] **Step 8: 跑 skill 与 startup 测试**

Run: `npx vitest run packages/core/src/extensions/skills/ packages/core/src/extensions/startup.test.ts`
Expected: skills 三个文件全 PASS；`startup.test.ts` **仍只有 1 个失败**（`mcp__mock__echo`，见基线，非本任务引入），且失败信息里**不再出现** `skill__greet`。

- [ ] **Step 9: 构建**

Run: `pnpm -r build`
Expected: 无 TypeScript 错误。

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/extensions/skills/ packages/core/src/extensions/startup.ts packages/core/src/extensions/startup.test.ts
git commit -m "refactor(skills): loader 改认 SKILL.md，Skill 收窄为 name/description/dir，移除 skill 工具注册"
```

---

### Task 2: 书目层 —— `skillsToPromptLayer`

把 N 个"只有一行的小层"合成**一个带"怎么读"指引的常驻书目层**，这是渐进披露的关键一步。

**Files:**
- Modify: `packages/core/src/extensions/skills/adapter.ts`
- Modify: `packages/core/src/extensions/skills/adapter.test.ts`
- Modify: `packages/core/src/extensions/startup.ts`
- Modify: `packages/core/src/extensions/startup.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Skill`（Task 1 定义）
- Produces: `skillsToPromptLayer(skills: Skill[], skillsRoot: string): SystemPromptLayer | null`

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/extensions/skills/adapter.test.ts` 末尾追加：

```ts
import { skillsToPromptLayer } from "./adapter.js";

describe("skillsToPromptLayer", () => {
  const skills: Skill[] = [
    { name: "decision", description: "帮用户做决定时使用", dir: "/p/decision" },
    { name: "people", description: "查询人物档案时使用", dir: "/p/people" },
  ];

  it("把多个技能合成一个常驻书目层", () => {
    const layer = skillsToPromptLayer(skills, "/proj/.licode/skills");

    expect(layer).not.toBeNull();
    expect(layer!.name).toBe("skills");
    expect(layer!.priority).toBe(15);
    expect(layer!.always).toBe(true);
    expect(layer!.content).toContain("- decision：帮用户做决定时使用");
    expect(layer!.content).toContain("- people：查询人物档案时使用");
    expect(layer!.content).toContain("/proj/.licode/skills");
  });

  it("书目层不含正文（正文只在磁盘上）", () => {
    const layer = skillsToPromptLayer(skills, "/proj/.licode/skills");
    // 传进来的 Skill 根本没有正文字段，层里自然不该有
    expect(layer!.content).not.toContain("SKILL.md 的正文");
    expect(layer!.content.length).toBeLessThan(500);
  });

  it("没有技能时返回 null，不添加空层", () => {
    expect(skillsToPromptLayer([], "/proj/.licode/skills")).toBeNull();
  });
});
```

并把该文件首行的 import 补上 `skillsToPromptLayer`（与现有 import 合并即可）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run packages/core/src/extensions/skills/adapter.test.ts`
Expected: FAIL —— `skillsToPromptLayer is not a function`。

- [ ] **Step 3: 实现 `skillsToPromptLayer`**

在 `packages/core/src/extensions/skills/adapter.ts` 的 `skillToPromptLayer` **下方**追加：

```ts
/**
 * 把所有技能合成**一个**常驻书目层：只有 name + description + 取用指引。
 * 正文不进 system prompt，模型需要时用 Read 读 SKILL.md、用 Bash 跑 scripts/。
 * 无技能时返回 null（调用方据此跳过 addLayer）。
 */
export function skillsToPromptLayer(
  skills: Skill[],
  skillsRoot: string
): SystemPromptLayer | null {
  if (skills.length === 0) return null;

  const lines = [
    "## 可用技能",
    "",
    `技能位于 \`${skillsRoot}\` 下，每个技能一个目录，内含 SKILL.md。`,
    "当任务与某个技能的描述相符时，用 Read 读取它的 SKILL.md 全文；",
    "技能目录内的附件用 Read 读取，`scripts/` 里的脚本用 Bash 执行。",
    "",
    ...skills.map((s) => `- ${s.name}：${s.description}`),
  ];

  return {
    name: "skills",
    priority: 15,
    always: true,
    content: lines.join("\n"),
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run packages/core/src/extensions/skills/adapter.test.ts`
Expected: PASS

- [ ] **Step 5: `startup.ts` 改用书目层**

`packages/core/src/extensions/startup.ts` 第 19 行 import 改为：

```ts
import { skillToPromptLayer, skillsToPromptLayer } from "./skills/adapter.js";
```

（`skillToPromptLayer` 此时已无人用，但要等 Task 3 才删。仓库未开 `noUnusedLocals`（`tsconfig.base.json` 只有 `strict: true`），所以留着这个多余 import **不会**让构建失败。）

把 Task 1 Step 6 写下的那个循环（原 84-89 行附近）替换为：

```ts
  const skillsRoot = resolveProjectPath(options.workingDirectory, "skills");
  const skills = await skillLoader.loadAll(
    options.userSkillsDirectory,
    skillsRoot
  );
  const skillLayer = skillsToPromptLayer(skills, skillsRoot);
  if (skillLayer) options.systemPrompt.addLayer(skillLayer);
```

注意：`loadAll` 的第二个参数由原来的 `resolveProjectPath(...)` 内联调用换成复用的 `skillsRoot`。

- [ ] **Step 6: `startup.test.ts` 改层断言**

把 Task 1 Step 7(c) 留下的层断言改为：

```ts
    const skillLayer = systemPrompt
      .getLayers()
      .find((layer) => layer.name === "skills");
    expect(skillLayer).toBeDefined();
    expect(skillLayer!.always).toBe(true);
    expect(skillLayer!.content).toContain("- hello：打招呼时使用");
    expect(skillLayer!.content).not.toContain("这是技能正文");
```

- [ ] **Step 7: `index.ts` 增导出**

`packages/core/src/index.ts` 第 73 行附近：

```ts
export { skillToPromptLayer, skillsToPromptLayer } from "./extensions/skills/adapter.js";
```

- [ ] **Step 8: 跑测试**

Run: `npx vitest run packages/core/src/extensions/skills/ packages/core/src/extensions/startup.test.ts`
Expected: skills 全 PASS；`startup.test.ts` 仍只有 `mcp__mock__echo` 一个失败。

- [ ] **Step 9: 构建**

Run: `pnpm -r build`
Expected: 无错误。

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/extensions/skills/ packages/core/src/extensions/startup.ts packages/core/src/extensions/startup.test.ts packages/core/src/index.ts
git commit -m "feat(skills): 单个常驻书目层 skillsToPromptLayer，正文按需 Read"
```

---

### Task 3: 清理死代码

`skillToPromptLayer` / `skillToolToAdapter` / `skillParamsToZod` / `SkillToolDef` 至此全部无人使用，删掉。

**Files:**
- Modify: `packages/core/src/extensions/skills/adapter.ts`
- Modify: `packages/core/src/extensions/skills/adapter.test.ts`
- Modify: `packages/core/src/extensions/skills/parser.ts`
- Modify: `packages/core/src/extensions/skills/parser.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `parseYamlFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string }`（`SkillFrontmatter` 收窄为 `{ name?: string; description?: string; [key: string]: unknown }`）
- Removes: `skillToPromptLayer`、`skillToolToAdapter`、`skillParamsToZod`、`SkillToolDef`

- [ ] **Step 1: 删 `adapter.ts` 的旧函数**

删除 `packages/core/src/extensions/skills/adapter.ts` 中的：`spawnScript` 函数、`skillToolToAdapter` 函数、`skillToPromptLayer` 函数。删完后该文件应只剩 `skillsToPromptLayer` 及其 import：

```ts
import type { Skill } from "./loader.js";
import type { SystemPromptLayer } from "../../conversation/system-prompt.js";
```

（同步删掉不再需要的 `child_process`、`node:path`、`Tool`/`ToolResult`、`skillParamsToZod`、`SkillToolDef` 的 import。）

- [ ] **Step 2: 删 `adapter.test.ts` 的旧用例**

删除 `packages/core/src/extensions/skills/adapter.test.ts` 里 `describe("skillToolToAdapter", ...)` 与 `describe("skillToPromptLayer", ...)` 两个整块，以及顶部的 `child_process`/`fs`/`path`/`os` 等因此不再使用的 import。删完后该文件只保留 `describe("skillsToPromptLayer", ...)`。

- [ ] **Step 3: 收窄 `parser.ts`**

`packages/core/src/extensions/skills/parser.ts`：删除 `SkillToolDef` 接口与 `skillParamsToZod` 函数，并删掉 `import { z, ZodTypeAny } from "zod";`。`SkillFrontmatter` 收窄为：

```ts
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  [key: string]: unknown;
}
```

`parseYamlFrontmatter` 函数体保持原样不动。

- [ ] **Step 4: 删 `parser.test.ts` 的旧用例**

删除 `packages/core/src/extensions/skills/parser.test.ts` 里 `describe("skillParamsToZod", ...)` 整块，以及首行 import 中的 `skillParamsToZod`。

- [ ] **Step 5: 清 `index.ts` 导出**

`packages/core/src/index.ts` 第 72-74 行改为：

```ts
export type { Skill } from "./extensions/skills/loader.js";
export { skillsToPromptLayer } from "./extensions/skills/adapter.js";
export { parseYamlFrontmatter } from "./extensions/skills/parser.js";
```

- [ ] **Step 6: 全局确认无残留引用**

Run: `grep -rn "skillToolToAdapter\|skillToPromptLayer\|skillParamsToZod\|SkillToolDef" packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v /dist/`
Expected: **无输出**。

- [ ] **Step 7: 跑测试与构建**

Run: `npx vitest run packages/core/src/extensions/skills/ packages/core/src/extensions/startup.test.ts && pnpm -r build`
Expected: skills 全 PASS；`startup.test.ts` 仍只有 `mcp__mock__echo` 一个失败；构建无错。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/extensions/skills/ packages/core/src/index.ts
git commit -m "refactor(skills): 删除 skillToolToAdapter/skillParamsToZod 等旧适配器"
```

---

### Task 4: 端到端验证（走真实装配路径）

单测证明函数对，但**装配路径**是否真的产出书目层、正文是否真的留在磁盘上，要黑盒验一遍。

**Files:**
- Create: `packages/core/src/extensions/skills/progressive-disclosure.test.ts`

**Interfaces:**
- Consumes: `initializeExtensions(options)`（`startup.ts`）、`SystemPrompt`、`ToolRegistry`、`CommandRouter`

- [ ] **Step 1: 写端到端测试**

新建 `packages/core/src/extensions/skills/progressive-disclosure.test.ts`：

```ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeExtensions } from "../startup.js";
import { SystemPrompt } from "../../conversation/system-prompt.js";
import { ToolRegistry } from "../../tools/registry.js";
import { CommandRouter } from "../commands/router.js";

const BODY = "这是正文：B 式给倾向建议，C 式只摆事实。";

describe("Skill 渐进式披露（端到端）", () => {
  let workspace: string | null = null;

  afterEach(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
      workspace = null;
    }
  });

  it("只把书目放进 system prompt，正文留在磁盘、脚本不登记为工具", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "licode-skill-pd-"));
    const skillDir = path.join(workspace, ".licode", "skills", "decision");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: decision",
        "description: 帮用户做决定时使用",
        "---",
        BODY,
      ].join("\n")
    );

    const systemPrompt = new SystemPrompt();
    const tools = new ToolRegistry();
    const extensions = await initializeExtensions({
      workingDirectory: workspace,
      toolRegistry: tools,
      systemPrompt,
      commandRouter: new CommandRouter(),
    });

    // 1) 书目层存在、常驻、含名字与描述
    const layer = systemPrompt.getLayers().find((l) => l.name === "skills");
    expect(layer).toBeDefined();
    expect(layer!.always).toBe(true);
    expect(layer!.content).toContain("- decision：帮用户做决定时使用");

    // 2) 书目告诉模型技能在哪个目录（模型据此 Read）
    expect(layer!.content).toContain(
      path.join(workspace, ".licode", "skills")
    );

    // 3) 正文没有进 system prompt
    expect(layer!.content).not.toContain(BODY);

    // 4) 正文确实在磁盘上、模型读得到
    expect(readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")).toContain(BODY);

    // 5) 不再把技能脚本登记成 skill__ 工具
    expect(tools.list().filter((n) => n.startsWith("skill__"))).toEqual([]);

    await extensions.shutdown();
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run packages/core/src/extensions/skills/progressive-disclosure.test.ts`
Expected: PASS

- [ ] **Step 3: 真机黑盒（可选，但推荐）**

在 worktree 里放一个真技能，用真实 CLI 装配路径打印 system prompt，肉眼确认只有书目：

```bash
mkdir -p .licode/skills/demo && cat > .licode/skills/demo/SKILL.md <<'EOF'
---
name: demo
description: 演示技能，仅用于验证
---
这是 demo 的正文，不应出现在 system prompt 里。
EOF
npx tsx -e '
import { initializeConversationRuntime } from "./packages/cli/src/cli.js";
const rt = await initializeConversationRuntime({ cwd: process.cwd(), apiKey: "dummy" });
console.log(rt.manager.systemPrompt.assemble(Infinity));
'
```

Expected: 输出里有 `## 可用技能` 与 `- demo：演示技能，仅用于验证`；**没有**"这是 demo 的正文"。

验证完删掉 demo 目录：`rm -rf .licode/skills/demo`

- [ ] **Step 4: 跑全量测试，确认无新增失败**

Run: `pnpm test 2>&1 | tail -20`
Expected: 唯一失败仍是 `startup.test.ts` 的 `mcp__mock__echo`（基线既有）；其余无新增失败。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/extensions/skills/progressive-disclosure.test.ts
git commit -m "test(skills): 端到端验证书目层常驻、正文留在磁盘、脚本不入工具表"
```

---

### Task 5: 文档同步

改完机制，user-guide §14 与 README 的描述就过时了，一并对齐（**外科手术式**：只改与 skill 机制相关的行，不动其它）。

**Files:**
- Modify: `docs/guide/user-guide.md`（§14 及第 689 行）
- Modify: `README.md`（第 21、125 行）

- [ ] **Step 1: 重写 user-guide §14**

把 `docs/guide/user-guide.md` 第 797-823 行（`### 14. Skills 系统` 整节）替换为：

````markdown
### 14. Skills 系统

用户和项目可以自定义技能包，存放在 `.licode/skills/` 目录下。格式与 Claude Code 的 Skill 一致：

```
.licode/skills/
  └── my-skill/
      ├── SKILL.md          ← frontmatter（name + description 必填）+ 正文
      ├── reference.md      ← 可选：按需读取的参考文档
      └── scripts/
          └── deploy.sh     ← 可选：按需执行的脚本
```

```markdown
---
name: my-skill
description: 部署到测试环境时使用
---

# 部署流程

（正文：模型需要时才读进来）
```

**加载流程（渐进披露）：**
1. SkillLoader 扫描项目目录 `.licode/skills/`（`userSkillsDirectory` 设计上支持，但当前 CLI 未传入，故只扫项目目录）
2. 项目级 skill 覆盖用户级同名 skill
3. 只有 **name + description** 被注入为一个常驻系统提示词层（层名 `skills`，priority 15，`always: true`）——即"书目"
4. **正文不注入**：模型判断任务与某技能描述相符时，用 Read 读它的 `SKILL.md` 全文；附件用 Read 读，`scripts/` 里的脚本用 Bash 执行
5. 缺 `name` 或 `description` 的技能被跳过；小写的 `skill.md`（旧格式）不再加载

**与旧版的差别**：旧版把技能正文整体注入 system prompt，并把脚本登记成 `skill__{toolName}` 工具；新版正文按需读、脚本走 Bash——因此脚本现在会经过权限守卫（旧版直接 spawn，绕过权限）。
````

- [ ] **Step 2: 改 user-guide 的系统层表**

第 689 行：

```
  15    skills（技能描述）   按需      用户/项目配置
```

改为：

```
  15    skills（书目：name+description） always  项目配置（正文按需 Read）
```

- [ ] **Step 3: 改 README**

第 21 行表格里含 `Skills 技能包` 的单元格，保持不变（表述仍成立）。

第 125 行：

```
| **Skills 技能包** | `.licode/skills/` 自定义领域专长 + 专属工具 |
```

改为：

```
| **Skills 技能包** | `.licode/skills/` 自定义领域专长，渐进披露：启动只载 `name`+`description` 书目，正文按需 Read、脚本走 Bash |
```

- [ ] **Step 4: 核验文档与代码一致**

Run: `grep -rn "skill.md\|skill__\|版本版\|skillToolToAdapter" docs/guide/user-guide.md README.md`
Expected: **无输出**（旧机制的字样已清除；注意别误改其它同名字段——若命中的是与 skill 无关的行，保留并在提交信息里说明）。

- [ ] **Step 5: 提交**

```bash
git add docs/guide/user-guide.md README.md
git commit -m "docs: user-guide §14 与 README 同步 skill 渐进披露机制"
```

---

## 自审记录

**Spec 覆盖**
- §4.1 加载什么/落在哪 → Task 2（书目层）+ Task 4（端到端断言）
- §4.2 认 Claude `SKILL.md` → Task 1
- §4.3 书目层 always:true → Task 2
- §4.4 不新增工具 → Task 1（移除工具注册）+ Task 4 断言 5
- §4.5 保留 `/技能名` → 明确不改 `hooks.ts`
- §4.6 容错（缺字段跳过、旧格式不加载）→ Task 1 测试
- §4.7 安全收益 → Task 5 文档说明
- §5 改动清单 → 已补上 spec 遗漏的 `packages/core/src/index.ts`
- §6 验证 → Task 4

**占位符扫描**：无 TBD/TODO；每个代码步骤都给了可粘贴的完整代码。

**类型一致性**：`Skill` 全程为 `{name, description, dir}`；`skillsToPromptLayer` 在两处签名一致；层名全程 `"skills"`。
