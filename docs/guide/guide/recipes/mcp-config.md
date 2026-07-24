# Recipe 4：配置外部 MCP 工具

> **目标**：通过 MCP 协议接入外部工具服务，让 LICode 能调用更多工具。
>
> **使用功能**：MCP 协议、ToolRegistry、权限守卫

---

## 场景描述

你有一个内部的文件管理 API，想通过 MCP 协议暴露给 LICode，让它能直接操作远程文件系统。

## 步骤

### 1. 创建 MCP 配置文件

在项目根目录创建 `.licode/mcp/config.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/path/to/allowed/dir"]
    },
    "internal-api": {
      "transport": "stdio",
      "command": "node",
      "args": [".licode/mcp/servers/internal-api.js"],
      "env": {
        "API_TOKEN": "${INTERNAL_API_TOKEN}"
      }
    }
  }
}
```

> 💡 `${INTERNAL_API_TOKEN}` 会自动从环境变量中读取。

### 2. 启动 LICode 验证 MCP 连接

```
> 你目前有哪些工具可用？
```

LICode 会列出所有已注册的工具：

```
内置工具：
  - read
  - write
  - edit
  - bash
  - glob
  - grep

MCP 工具：
  - mcp__filesystem__read_file    ← 来自 filesystem 服务
  - mcp__filesystem__write_file
  - mcp__filesystem__list_directory
  - mcp__internal-api__query_data ← 来自 internal-api 服务
```

### 3. 使用 MCP 工具

```
> 帮我列出远程服务器上 /data/reports/ 目录下的所有文件
```

LICode 会自动调用 `mcp__filesystem__list_directory` 工具：

```
┌──────────────────────────────────────────┐
│ ⏳ mcp__filesystem__list_directory       │
│   查询 /data/reports/                     │
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ ✓ mcp__filesystem__list_directory        │
│   Q1-report.pdf                          │
│   Q2-report.pdf                          │
│   annual-summary.csv                     │
└──────────────────────────────────────────┘
```

### 4. 权限管理

某些 MCP 工具可能标记为需要权限确认。LICode 会弹窗：

```
⚠️  工具 mcp__internal-api__delete_record 需要权限确认

这个工具将删除数据库记录，是否允许？
  [a] 仅此一次  [s] 本次会话始终允许  [d] 拒绝
```

---

## 产物说明

| 产物 | 类型 | 存放位置 | 说明 |
|------|------|---------|------|
| MCP 配置 | 手动创建 | `.licode/mcp/config.json` | 定义连接的 MCP 服务端及其工具 |
| 自定义 MCP Server | 手动创建 | `.licode/mcp/servers/internal-api.js` | 你的 Node.js MCP 服务端实现 |
| 工具注册 | 内存 | ToolRegistry（不持久化） | 启动时自动发现并注册，工具名为 `mcp__{server}__{tool}` |
| 工具调用日志 | JSON 文件 | `.licode/sessions/{id}.json` | 所有 MCP 工具调用记录在会话中 |

> 💡 MCP 工具**不会在磁盘上创建额外文件**——它们的输入输出都在对话和会话 JSON 中。配置文件（`config.json`）是你手动创建的，LICode 只读取它。

---

## 配置后的工具注册状态

**配置前** — LICode 只有 6 个内置工具：
```
read | write | edit | bash | glob | grep
```

**配置后** — 新增 MCP 工具（命名空间分隔，不会冲突）：
```
read | write | edit | bash | glob | grep          ← 内置工具
mcp__filesystem__read_file                         ← filesystem 服务
mcp__filesystem__write_file
mcp__filesystem__list_directory
mcp__internal-api__query_data                      ← internal-api 服务
```

---

## 关键要点

- MCP 工具命名空间为 `mcp__{server}__{tool}`，避免与内置工具冲突
- 环境变量用 `${VAR_NAME}` 格式引用，启动时自动替换
- SSE 传输（HTTP）暂未实现，目前仅支持 Stdio

---

## 常见问题排查

**Q: MCP 服务端连接失败？**
- 检查 `command` 是否可执行（`which npx` / `which node`）
- 检查 `args` 中的路径是否正确（相对路径相对于项目根目录）
- 手动运行 MCP Server 确认它能正常启动：`npx -y @anthropic/mcp-server-filesystem /tmp`

**Q: MCP 工具没有出现在工具列表中？**
- 确认 `config.json` 是合法的 JSON（用 `cat .licode/mcp/config.json | python -m json.tool` 验证）
- 确认 `transport` 字段为 `"stdio"`（唯一的已实现传输方式）
- 重启 LICode 重新加载配置

**Q: 工具调用超时？**
- MCP 工具默认有 30 秒超时，如果操作耗时较长（如大文件处理），考虑优化服务端逻辑
- 在服务端实现进度反馈（MCP 协议支持）
