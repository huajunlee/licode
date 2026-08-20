# Recipe 2：调试一个 bug

> **目标**：用 LICode 定位并修复一个运行时 bug。
>
> **使用功能**：ReAct 循环、grep 工具、bash 工具、read 工具、Thinking 推理

---

## 场景描述

测试同学报告：点击"提交订单"按钮后页面报错 `Cannot read properties of undefined (reading 'price')`，但不知道是哪个文件出的问题。

## 步骤

### 1. 描述 bug 给 LICode

```
> 帮我排查一个 bug：用户点击"提交订单"按钮后报错
  "Cannot read properties of undefined (reading 'price')"。
  先搜索项目里所有包含 "price" 和 "提交订单" 的地方
```

### 2. LICode 自动搜索

LICode 会启动 ReAct 循环，自动调用多个工具：

```
🔍 正在搜索代码库...
   搜索关键词 "price"...
   搜索关键词 "提交订单"...

⚙ grep  搜索 "price" 在 src/ 下
   找到 12 处匹配

✓ grep  完成
   找到 src/order.ts:89: const total = cart.items.reduce((s, i) => s + i.price, 0)
```

### 3. LICode 分析问题

它会读取相关文件，追踪数据流：

```
📖 正在读取代码...
   读取 src/order.ts
   读取 src/cart.ts

🤔 正在分析逻辑...
   排查 cart.items 的数据来源...
   发现：cart.items 在清空购物车后被设为 undefined
   但 order.ts:89 直接访问了 i.price 没有空值检查
```

### 4. LICode 提出修复方案

```
找到根因：
  src/cart.ts:34 清空购物车时 cart.items = undefined
  src/order.ts:89 未检查 items 是否存在

建议修复 src/order.ts:
  const total = cart.items?.reduce((s, i) => s + i.price, 0) ?? 0
```

### 5. 确认修复并验证

```
> 帮我修复，然后跑一下相关的测试
```

LICode 会：
1. 用 `edit` 工具修改 `src/order.ts:89`
2. 用 `bash` 执行 `npm test -- --grep 'order'`
3. 报告测试结果

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| Bug 根因分析 | 对话输出 | 终端显示 | LICode 在推理卡片中输出完整的数据流追踪 |
| 修复后的代码 | 文件修改 | `src/order.ts:89` | 添加了可选链 `?.` 和空值合并 `??` |
| 测试结果 | 终端输出 | 终端显示 | `npm test -- --grep 'order'` 的执行结果 |
| 会话存档 | JSON 文件 | `.licode/sessions/{id}.json` | 完整的排查过程 + 工具调用记录 |

> 💡 这次操作**只修改 1 行代码**（`src/order.ts:89`），但 LICode 为了找到这 1 行，自动执行了 5+ 次工具调用（grep 搜索 → read 文件 → 分析数据流 → edit 修改 → bash 测试）。

---

## 执行前后对比

**执行前**：
```
src/order.ts:89 → const total = cart.items.reduce((s, i) => s + i.price, 0)
                                         ↑ 当 cart.items 为 undefined 时崩溃
```

**执行后**：
```
src/order.ts:89 → const total = cart.items?.reduce((s, i) => s + i.price, 0) ?? 0
                                         ↑ 安全访问，undefined 时返回 0
```

---

## 关键要点

- 描述 bug 时尽可能具体（错误信息、触发条件、文件范围）
- LICode 会自动搜索 → 阅读 → 推理 → 修复，不需要手动指定每一步
- 修复后让 LICode 跑测试验证，形成闭环

---

## 常见问题排查

**Q: LICode 没有找到 bug 根因？**
- 提供更多上下文："这个 bug 是在用户清空购物车后出现的"
- 描述完整的复现步骤，LICode 会按照你的步骤追踪数据流

**Q: 修复后仍然报错？**
- 让 LICode 查看完整的错误堆栈：`"跑测试时还是报错，这是错误日志..."`
- 可能存在多处同类 bug，让 LICode 全局搜索相同的模式
