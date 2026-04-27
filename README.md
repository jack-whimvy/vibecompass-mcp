# vibecompass-mcp

MCP stdio server for [VibeCompass](https://vibecompass.dev).

It connects Claude Code, Codex, Cursor, and similar MCP-capable tools to a
VibeCompass project so sessions can read project context and write back
decisions, conflicts, and session handoff notes.

## Requirements

- Node.js 20+
- One of:
  - `VIBECOMPASS_API_KEY` for hosted mode
  - `VIBECOMPASS_ROOT` for local read mode
- Local mode uses the bundled `@vibecompass/vibecompass` core dependency for file-backed reads

## Environment

Hosted mode:

- `VIBECOMPASS_API_KEY`
- `VIBECOMPASS_API_URL`
  Defaults to `https://vibecompass.dev`

Local mode:

- `VIBECOMPASS_ROOT`
  Absolute path to the canonical local project-memory root (`project.yaml`, `architecture/`, `decisions/`, `sessions/`, `state/manifest.json`)

Hybrid mode:

- If both `VIBECOMPASS_ROOT` and `VIBECOMPASS_API_KEY` are set, read tools resolve from the local root, while write tools and hosted conflict reads remain enabled through the API client

## Install

### npm

Run the public scoped package:

```bash
npx -y @vibecompass/vibecompass-mcp
```

## Development

`npm test` uses Node's `t.mock.timers` for timeout coverage. Node 20 prints an
experimental MockTimers warning; the warning is expected and does not indicate a
test failure.

Known upstream client issues: Codex 0.33 issue #3426 and Claude Code 2.0.76's
internal `effortLevel` failure. See
https://github.com/jack-whimvy/vibecompass-docs/blob/main/architecture/mcp-server/context-delivery/resilience.md
for current dogfood status.

## Example config

### Hosted mode

### Claude Code (`claude mcp add`)

```bash
claude mcp add --transport stdio vibecompass \
  --env VIBECOMPASS_API_KEY='your-api-key' \
  --env VIBECOMPASS_API_URL='https://vibecompass.dev' \
  -- npx -y @vibecompass/vibecompass-mcp
```

### Claude Code (`claude mcp add-json`)

```bash
claude mcp add-json vibecompass '{"type":"stdio","command":"npx","args":["-y","@vibecompass/vibecompass-mcp"],"env":{"VIBECOMPASS_API_KEY":"your-api-key","VIBECOMPASS_API_URL":"https://vibecompass.dev"}}'
```

### Claude Code project config (`.mcp.json`)

```json
{
  "mcpServers": {
    "vibecompass": {
      "command": "npx",
      "args": ["-y", "@vibecompass/vibecompass-mcp"],
      "env": {
        "VIBECOMPASS_API_KEY": "your-api-key",
        "VIBECOMPASS_API_URL": "https://vibecompass.dev"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "vibecompass": {
      "command": "npx",
      "args": ["-y", "@vibecompass/vibecompass-mcp"],
      "env": {
        "VIBECOMPASS_API_KEY": "your-api-key",
        "VIBECOMPASS_API_URL": "https://vibecompass.dev"
      }
    }
  }
}
```

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.vibecompass]
command = "npx"
args = ["-y", "@vibecompass/vibecompass-mcp"]
env = { VIBECOMPASS_API_KEY = "your-api-key", VIBECOMPASS_API_URL = "https://vibecompass.dev" }
```

Keep the repo-level `AGENTS.md` file committed so Codex knows when to call the
VibeCompass tools.

### Local read mode

Example env:

```json
{
  "VIBECOMPASS_ROOT": "/absolute/path/to/project-memory-root"
}
```

Claude Code local-mode command:

```bash
claude mcp add --transport stdio vibecompass \
  --env VIBECOMPASS_ROOT='/absolute/path/to/project-memory-root' \
  -- npx -y @vibecompass/vibecompass-mcp
```

### Hybrid mode

Example env:

```json
{
  "VIBECOMPASS_ROOT": "/absolute/path/to/project-memory-root",
  "VIBECOMPASS_API_KEY": "your-api-key",
  "VIBECOMPASS_API_URL": "https://vibecompass.dev"
}
```

## Local development

```bash
npm install
npm run build
npm test
VIBECOMPASS_API_KEY=your-api-key npm run start
```

Local-only read development:

```bash
VIBECOMPASS_ROOT=/absolute/path/to/project-memory-root npm run start
```

## Tools

Read tools work in hosted mode or local mode:

- `get_project_context`
- `get_feature_context`
- `get_decision_log`
- `get_conflicts`
- `get_file_context`

Write tools require `VIBECOMPASS_API_KEY` and are disabled in pure local mode:

- `log_decision`
- `update_feature_status`
- `flag_conflict`
- `add_session_summary`
