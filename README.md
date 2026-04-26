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

### Hosted mode

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

### Local read mode

Example env:

```json
{
  "VIBECOMPASS_ROOT": "/absolute/path/to/project-memory-root"
}
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
