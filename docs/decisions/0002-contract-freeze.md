# ADR-0002: Compatibility contract frozen at the vendored submodule pin

Status: accepted · Date: 2026-10-24 · Refines ADR-0001 D5.

## Context

ADR-0001 D5 said: "update the pin to the newest stable release at SPEC-0004 time and
freeze that tag's swagger as the compatibility contract." Facts established since:

- The submodule pin is `v29.0.0-dev-208-gfc49368845` — a 2026 **dev snapshot**, newer
  than the newest stable tag (`v28.2.0`). The original "v1.22-era" description was wrong.
- All SPEC citations (0002/0003/0004, and the in-flight 0001a/0005 work) reference this
  exact pin; SPEC-0004's 350-path taxonomy, status-code census, and pagination rules
  were extracted programmatically from this pin's swagger.
- Cloudflare account is logged in and no `cf-gitea` D1/R2 resources exist yet
  (Wave-3 provisioning; names are free).

## Decision

1. **Freeze the contract at the current pin.** The compatibility contract is
   `gitea/templates/swagger/v1-swagger.generated.json` at `fc49368845`, copied verbatim
   into the repo at implementation time (per SPEC-0004 §5) and never edited.
2. **Do not re-pin mid-build.** Not to `v28.2.0` (older than the code we cited) and not
   opportunistically to main (citation churn while SPECs are being implemented).
3. **`GET /api/v1/version` reports the pinned upstream version string** (SPEC-0004
   open question 1, resolved): SDKs gate behavior on it; single constant so a re-pin
   updates one line.

## Re-pin procedure (deliberate compat-release events only)

1. Update the submodule to the target tag; record the new `git describe`.
2. Regenerate the copied contract file (verbatim copy; never hand-patched).
3. The SPEC-0004 §5 CI stages (route-contract check, schema diff, compat suite) run
   against the NEW contract; the diff output drives SPEC amendments.
4. Every upstream `file:line` citation in SPEC-0002/0003/0005/0006 is re-verified
   (each SPEC records its citations; the drift note in SPEC-0002 §preamble is the model).
5. `/version` constant and tier assignments updated in the same change.

## Consequences

- Contract stability while the surface is built; upstream drift becomes an explicit,
  reviewable re-pin event instead of silent divergence.
- Accepted risk: v29-dev behaviors may change before v29 stable — the freeze makes our
  surface deterministic regardless, and the re-pin procedure absorbs the eventual move.
