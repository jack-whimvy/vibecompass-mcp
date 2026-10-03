# Changelog

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
