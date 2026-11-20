# Frozen API compatibility contract

`v1-swagger.generated.json` is a **verbatim, never-edited** copy of
`gitea/templates/swagger/v1-swagger.generated.json` at the pinned submodule commit
`099abf5db47dd5cf797d8898f6aaa06ccdf77c24` (`v29.0.0-dev-439-g099abf5db4`).

- sha256: `62829f72ea749dc351296968e0e90829f89dc6f8a6453cd6d52c5748ca37b2c6`
- Authority: ADR-0002 (contract freeze at the pin). `scripts/check-openapi.mjs`
  reads THIS copy, not the submodule, so contract checks are independent of the
  submodule's working-tree state.
- Re-pin note (099abf5db4): upstream 5671c5192d folded every operation's
  explicit error docs into `default` — doc-only (the handlers still answer the
  explicit codes); `scripts/check-openapi.mjs` carries the DEFAULT-FOLD
  EQUIVALENCE rule plus per-op exceptions for the multi-success ops that
  keep the strict rule.
- Regeneration (only at a deliberate re-pin, per ADR-0002's procedure):
  `cp gitea/templates/swagger/v1-swagger.generated.json .` after moving the
  submodule, then update the sha256 here and re-run `pnpm check:api`.
