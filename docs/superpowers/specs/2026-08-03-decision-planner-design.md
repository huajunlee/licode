# 决策 Planner 设计（Decision Planner）

- 日期：2026-08-03
- 范围：`packages/core`（新增 `decide_plan` 工具）+ `packages/cli`（TUI 计划展开渲染）
- 状态：设计稿，待评审

## 1. 背景与动机

LICode 已实现 agent runtime、记忆系统、上下文管理、工具系统，但没有「先规划再执行」的机制。调研确认：

- 全仓不存在任何 plan/todo/breakdown 步骤；`decide` 工具是一次性上下文 dump，无规划、收集无方向。
- 主循环 temperature 未锁（跑在 API 默认 1.0），但这与本次设计无关——本设计不解决「跨次答案离散」，而是为复杂决策引入结构化规划能力。

**动机不是修复某个已观测的 bug**，而是：

1. 为项目增加一个非无用的能力——复杂决策的结构化规划与分步收集；
2. 学习 Planner 模式（TodoWrite 式：模型把计划作为结构化工具入参外部化）。

Planner 不是每个 agent 架构的必备组件，只对长 horizon、多步、需承诺执行路径的任务有回报。LICode 主体是对话/记忆/日记/决策建议等短 reactive 交互，因此 Planner **条件触发**，只作用于复杂决策，不污染日常对话。

## 2. 选型

在三个候选方向中选 A：

- **A（采纳）Planner 化决策模块**：把 `decide` 升级出一条「先规划再分步收集」的复杂路径，复用现有 decide.ts，是自然演进。
- B 深度研究 Planner：新能力，scope 更大，与 decide 有重叠。
- C 通用 TodoWrite 式任务规划：链路短且 reactive，触发频率低，最易「无用」。

A 搭建的 Planner 骨架未来可为 B 复用。

## 3. 整体架构

三层模型，复用现有 agent loop，**不新增执行引擎**：

```
用户决策请求
   │
   ├─ 简单 -> decide（≈现状，一次性 dump + 框架）
   │
   └─ 复杂 -> decide_plan（产出计划，半透明展示给用户）
                │
                ↓  计划作为 tool result 留在上下文
        模型按计划逐步调 journal_recall / profile_recall / …
                │
                ↓
        综合分析（复用 FRAMING B/C）+ 询问 decide_save
```

核心约束：**Planner 不自己执行**。它把「计划」作为 tool result 注入上下文，约束模型后续工具调用路径。这复用了 agent loop 已有的「模型靠 tool result 决定下一步」机制，契合 LICode 链路短的实情。

### 3.1 P1：模型自写计划（TodoWrite 式）

`decide_plan` 的计划由**主模型在调用工具时直接作为结构化入参填写**，`execute()` 不做 side-call LLM。理由：

- 更简单，无 side-call、无额外延迟；
- 主模型有完整对话上下文 + 已注入记忆，写的计划比只看 topic 的 side-call 贴切；
- 与项目已收集的 TodoWrite 参考一致；
- `execute()` 轻量——工具的价值在「让计划成为可见、结构化、committed 的 artifact」，不在 execute 干活。

计划是**软承诺**（soft commitment）：指引模型后续工具调用，但不强制硬编排（与 TodoWrite 一致）。

## 4. `decide_plan` 工具

### 4.1 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `topic` | 是 | 决策话题，写关键词便于匹配（同 `decide`） |
| `dimensions` | 是 | `string[]`，需权衡的维度（如「薪酬/成长/风险/家庭」），≥1 |
| `options` | 是 | `string[]`，可行选项，≥2 |
| `steps` | 是 | `string[]`，执行步骤，每步说明要召回/收集什么（如 `journal_recall("职业 历史")`），≥1 |
| `focus` | 否 | 升级时从上一轮简单分析或用户反馈提炼的「需深挖的维度/遗漏」 |
| `people` | 否 | `string[]`，相关人名（同 `decide`） |

### 4.2 execute() 行为

1. 校验：`dimensions` ≥1、`options` ≥2、`steps` ≥1，否则返回 `error`（`errorType: "validation"`）；
2. 把结构化入参渲染成计划 markdown（见 4.4）；
3. 返回 `{ status: "success", content: 计划文本, metadata: { dimensions: dimensions.length, options: options.length, steps: steps.length } }`（计数，同 `decide` 的 metadata 风格）；
4. 不做上下文收集、不做 side-call LLM——收集由后续按 `steps` 调用的 recall 工具完成。

### 4.3 综合分析指引

复杂路径不调用 `decide`，因此 `decide` 的 FRAMING（B/C 式 + 询问保存）不会自动注入。`decide_plan` 的 description 负责传达相同指引：执行完 `steps` 后按 B 式（2-3 路径 + 利弊 + 倾向建议）或 C 式（证据不足则摆事实、交还判断权）给出综合分析，并询问是否调用 `decide_save`。

可选优化（v1 不做）：将 FRAMING 抽为共享常量，由 `decide_plan` 的 execute 追加到计划末尾与 `decide` 复用。若 description 方式一致性不足再抽取。

### 4.4 计划 artifact 格式

```
# 决策计划：{topic}
（若有 focus）## 本次重点
{focus}
## 维度
- {dim1}
- {dim2}
## 选项
1. {opt1}
2. {opt2}
## 执行步骤
1. {step1}
2. {step2}
```

### 4.5 注册

`packages/core/src/tools/builtin/index.ts` 的 `builtinTools` 数组加 `decidePlanTool` 并导出（同现有 decide/decide_save 模式）。

## 5. 路由

路由靠工具 `description` 让主模型自行选择（现有模式；`tool-use.md` 模板不列 decide 系工具）。两个描述分工：

- **`decide`**：简单决策——二选一、低 stakes、当前上下文够用、用户要快。
- **`decide_plan`**：命中下列任一即走复杂路径——
  1. 多维度权衡（2+ 竞争维度）；
  2. 高 stakes / 难撤销（职业、大额支出、重大关系）；
  3. 信息不足需主动收集（要跨多主题/人物定向召回）；
  4. 多选项（3+ 可行选项）；
  5. 长影响周期（月/年级）。

rubric 可调：跑偏了改描述标准，不动代码逻辑。

## 6. 升级机制（简单 → 复杂）

升级由对话驱动，不需专门基础设施：

1. 第一轮 `decide` 给快答案；
2. 用户不满（「太浅」「没考虑 X」「为什么不是 B」「好好分析一下」）；
3. 主模型识别不满，调 `decide_plan(topic, focus: "用户指出漏了家庭维度 + 质疑结论")`；
4. `focus` 写进计划「本次重点」段，计划针对性补漏。

**重新规划，不续接**：生成完整新计划，但带上 `focus` 指向，利用上一轮已有信息而非重复。

升级触发信号写进 `decide_plan` description：「用户对简单分析不满 / 要更深 / 质疑结论 / 补新维度时调用」。

反向降级（复杂但用户嫌啰嗦）暂不处理——过度分析比分析不足危害低。

## 7. 计划可见性（TUI）

现状（`packages/cli/src/components/tool-call-card.tsx`）：工具结果默认截断为 40 列摘要，仅 `error` 时展开 margin-left 块（`:35-39`）。`decide` 的大段上下文用户实际看不到。

`decide_plan` 的计划是多行结构化 artifact，必须完整可见，因此**特例展开**：

- v1：`ToolCallCard` 增加特例——`status === "done" && toolName === "decide_plan"` 时，把 `result`（渲染好的计划 markdown）以 margin-left 块完整展示，用 success/muted 色，标「计划」；
- 计划文本来自 `execute()` 返回的 `content`；
- 不阻塞执行：展示后模型继续按 `steps` 调 recall（这些 recall 仍走正常折叠行）；
- 后续若再有「需展开」工具，再抽成 `verbose` 标志泛化——当前 YAGNI。

## 8. 保存

复用 `decide_save`（topic/decision/reasoning/people），复杂路径的 `reasoning` 自然包含计划与评估。v1 不给 `decide_save` 加 `plan` 字段——模型把计划融进 reasoning 即可。

可选扩展（不做）：`decide_save` 加 `plan` 可选字段持久化原计划。

## 9. 测试策略

仿 `decide.test.ts` / `decide-save.test.ts`，新建 `packages/core/src/tools/builtin/decide-plan.test.ts`：

- execute 合法入参 → `success`，渲染计划含 dimensions/options/steps；
- execute 拒绝空 `dimensions` / `options`(<2) / `steps`（validation error）；
- `focus` 提供时出现在渲染计划的「本次重点」段；
- 路由：断言 `decide_plan` description 含 rubric 关键词（多维度/stakes/多选项…）；
- 计划渲染格式稳定（结构断言）。

TUI 侧（`packages/cli`）：

- `ToolCallCard` 对 `decide_plan` done 展开完整 `result`、对其他工具仍截断 40 列。

升级本身是模型行为，靠手动 / E2E 验证；`focus` 流入计划可单测。

## 10. 不在本次范围

- 深度研究 Planner（方向 B）——未来可复用本骨架；
- `verbose` 工具标志泛化；
- `decide_save` 持久化原计划字段；
- 反向降级（复杂 → 简单）；
- 主循环 temperature 锁定——独立问题，另行处理。

## 11. 成功标准

1. 复杂决策请求触发 `decide_plan`，用户在 TUI 看到完整计划；
2. 模型按计划 `steps` 逐个调用 recall/profile 工具后给出综合分析；
3. 简单决策仍走 `decide`，行为与现状一致；
4. 用户对简单答案不满时，下一轮能升级到 `decide_plan` 且 `focus` 体现补漏；
5. 新增单测全部通过，`pnpm build` 零错误。
