<p align="center">
  <a href="https://vibecompass.dev">
    <img src="https://raw.githubusercontent.com/jack-whimvy/vibecompass-mcp/main/brand/logo-a4.png" alt="VibeCompass" height="96" />
  </a>
</p>

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

**Hybrid asymmetry, by design:** reads prefer the local root (conflicts and
pending proposals still come from hosted — they are collaboration metadata),
while ALL write tools (`log_decision`, `add_session_summary`,
`update_feature_status`, `flag_conflict`) go to the hosted project only.
A decision logged over MCP lands in the hosted structured tables and does
NOT appear in your local canonical `decisions/*.md` unless it comes back
through the proposal flow. Local file writes stay with the
`@vibecompass/vibecompass` package.

### Changing a project's hosting mode

Environment variables are read once at startup — after moving a project
between modes, update the variables and **restart the MCP server**:

- **Promoted to hosted-only** (`vibecompass promote-hosted`): set
  `VIBECOMPASS_API_KEY` (create a key on the hosted Setup page) and remove
  `VIBECOMPASS_ROOT`.
- **Demoted to local-primary** (`vibecompass demote-hosted`): set
  `VIBECOMPASS_ROOT` back to the local root; keep the API key for hybrid
  writes if you want them.

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
- `list_pending_proposals` — hosted proposal summaries, read-only. In local
  mode it returns an empty list with a note, because proposals live in the
  hosted project.

Write tools require `VIBECOMPASS_API_KEY` and are disabled in pure local mode:

- `log_decision`
- `update_feature_status`
- `flag_conflict`
- `add_session_summary`

### Session brief (`get_brief`, opt-in)

`get_brief` builds a session brief for a task: excerpts of the architecture
docs, decisions, and session notes that match it, with a status (complete,
partial, incomplete, or no-match) and the follow-up reads that didn't fit. It
is the same brief `vibecompass brief` prints.

It appears only in local and hybrid mode, and only when the root's
`project.yaml` turns the brief on:

```yaml
brief:
  enabled: true
```

The server checks this when it starts, so restart it after changing the
setting. If the setting is turned off while the server runs, `get_brief`
returns a note and builds nothing.

- Inputs: `task` (required), and optionally `files`, `feature_slugs`,
  `claims`, `lane_id`, and `budget` (800 to 6,000 estimated tokens; default
  6,000). The tool never picks a session lane for you; pass `lane_id` to
  include one.
- Output: the brief as markdown, then its metadata as JSON, with units listed
  as references. `vibecompass brief --json` with the same inputs gives the
  full records.
- Treat the brief as a starting point. Its excerpts are cut, and it can miss
  the doc a task depends on, so read the full source behind anything you rely
  on.
- It never serves an old brief: if a build fails or takes over 5 seconds, the
  call returns an error with no brief.
- Each call builds in its own worker thread. The server stops the build at
  5 seconds and keeps answering other tool calls while it runs.

### Response budgets

Every mode keeps read responses small enough for a model's context.
(`get_brief` is the exception described above: its markdown keeps the brief's
own budget, and only its JSON metadata follows these limits.)
`get_project_context` and `get_feature_context` drop their least important
detail first to fit about 2,000 tokens. Any read response still over about
2,500 tokens comes back as a preview with a `_note` pointing to narrower tools,
such as `get_feature_context` with a `component_slug`. In local mode, when a
feature's component details are dropped, the note says to read each
component's doc, whose path the response gives.

In local mode, decisions are filtered by the feature's domain decision file
(for example `decisions/mcp-server.md`), because decision entries don't record
which feature they belong to. Responses say so in a note.

### Server instructions

The server tells the client what the tools are for and where the project's
source of truth is: the local project-memory files in local and hybrid mode.
The instructions never mention `get_brief`, so agents aren't steered to call
it.
