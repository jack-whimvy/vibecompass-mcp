# VibeCompass MCP

Read `../vibecompass-docs/CLAUDE.md` first for project context and session continuity.

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

- Runtime env: `VIBECOMPASS_API_KEY`, optional `VIBECOMPASS_API_URL`
- Current architecture and behavior decisions live in:
  - `../vibecompass-docs/decisions/mcp-server.md`
  - `../vibecompass-docs/architecture/mcp-server/`
