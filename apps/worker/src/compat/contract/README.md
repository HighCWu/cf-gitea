# Frozen API compatibility contract

`v1-swagger.generated.json` is a **verbatim, never-edited** copy of
`gitea/templates/swagger/v1-swagger.generated.json` at the pinned submodule commit
`fc4936884584a41931906553d96c2601d750e6ef` (`v29.0.0-dev-208-gfc49368845`).

- sha256: `529a33141a2dddc4e15a0c842c6babad66d14b3b3ee39a9b19eedc55a31a2bd4`
- Authority: ADR-0002 (contract freeze at the pin). `scripts/check-openapi.mjs`
  reads THIS copy, not the submodule, so contract checks are independent of the
  submodule's working-tree state.
- Regeneration (only at a deliberate re-pin, per ADR-0002's procedure):
  `cp gitea/templates/swagger/v1-swagger.generated.json .` after moving the
  submodule, then update the sha256 here and re-run `pnpm check:api`.
