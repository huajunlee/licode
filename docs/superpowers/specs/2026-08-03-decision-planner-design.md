# 决策 Planner 设计（Decision Planner）

- 日期：2026-08-03
- 范围：`packages/core`（新增 `decide_plan` + `decide_reflect` 工具）+ `packages/cli`（TUI 计划/评估展开渲染）
- 状态：设计稿，待评审

## 1. 背景与动机

LICode 已实现 agent runtime、记忆系统、上下文管理、工具系统，但没有「先规划再执行」的机制。调研确认：

- 全仓不存在任何 plan/todo/breakdown 步骤；`decide` 工具是一次性上下文 dump，无规划、收集无方向。
- 主循环 temperature 未锁（跑在 API 默认 1.0），但这与本次设计无关--本设计不解决「跨次答案离散」，而是为复杂决策引入结构化规划能力。

**动机不是修复某个已观测的 bug**，而是：

1. 为项目增加一个非无用的能力--复杂决策的结构化规划、反思收敛与分步收集；
2. 学习 Planner 模式（TodoWrite 式：模型把计划作为结构化工具入参外部化）与 self-improvement loop（reflect-revise 直到收敛）。

Planner 不是每个 agent 架构的必备组件，只对长 horizon、多步、需承诺执行路径的任务有回报。LICode 主体是对话/记忆/日记/决策建议等短 reactive 交互，因此 Planner **条件触发**，只作用于复杂决策，不污染日常对话。

## 2. 选型

在三个候选方向中选 A：

- **A（采纳）Planner 化决策模块**：把 `decide` 升级出一条「先规划、反思收敛、再分步收集」的复杂路径，复用现有 decide.ts，是自然演进。
- B 深度研究 Planner：新能力，scope 更大，与 decide 有重叠。
- C 通用 TodoWrite 式任务规划：链路短且 reactive，触发频率低，最易「无用」。

A 搭建的 Planner 骨架未来可为 B 复用。

## 3. 整体架构

三层模型，复用现有 agent loop，**不新增执行引擎**：

```
用户决策请求
   │
   ├─ 简单 -> decide（≈现状，一次性 dump + 框架）-> 综合分析 -> decide_save
   │
   └─ 复杂 -> decide_plan（产出计划）⇄ decide_reflect（评估，最多 2 轮收敛）
                ↓ 评估通过或达上限后
        主 agent 内联执行 steps -> 综合分析 -> decide_save
```

核心约束：**Planner 不自己执行**。decide_plan 只注入计划、decide_reflect 只评估计划，二者都不执行步骤；执行仍由主 agent 在 loop 内调 recall/profile 完成。这复用了 agent loop 已有的「模型靠 tool result 决定下一步」机制，契合 LICode 链路短的实情。

### 3.1 P1：模型自写计划（TodoWrite 式）

`decide_plan` 的计划由**主模型在调用工具时直接作为结构化入参填写**，`execute()` 不做 side-call LLM。理由：

- 更简单，无 side-call、无额外延迟；
- 主模型有完整对话上下文 + 已注入记忆，写的计划比只看 topic 的 side-call 贴切；
- 与项目已收集的 TodoWrite 参考一致；
- `execute()` 轻量--工具的价值在「让计划成为可见、结构化、committed 的 artifact」，不在 execute 干活。

注：`decide_reflect` 的 execute **会**做 side-call LLM（见 5.2）--评估本身需要独立 LLM 视角，与 decide_plan 的「捕获模型计划」职责不同，二者不对称是合理的。

计划是**软承诺**（soft commitment）：指引模型后续工具调用，但不强制硬编排（与 TodoWrite 一致）。

## 4. `decide_plan` 工具

### 4.1 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `topic` | 是 | 决策话题关键词，用于 recall 匹配（同 `decide`，如「换工作」） |
| `question` | 是 | 完整决策问题/处境描述，是 `topic` 的详细补充（如「是否接受创业公司 X 的后端 offer，当前在 Y 公司稳定但天花板低」）。注：不叫 `decision`，避免与 `decide_save` 的 `decision`（最终结论）撞名 |
| `dimensions` | 是 | `{aspect, goal}[]`，每项 = 维度 + 具体评估目标（如 `{aspect:"成长", goal:"未来3年技术成长空间"}`），≥1 |
| `options` | 是 | `string[]`，可行选项，≥2 |
| `steps` | 是 | `string[]`，执行步骤，每步说明要召回/收集什么（如 `journal_recall("职业 历史")`），≥1 |
| `focus` | 否 | 升级或反思修订时，从上一轮分析/用户反馈/reflect 指出的 gaps 提炼的「需深挖的维度/遗漏」 |
| `people` | 否 | `{name, relation}[]`，相关人 + 关系（如 `{name:"张三", relation:"上级"}`），关系影响分析权重 |

### 4.2 execute() 行为

1. 校验：`dimensions` ≥1、`options` ≥2、`steps` ≥1，否则返回 `error`（`errorType: "validation"`）；
2. 把结构化入参渲染成计划 markdown（见 4.4）；
3. 返回 `{ status: "success", content: 计划文本, metadata: { dimensions: dimensions.length, options: options.length, steps: steps.length } }`（计数，同 `decide` 的 metadata 风格）；
4. 不做上下文收集、不做 side-call LLM--收集由后续按 `steps` 调用的 recall 工具完成。

### 4.3 综合分析指引

复杂路径不调用 `decide`，因此 `decide` 的 FRAMING（B/C 式 + 询问保存）不会自动注入。`decide_plan` 的 description 负责传达相同指引：执行完 `steps` 后按 B 式（2-3 路径 + 利弊 + 倾向建议）或 C 式（证据不足则摆事实、交还判断权）给出综合分析，并询问是否调用 `decide_save`。

可选优化（v1 不做）：将 FRAMING 抽为共享常量，由 `decide_plan` 的 execute 追加到计划末尾与 `decide` 复用。若 description 方式一致性不足再抽取。

### 4.4 计划 artifact 格式

```
# 决策计划：{topic}
## 决策问题
{question}
（若有 focus）## 本次重点
{focus}
## 维度
- {aspect1}：{goal1}
- {aspect2}：{goal2}
## 选项
1. {opt1}
2. {opt2}
## 相关人物
- {name1}（{relation1}）
## 执行步骤
1. {step1}
2. {step2}
```

### 4.5 注册

`packages/core/src/tools/builtin/index.ts` 的 `builtinTools` 数组加 `decidePlanTool` 并导出（同现有 decide/decide_save 模式）。

## 5. Reflection 循环（计划评估与收敛）

decide_plan 产出的计划不直接执行，先经 `decide_reflect` 评估，未通过则修订再评，直到通过或达 2 轮上限。这是 self-improvement loop：独立评估（side-call LLM，看不到主模型推理过程，无锚定偏见）挑出计划实质缺陷，主模型据此修订，计划质量有保证。

### 5.1 流程

```
decide_plan ──> decide_reflect ──passed──> 主 agent 内联执行 steps -> 综合 -> decide_save
                 │
                 └ gaps ─> decide_plan(focus=gaps+suggestions) ──> decide_reflect ──> …
```

- 第 1 轮：plan1 -> reflect1。passed 则执行；gaps 则修订。
- 第 2 轮：plan2 -> reflect2。passed 则执行；仍 gaps 则接受 plan2 执行（不再修订）。
- **最多 2 轮 reflect、1 次修订**。写在 `decide_plan` / `decide_reflect` description 里让主模型守。

loop 由主模型驱动：看到 `passed=false` -> 调 `decide_plan(focus=gaps+suggestions)` 修订 -> 再 `decide_reflect`；看到 `passed=true` -> 内联执行。复用 agent loop 的多轮工具调用，不新造循环引擎。

### 5.2 `decide_reflect` 工具

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `plan` | 是 | `string`，待评估的计划文本（`decide_plan` 的渲染输出，含 question/dimensions/options/steps/people） |

execute() 行为：

1. 用 side-call LLM（temperature:0，同 `recall.select` / `extractor` 模式）评估计划，输入 = `plan` + 评估 rubric；
2. rubric：只报实质性遗漏--关键维度缺失 / 选项严重偏见或狭窄 / 步骤不可行 / 人物缺失 / question 不清晰。计划已覆盖关键点即 `passed=true`，不挑小毛病（防不收敛）；
3. 返回 `{ status: "success", content: 判定文本, metadata: { passed, gaps: string[], suggestions: string[] } }`。content 为人可读判定（「评估通过」或「发现问题：…；建议：…」），供主模型读后决定是否 loop。

不做子 agent 调用--loop 下最多 2 次评估调用，side-call 独立性溢价不值子 agent 的成本；side-call 看不到主模型推理，已有足够独立视角。

### 5.3 注册

`builtinTools` 数组加 `decideReflectTool` 并导出。

## 6. 路由

路由靠工具 `description` 让主模型自行选择（现有模式；`tool-use.md` 模板不列 decide 系工具）。描述分工：

- **`decide`**：简单决策--二选一、低 stakes、当前上下文够用、用户要快。
- **`decide_plan`**：命中下列任一即走复杂路径--
  1. 多维度权衡（2+ 竞争维度）；
  2. 高 stakes / 难撤销（职业、大额支出、重大关系）；
  3. 信息不足需主动收集（要跨多主题/人物定向召回）；
  4. 多选项（3+ 可行选项）；
  5. 长影响周期（月/年级）。
- **`decide_plan` 还须指示 loop**：产出计划后调 `decide_reflect` 评估；`passed=false` 则用 `focus=gaps+suggestions` 修订重评；最多 2 轮；通过或达上限后才内联执行 `steps`。
- **`decide_reflect`**：仅在 `decide_plan` 产出计划后调用，评估计划是否完备；不用于其他场景。

rubric 可调：跑偏了改描述标准，不动代码逻辑。

## 7. 升级机制（简单 -> 复杂）

升级由对话驱动，不需专门基础设施：

1. 第一轮 `decide` 给快答案；
2. 用户不满（「太浅」「没考虑 X」「为什么不是 B」「好好分析一下」）；
3. 主模型识别不满，调 `decide_plan(topic, question, focus: "用户指出漏了家庭维度 + 质疑结论")`；
4. `focus` 写进计划「本次重点」段，计划针对性补漏。

**重新规划，不续接**：生成完整新计划，但带上 `focus` 指向，利用上一轮已有信息而非重复。

`focus` 参数在两处复用：用户驱动的升级（本节）、reflect 驱动的修订（5.1）--都是「把需深挖的点喂给 decide_plan」，机制统一。

升级触发信号写进 `decide_plan` description：「用户对简单分析不满 / 要更深 / 质疑结论 / 补新维度时调用」。

反向降级（复杂但用户嫌啰嗦）暂不处理--过度分析比分析不足危害低。

## 8. 计划可见性（TUI）

现状（`packages/cli/src/components/tool-call-card.tsx`）：工具结果默认截断为 40 列摘要，仅 `error` 时展开 margin-left 块（`:35-39`）。`decide` 的大段上下文用户实际看不到。

`decide_plan` 的计划与 `decide_reflect` 的评估都是多行结构化 artifact，必须完整可见，因此**特例展开**：

- v1：`ToolCallCard` 增加特例--`status === "done" && (toolName === "decide_plan" || toolName === "decide_reflect")` 时，把 `result` 以 margin-left 块完整展示，用 success/muted 色，分别标「计划」「评估」；
- artifact 文本来自各自 `execute()` 返回的 `content`；
- 不阻塞执行：展示后模型继续（执行 steps 或 loop）；
- loop 会产生多组 plan+reflect artifact，v1 全展示；之后可折叠成「最终计划 + 修订历史」--当前 YAGNI。
- 后续若再有「需展开」工具，再抽成 `verbose` 标志泛化。

## 9. 保存

复用 `decide_save`（topic/decision/reasoning/people），复杂路径的 `reasoning` 自然包含计划与评估。v1 不给 `decide_save` 加 `plan` 字段--模型把计划融进 reasoning 即可。

可选扩展（不做）：`decide_save` 加 `plan` 可选字段持久化原计划。

## 10. 测试策略

仿 `decide.test.ts` / `decide-save.test.ts`，新建 `decide-plan.test.ts` 与 `decide-reflect.test.ts`：

`decide_plan`：

- execute 合法入参 -> `success`，渲染计划含 question / dimensions(aspect+goal) / options / steps；
- execute 拒绝空 `dimensions` / `options`(<2) / `steps`（validation error）；
- `focus` 提供时出现在渲染计划的「本次重点」段；
- `people` 渲染为「名字（关系）」格式；
- 路由：断言 `decide_plan` description 含 rubric 关键词（多维度/stakes/多选项…）与 loop 指引；
- 计划渲染格式稳定（结构断言）。

`decide_reflect`：

- execute 调 side-call LLM（temperature:0）并返回 `{ passed, gaps, suggestions }` 结构；
- 完备计划 -> `passed=true`、`gaps` 空；缺关键维度的计划 -> `passed=false`、`gaps` 非空；
- 路由：断言 description 限定「仅在 decide_plan 后调用」。

TUI 侧（`packages/cli`）：

- `ToolCallCard` 对 `decide_plan` / `decide_reflect` done 展开完整 `result`、对其他工具仍截断 40 列。

loop 收敛（最多 2 轮、达上限接受）是模型行为，靠手动 / E2E 验证；`focus` 流入计划、`passed` 判定结构可单测。

## 11. 不在本次范围

- 深度研究 Planner（方向 B）--未来可复用本骨架；
- `verbose` 工具标志泛化；
- `decide_save` 持久化原计划字段；
- 反向降级（复杂 -> 简单）；
- reflect 用子 agent（v1 用 side-call LLM）；
- 超过 2 轮的 reflect；
- 主循环 temperature 锁定--独立问题，另行处理。

## 12. 成功标准

1. 复杂决策请求触发 `decide_plan`，用户在 TUI 看到完整计划；
2. 计划经 `decide_reflect` 评估；`passed=false` 时主模型用 `focus` 修订重评，最多 2 轮收敛或达上限接受；
3. 通过后模型按计划 `steps` 逐个调用 recall/profile 工具，给出综合分析；
4. 简单决策仍走 `decide`，行为与现状一致；
5. 用户对简单答案不满时，下一轮能升级到 `decide_plan` 且 `focus` 体现补漏；
6. 新增单测全部通过，`pnpm build` 零错误。
