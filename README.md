# vibecompass-mcp

MCP stdio server for [VibeCompass](https://vibecompass.dev).

It connects Claude Code, Codex, Cursor, and similar MCP-capable tools to a
VibeCompass project so sessions can read project context and write back
decisions, conflicts, and session handoff notes.

## Requirements

- Node.js 20+
- A VibeCompass API key for the target project

## Environment

Required:

- `VIBECOMPASS_API_KEY`

Optional:

- `VIBECOMPASS_API_URL`
  Defaults to `https://vibecompass.dev`

## Install

### Pre-release

Until the npm package is published, run the public GitHub package spec:

```bash
npx -y github:jack-whimvy/vibecompass-mcp
```

The package includes a `prepare` script so GitHub installs build `dist/`
before execution.

### npm

Once published, the install target becomes:

```bash
npx -y vibecompass-mcp
```

## Example config

### Claude Code (`.claude/settings.json`)

```json
{
  "mcpServers": {
    "vibecompass": {
      "command": "npx",
      "args": ["-y", "github:jack-whimvy/vibecompass-mcp"],
      "env": {
        "VIBECOMPASS_API_KEY": "your-api-key",
        "VIBECOMPASS_API_URL": "https://vibecompass.dev"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "vibecompass": {
    "command": "npx",
    "args": ["-y", "github:jack-whimvy/vibecompass-mcp"],
    "env": {
      "VIBECOMPASS_API_KEY": "your-api-key",
      "VIBECOMPASS_API_URL": "https://vibecompass.dev"
    }
  }
}
```

### Codex

Use:

- command: `npx`
- args: `-y`, `github:jack-whimvy/vibecompass-mcp`
- env: `VIBECOMPASS_API_KEY`, `VIBECOMPASS_API_URL`

Keep the repo-level `AGENTS.md` file committed so Codex knows when to call the
VibeCompass tools.

## Local development

```bash
npm install
npm run build
npm test
VIBECOMPASS_API_KEY=your-api-key npm run start
```

## Tools

Read:

- `get_project_context`
- `get_feature_context`
- `get_decision_log`
- `get_conflicts`
- `get_file_context`

Write:

- `log_decision`
- `update_feature_status`
- `flag_conflict`
- `add_session_summary`
