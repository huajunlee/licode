# Recipe 8：Spec 驱动开发

> **目标**：用 Spec 模式组织开发任务，让 LICode 按照你的规格文件执行。
>
> **使用功能**：spec-kit、`licode spec` 命令、CLAUDE.md

---

## 场景描述

你要开发一个"用户通知"功能，需求比较复杂。先用 Spec 规划好，再让 LICode 按 Spec 实现。

## 步骤

### 1. 初始化 Spec

```bash
$ licode spec init 用户通知功能

Created spec 用户通知功能 at specs/用户通知功能/
  ├── spec.md      ← 功能规格说明
  ├── tasks.md      ← 任务拆解清单
  └── checklist.md  ← 验收检查项
```

### 2. 编写 Spec

编辑 `specs/用户通知功能/spec.md`：

```markdown
# 用户通知功能

## 概述
为用户提供站内通知功能，支持系统通知和用户间通知。

## 功能需求
1. 通知列表：分页展示，未读高亮
2. 通知详情：点击查看完整内容
3. 标记已读：单条 / 全部已读
4. 通知创建：系统自动触发 + API 手动创建

## 技术约束
- 数据库：PostgreSQL
- 实时推送：WebSocket
- 前端框架：React + TypeScript

## 验收标准
- 通知列表加载时间 < 200ms
- 实时推送延迟 < 1s
- 1000 条通知下分页正常
```

### 3. 编写任务清单

编辑 `specs/用户通知功能/tasks.md`：

```markdown
# 任务清单

## 后端
- [ ] 创建 notifications 表（id, user_id, title, content, type, read, created_at）
- [ ] 实现 GET /api/notifications（分页 + 未读筛选）
- [ ] 实现 PATCH /api/notifications/:id/read
- [ ] 实现 PATCH /api/notifications/read-all
- [ ] 实现 POST /api/notifications（系统通知）
- [ ] 实现 WebSocket 推送

## 前端
- [ ] NotificationList 组件（分页 + 未读高亮）
- [ ] NotificationDetail 组件
- [ ] WebSocket 连接 hook
- [ ] 未读数量徽章

## 测试
- [ ] 后端 API 测试（6 个接口）
- [ ] 前端组件测试（3 个组件）
- [ ] WebSocket 集成测试
```

### 4. 查看 Spec 状态

```bash
$ licode spec list

用户通知功能  active
支付模块      completed
搜索优化      draft
```

```bash
$ licode spec status

Specs: 3, active: 1
```

### 5. 让 LICode 按 Spec 执行

在 LICode 对话中：

```
> 请按照 specs/用户通知功能/spec.md 的规格，
  完成 tasks.md 里的后端任务，先做前 3 个
```

LICode 会自动读取 Spec 文件，按任务清单逐步执行。

### 6. 验证完成

```bash
$ licode spec validate 用户通知功能

Spec 用户通知功能 is valid
所有检查项通过 ✅
```

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| 功能规格 | 自动生成 | `specs/用户通知功能/spec.md` | 概述、需求、技术约束、验收标准 |
| 任务清单 | 自动生成 | `specs/用户通知功能/tasks.md` | 后端/前端/测试 checkbox 列表 |
| 验收清单 | 自动生成 | `specs/用户通知功能/checklist.md` | 上线前检查项 |
| 实现代码 | LICode 创建 | `src/`、`api/` 等 | 按 tasks.md 逐步创建的代码文件 |
| Spec 状态 | CLI 命令输出 | 终端显示 | `licode spec list/status` 的输出 |

> 💡 运行 `licode spec init <name>` 后，LICode 会**自动生成 3 个模板文件**。模板包含骨架结构，你需要（或让 LICode 帮你）填充具体内容。

---

## Spec 目录结构

```
specs/用户通知功能/
├── spec.md              ← 功能规格说明（手动编辑或让 LICode 填充）
├── tasks.md             ← 任务拆解清单（checkbox 格式）
└── checklist.md         ← 验收检查项（上线前必须通过）
```

3 个文件的完整流程：
```
spec.md 定义"做什么" → tasks.md 定义"怎么做" → checklist.md 定义"怎么验收"
```

---

## 执行前后对比

**执行前**：
```
项目中没有 specs/ 目录
```

**执行后**：
```
specs/
├── 用户通知功能/
│   ├── spec.md           ← 已填充完整的功能规格
│   ├── tasks.md          ← 13 个任务（6 后端 + 4 前端 + 3 测试）
│   └── checklist.md      ← 验收标准已明确

src/
├── models/notification.ts    ← LICode 按 tasks.md 创建
├── routes/notifications.ts   ← LICode 按 tasks.md 创建
└── ...
```

---

## 关键要点

- `licode spec init` 创建的是标准模板，你需要补充具体内容
- LICode 启动时会自动加载所有 spec 文件（调用 `loadSpecFiles`）
- Spec 文件和 CLAUDE.md 一起注入 system prompt，影响 LICode 的行为
- 用 `licode spec validate` 验证 spec 文件的格式和完整性

---

## 常见问题排查

**Q: `licode spec init` 命令不存在？**
- 确认你的 LICode 版本支持 spec-kit（Phase 6 功能）
- 检查 `@licode/spec-kit` 包是否正确安装

**Q: LICode 没有按 Spec 执行？**
- 在对话中明确引用 spec 路径：`"请按照 specs/用户通知功能/tasks.md 执行"`
- 确认 spec 文件格式正确：`licode spec validate 用户通知功能`
- LICode 加载 spec 文件需要 token 预算，如果对话太长可能被截断

**Q: Spec 文件和 CLAUDE.md 的优先级关系？**
- CLAUDE.md 是项目全局约定（如代码风格、技术栈）
- Spec 文件是特定功能的规格（如"用户通知功能的需求"）
- 两者都注入 system prompt，但 Spec 文件与具体任务更相关，优先级更高
