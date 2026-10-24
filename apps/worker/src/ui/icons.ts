/**
 * Stable facade over the generated icon data (SPEC-0008 §2.4.1 icons row).
 * The SVG path bodies live in the GITIGNORED icons.generated.ts, rebuilt by
 * `pnpm gen:icons` (scripts/gen-ui-icons.mjs) from the pinned submodule's
 * committed inputs (gitea/public/assets/img/svg/octicon-<name>.svg; wired
 * as predev/prebuild/pretest and a CI step before typecheck — same model as
 * the gitignored assets build output). This file stays committed and
 * unchanged across regenerations, so importers (shell.tsx) and diffs stay
 * stable. The rendering `Icon` component lives in shell.tsx; this module is
 * data-only.
 */

export { ICON_PATHS } from "./icons.generated";
export type { IconName } from "./icons.generated";
