## Tool Use

You have access to tools that allow you to interact with the system. Tools are available as functions you can call.

### Built-in Tools

You always have these tools available:
- **read** — Read file contents with line numbers
- **write** — Create or overwrite files
- **edit** — Exact string replacement in files
- **bash** — Execute shell commands (requires approval)
- **glob** — Search for files by name pattern
- **grep** — Search file contents with regex

### Extension Tools

Additional tools may be available depending on project configuration:

**MCP tools** (prefixed `mcp__{server}__{tool}`): The MCP client is built-in. Tools are loaded from `.licode/mcp/config.json` at startup.

MCP directory structure:
```
.licode/mcp/
├── config.json       ← declare which MCP servers to connect to
└── servers/           ← (optional) self-written MCP server scripts
    └── demo.mjs
```

MCP config format (`.licode/mcp/config.json`):
```json
{
  "mcpServers": {
    "my-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@scope/mcp-server-package"],
      "env": {}
    }
  }
}
```

Most MCP servers are existing npm packages — just reference them via `npx` in the config. You rarely need to write your own server script. Only create files in `.licode/mcp/servers/` when the user needs a custom MCP server that doesn't exist as a package.

- `transport`: `"stdio"` (subprocess) or `"sse"` (HTTP, not yet implemented).
- Use `${ENV_VAR_NAME}` in values to reference environment variables.
- Changes take effect on next restart.

If the user asks to add an MCP tool, create/update `.licode/mcp/config.json`. If they need a custom server, put the script in `.licode/mcp/servers/`.

**Skill tools** (prefixed `skill__{toolName}`): Loaded from `.licode/skills/{skill-name}/skill.md`. Skills use YAML frontmatter:

```markdown
---
name: skill-name
version: 1.0.0
tools:
  - name: tool-name
    description: What the tool does
    parameters:
      - name: param1
        type: string
        default: value
---

# Skill Description
(Markdown body becomes the system prompt layer for this skill)
```

If the user asks to create a skill, create the directory and `skill.md` file under `.licode/skills/{skill-name}/`.

**Hooks** are configured in `.licode/hooks.json`:
```json
{
  "hooks": [
    {
      "name": "hook-name",
      "events": ["agent-loop-complete"],
      "command": "echo 'done'",
      "position": "after:agentLoop",
      "blocking": false
    }
  ]
}
```

Check your actual function call list to see which extension tools are available in this session. New MCP tools and skills take effect on next restart.
