# Recipe 3：给项目加新功能

> **目标**：用 LICode 从零开始实现一个新功能模块。
>
> **使用功能**：Agent 对话、write/edit 工具、多轮工具调用、bash 工具

---

## 场景描述

你要给项目加一个"用户收藏"功能：用户可以收藏文章，查看收藏列表，取消收藏。

## 步骤

### 1. 描述需求

```
> 帮我给项目添加"用户收藏"功能：
  1. 在数据库里加一个 favorites 表（user_id, article_id, created_at）
  2. 创建 src/features/favorites/ 目录
  3. 实现 3 个 API：POST /favorites（收藏）、GET /favorites（列表）、DELETE /favorites/:id（取消）
  4. 写单元测试
```

### 2. LICode 规划并执行

LICode 会分步执行，你在屏幕上能看到每一步的工具调用：

```
✏️ 正在编辑文件...
┌──────────────────────────────────────────┐
│ ✓ write  创建 src/features/favorites/router.ts  │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ✓ write  创建 src/features/favorites/service.ts │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ✓ edit   修改 src/db/schema.ts            │
│   添加 favorites 表定义                     │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ✓ write  创建 src/features/favorites/__tests__/router.test.ts │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ⚙ bash   执行 npm test -- favorites       │
│   ... 12 tests passed                     │
└──────────────────────────────────────────┘
```

### 3. 逐功能验证

如果某个步骤有问题，可以直接纠正：

```
> POST /favorites 的请求体里应该用 articleId 而不是 id
```

LICode 会用 `edit` 精确替换字段名。

### 4. 查看最终结果

```
> 列出 favorites 目录下所有文件
```

```
src/features/favorites/
├── router.ts        ← 3 个 API 路由
├── service.ts       ← 业务逻辑
├── types.ts         ← 类型定义
└── __tests__/
    └── router.test.ts  ← 12 个测试
```

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| 路由文件 | 新建文件 | `src/features/favorites/router.ts` | 3 个 API 路由（POST/GET/DELETE） |
| 业务逻辑 | 新建文件 | `src/features/favorites/service.ts` | 数据库操作、参数校验 |
| 类型定义 | 新建文件 | `src/features/favorites/types.ts` | Favorite、CreateFavoriteInput 等类型 |
| 测试文件 | 新建文件 | `src/features/favorites/__tests__/router.test.ts` | 12 个测试用例 |
| 数据库迁移 | 文件修改 | `src/db/schema.ts` | 新增 favorites 表定义 |
| 会话存档 | JSON 文件 | `.licode/sessions/{id}.json` | 全部操作记录 |

> 💡 这次操作**创建了 4 个新文件 + 修改了 1 个已有文件**。LICode 自动按依赖顺序执行：先改数据库 schema，再写 service 层，再写 router，最后写测试。

---

## 最终目录结构

```
src/features/favorites/
├── router.ts              ← 3 个 API 路由
├── service.ts             ← 业务逻辑（数据库操作）
├── types.ts               ← TypeScript 类型定义
└── __tests__/
    └── router.test.ts     ← 12 个测试用例

src/db/
└── schema.ts              ← 新增 favorites 表定义
```

---

## 执行前后对比

**执行前**：
```
src/
├── db/schema.ts           ← 只有 users, posts 表
├── features/              ← 空目录（或不存在）
```

**执行后**：
```
src/
├── db/schema.ts           ← 新增 favorites 表
├── features/favorites/    ← 完整的收藏功能模块
│   ├── router.ts
│   ├── service.ts
│   ├── types.ts
│   └── __tests__/router.test.ts
```

---

## 关键要点

- 一次说清楚需求的全貌，LICode 会自动拆解成多个步骤
- 信任但不盲从——每完成一个文件就快速浏览一下
- 用 `npm test` 即时验证，不积累问题

---

## 常见问题排查

**Q: LICode 创建的文件不符合项目规范？**
- 在 `CLAUDE.md` 中写明项目规范（命名约定、目录结构、代码风格），LICode 会自动遵守
- 示例：`"路由文件统一放在 src/routes/，文件名用 kebab-case"`

**Q: 测试没通过？**
- 让 LICode 查看失败日志并自行修复：`"npm test 有 2 个失败，帮我修一下"`
- LICode 会阅读错误信息，定位问题，修改代码，再跑测试，直到全部通过
