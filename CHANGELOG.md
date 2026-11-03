# Changelog

Entries before 0.1.9 cite decisions by number. Those decisions are in the
VibeCompass project's own decision log, which is private, not in your
project's log. From 0.1.9 on, entries state each rule without a number, as the
server's instructions and tool descriptions always have.

## 0.1.10 - 2026-11-02

- Depend on `zod` `^4.6.6` (was `^3.23.0`). That fixes the high `npm audit`
  finding 0.1.9 disclosed, GHSA-mrhx-c7xc-m3w5: zod could exhaust memory while
  validating oversized constrained collections. No zod 3 release fixes it. An
  install now gets one copy of zod, 4.6.7 today, which
  `@modelcontextprotocol/sdk` uses too. The SDK range stays `^1.28.0`: every
  SDK release in it accepts zod 4, and the tests pass on SDK 1.28.0 and 1.32.2.
- The tools, their inputs and limits, their responses, and the server
  instructions are unchanged. Two things a client can see are different:
  - The input schemas in the tool list no longer say
    `"additionalProperties": false`. The server has never refused an argument
    it doesn't know: it drops it, in this release as in 0.1.9. The schemas now
    say what the server does.
  - When an argument is rejected, the error text is zod 4's. For example,
    `Too big: expected array to have <=20 items at files`, where 0.1.9 said
    `Array must contain at most 20 element(s) at files`. The same arguments
    are rejected, with the same error code, and the message names the same
    input.
- The core range stays `>=0.17.5 <0.19.0`, so a new install gets core 0.18.1,
  and the lockfile pins it.

## 0.1.9 - 2026-10-31

- Depend on `@vibecompass/vibecompass` `>=0.17.5 <0.19.0`, so a new install
  gets core 0.18.0. The range keeps 0.17.5 as its lowest version, the first
  that exports the brief settings reader `get_brief` uses, and the tests pass
  on both. The lockfile pins core 0.18.0.
- The lockfile resolves `@modelcontextprotocol/sdk` 1.32.2 (was 1.32.1) and
  nine of its dependencies at newer patch or minor versions, within the same
  ranges. That clears two `npm audit` findings, in body-parser and fast-uri.
  One high finding remains, in zod 3 (GHSA-mrhx-c7xc-m3w5): no 3.x release
  fixes it, and the fix is zod 4, which a later release adopts. The lockfile
  isn't published, so an install resolves these versions from the same ranges.
- With core 0.18.0, the messages `get_brief` relays from the brief engine,
  such as an `incomplete` brief's reason, name no decision by number. The
  tools, their inputs and responses, the server instructions, and the token
  budgets are unchanged.

## 0.1.8 - 2026-10-19

- `get_brief`, opt-in (D-386). On a local root whose `project.yaml` sets
  `brief.enabled: true`, Local and Hybrid mode offer `get_brief`. It returns
  the session brief for a task: the markdown exactly as `vibecompass brief`
  prints it, then its metadata as compact JSON with units as references.
  Inputs are `task`, and optionally `files`, `feature_slugs`, `claims`,
  `lane_id`, and `budget` (800 to 6,000, default 6,000). The tool never picks
  a session lane itself.
- The tool isn't listed in Hosted mode, or when the setting is absent, false,
  or anything but the boolean `true`. The server checks the setting when it
  starts. If the setting is turned off while it runs, each call returns a
  note and builds nothing.
- The markdown keeps the brief's own budget instead of the 2,500-token cap;
  the JSON metadata passes the cap. A call that fails or takes more than 5
  seconds returns an error with no brief. A brief is never served from a
  cache, so it can't carry text the root now excludes.
- Each call builds in its own worker thread, which the server terminates at
  the 5-second limit. The limit holds while the engine computes, and the
  other tools keep answering meanwhile.
- The server instructions are unchanged and never mention `get_brief`. Its
  description calls the brief a starting point, not the whole context.
- The lockfile resolves `@modelcontextprotocol/sdk` 1.32.1 (was 1.28.0),
  within the same `^1.28` range; `npm audit` reports no findings (was 9).
- Depend on `@vibecompass/vibecompass` `^0.17.5`, which exports the brief
  settings reader `get_brief` uses.

## 0.1.7 - 2026-10-18

- Local token budgets match hosted (D-053, D-385). `get_project_context` and
  `get_feature_context` shed to a 2,000-token budget in hosted's tier order,
  and every Local read response passes the 2,500-token hard cap, which returns
  `{ _truncated, _note, _data_preview }` like hosted. Local responses put
  their notes first, so a capped preview still carries them. Before this,
  Local responses had no budget. One Local-only tier sheds component details, next
  steps, retrieval guidance, and warning lists right after decision
  descriptions, with a note to read the component's doc.
- Local `get_project_context` lists hosted's 5 recent decisions, as id and
  title, instead of 20 full entries.
- Local `get_feature_context` adds `decisions` (the newest 20 in the feature's
  domain decision file) and `conflicts` (empty, with a note), so it has
  hosted's fields. Both responses say that Local decisions are filtered by
  domain file, because decision entries carry no feature link.
- Local `get_decision_log(feature_slug)` now reads every decision in the
  domain file. It used to filter only the newest 100 decisions overall, so
  older domain files came back empty. The limit is clamped to 1–100 as in
  hosted.
- The server sends MCP `instructions` describing the tools and where the
  source of truth is for its mode, and reports its version from
  `package.json` (it reported 0.1.0).
- Depend on `@vibecompass/vibecompass` `^0.17.4`. The read-model functions
  Local mode consumes keep their signatures.

## 0.1.6 - 2026-10-03

- Depend on `@vibecompass/vibecompass` `^0.17.0`. Core 0.17.0 improves the
  opt-in session brief's retrieval and framing and fixes a rare decision-lineage
  parsing case (a fenced example closed by a different fence character). The
  read-model functions Local mode consumes keep their signatures, so this is a
  compatibility release with no MCP feature changes.

## 0.1.5 - 2026-09-30

- Depend on `@vibecompass/vibecompass` `^0.16.0`. Core 0.16.0 adds the read
  model's decision lineage and retrieval fields, `vibecompass brief`, and the
  opt-in lane brief (D-368). The read-model contract Local mode consumes is
  unchanged, so this is a compatibility release with no MCP feature changes.
  MCP brief delivery (`get_brief`) is planned separately.

Earlier releases are recorded in the git history.
