# VibeCompass MCP

Project memory lives in this repo's workspace, not in the repo. From a main checkout the workspace is `..`; from a lane worktree (`<workspace>/worktrees/<lane-id>/<repo-id>/`) it is `../../..`, and `../.vibecompass-lane.yaml` names the lane's memory root (`memory_root`). Read the workspace `AGENTS.md` first: it names the canonical root and the session protocol. Architecture docs are under `<workspace>/vibecompass-docs/architecture/`.

## Repo Purpose

This package is the local MCP client/server layer that exposes VibeCompass context to AI tools over stdio.

## Working Rules

- Keep tool contracts aligned with `vibecompass-app` `/api/mcp/*` endpoints
- Read tools should stay resilient and never hard-fail the user session
- Write tools should surface failures clearly
- Preserve TypeScript ESM / NodeNext conventions

## Commands

- `npm run build`
- `npm run dev`
- `npm run start`

## Important Context

- Runtime env:
  - hosted mode: `VIBECOMPASS_API_KEY`, optional `VIBECOMPASS_API_URL`
  - local read mode: `VIBECOMPASS_ROOT`
  - hybrid mode: if both are set, read tools use the local root while write tools and hosted conflict reads stay enabled through the API client
- Current architecture and behavior decisions live in:
  - `<workspace>/vibecompass-docs/decisions/mcp-server.md`
  - `<workspace>/vibecompass-docs/architecture/mcp-server/`
