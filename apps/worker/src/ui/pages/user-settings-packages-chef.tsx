/**
 * The USER settings PACKAGES tab's CHEF keypair web arm — upstream's
 * `POST /user/settings/packages/chef/regenerate_keypair` (web.go:718 →
 * routers/web/user/setting/packages.go:103-119 RegenerateChefKeyPair) plus
 * the settings-page SECTION that renders the regenerate button
 * (templates/user/settings/packages.tmpl:6-21 — the section exists at the
 * USER scope ONLY; org/settings/packages.tmpl wraps cleanup_rules/list +
 * cargo and has no chef block). Built over the LANDED chef-auth service
 * (services/packages/chef-auth.ts — getChefPublicPem/setChefPublicPem/
 * generateChefKeyPair; that module is a read-only dependency). This module
 * carries the section + the seams; the thin POST handler lives beside the
 * other packages handlers in ui/index.ts (the landed family's shape — the
 * OAuth2CommonHandlers-style split: module seams, index.ts thin handlers).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `web.go:718` — `m.Post("/chef/regenerate_keypair",
 *     user_setting.RegenerateChefKeyPair)` inside the `/packages` group
 *     (:701-719) of the reqSignIn `/user/settings` subtree, behind
 *     `packagesEnabled` (compile-time TRUE in the landed posture — the
 *     packages family's header). POST-ONLY: upstream registers no GET, so
 *     chi answers 405 (the landed runners-reset precedent).
 *   - `setting/packages.go:103-119` — the whole handler: `priv, pub :=
 *     util.GenerateKeyPair(chef_module.KeyBits)` (KeyBits=4096,
 *     modules/packages/chef/metadata.go:20 — the service's default), the
 *     error arms are bare `ctx.ServerError` (500 — here: the errors
 *     propagate to the app-level onError; the handler has NO input arms,
 *     there is nothing to bind), `user_model.SetUserSetting(ctx,
 *     ctx.Doer.ID, SettingPublicPem, pub)` — ONLY the public PEM is
 *     stored — and `ctx.ServeContent(strings.NewReader(priv),
 *     ServeHeaderOptions{ContentType: "application/x-pem-file",
 *     Filename: ctx.Doer.Name + ".priv"})`: the PRIVATE key streams back
 *     as the `{username}.priv` download.
 *   - The serve headers (services/context/base.go:178-181 = ServeSetHeaders
 *     + net/http ServeContent): `content-type: application/x-pem-file`,
 *     `x-content-type-options: nosniff`, the sandbox-default
 *     `content-security-policy` (serve.go:56-75 — not pdf/audio/video),
 *     `content-disposition: attachment; filename=…` (ContentDisposition
 *     zero → attachment, serve.go:91; path.Base + mime encoding over the
 *     landed contentDispositionAttachment port), the
 *     `access-control-expose-headers` echo (serve.go:93), `cache-control:
 *     max-age=0, private, must-revalidate` (httpcache.go:31-35 — zero
 *     MaxAge, not public), NO `last-modified` (upstream passes no
 *     LastModified — the zero time skips serve.go:101-104), and
 *     `accept-ranges: bytes` + `content-length` from http.ServeContent's
 *     seekable-reader walk.
 *   - The SECTION (packages.tmpl:6-21 — the user frame's
 *     `user-setting-content`, after the cleanup_rules/list + cargo
 *     templates): an `h4.ui.top.attached.header` carrying
 *     `packages.owner.settings.chef.title`, an `attached segment` with a
 *     `ui form` of three fields — the keypair description label, the
 *     regenerate `<form class="field" action="{{.Link}}/chef/
 *     regenerate_keypair" method="post">` whose ONLY control is the
 *     primary submit button (`packages.owner.settings.chef.keypair`), and
 *     the `packages.registry.documentation` label with ("Chef",
 *     "https://docs.gitea.com/usage/packages/chef/"). NO confirm dialog —
 *     the form is a bare POST (no data-* / fetch-action attributes, the
 *     template's exact shape).
 *   - Locale keys (gitea/options/locale/locale_en-US.json at the pin):
 *     `packages.owner.settings.chef.title` "Chef Registry";
 *     `packages.owner.settings.chef.keypair` "Generate key pair";
 *     `packages.owner.settings.chef.keypair.description` "A key pair is
 *     necessary to authenticate to the Chef registry. If you have
 *     generated a key pair before, generating a new key pair will discard
 *     the old key pair."; `packages.registry.documentation` "For more
 *     information on the %s registry, see <a target="_blank"
 *     rel="noopener noreferrer" href="%s">the documentation</a>."
 *     (rendered structurally in JSX — the anchor is an element, never a
 *     raw-HTML sink).
 *
 * ## The key-state read
 *
 * The section's data loader (`loadChefKeypairSectionData`) reads whether a
 * `chef.public_pem` user setting exists (the service's getChefPublicPem —
 * upstream `user_model.GetSetting`, auth.go:103's read twin). Upstream's
 * TEMPLATE renders no indicator of the key state (the markup is identical
 * with and without a stored key — pinned by the tests), so the flag rides
 * the data record WITHOUT branching the render: it is the seam the GET
 * fold-back consumes (and any future honest state display would hang off),
 * not a rendered divergence.
 *
 * ## The private-key-once posture
 *
 * The private PEM exists ONLY in the POST response body — the store keeps
 * the public PEM alone (SetUserSetting carries `pub`, never `priv`), no
 * table/row/state ever holds the private bytes, and a reload of the page
 * shows nothing: there is no read-back path for private material at all
 * (the b91dd1c OAuth2 secret-once precedent's download-shaped twin). Each
 * POST generates a FRESH pair; the previous public key is discarded
 * (SetUserSetting upserts — the service's onConflictDoUpdate).
 *
 * ## Composition + the GET fold-back recipe (the landed page is NOT this
 * unit's file)
 *
 * The landed pages/user-settings-packages.tsx documents the chef section
 * as NOT RENDERED (its "no chef substrate" omission — written before the
 * chef-auth service landed) and its test pins the section's absence in
 * that module's render. The POST surface mounts LIVE through this module
 * (ui/index.ts hunks); the SECTION reaches the GET page through the
 * orchestrator's landing fold, which is one import + one render call:
 *
 *   1. pages/user-settings-packages.tsx — import `ChefKeypairSection`
 *      from "./user-settings-packages-chef" and replace the trailing
 *      "chef keypair section: NOT RENDERED" comment inside
 *      `user-setting-content` (after the cleanup-rules segment, the
 *      packages.tmpl:4→6 order) with `<ChefKeypairSection base={base} />`
 *      (the module's `base` is already the fixed `/user/settings/packages`
 *      literal).
 *   2. The page's GET handler (index.ts `userPackagesPage`) gains the key
 *      state read if the fold wants the loader consumed:
 *      `await loadChefKeypairSectionData(c.env.DB, user.id)` — the render
 *      is state-independent, so wiring it is optional.
 *   3. pages/user-settings-packages.test.tsx — flip the two "no chef"
 *      pins (:375-376) to positive pins (the form action + the "Chef
 *      Registry" header present).
 *
 * ## Mount (executed — the ui/index.ts hunks this unit owns)
 *
 *   - parseUiRoute (the `raw[1] === "user" && raw[2] === "settings"`
 *     block, inside the packages family's claim group after the
 *     rule-preview arm — the static literal; the junk/deeper tails stay
 *     unclaimed → the engine's 404):
 *     `tail.length === 3 && tail[0] === "packages" && tail[1] === "chef"
 *     && tail[2] === "regenerate_keypair"` →
 *     `{ family: "user-settings-packages-chef-regenerate", id: null }`.
 *   - `uiRouter.post("/user/settings/packages/chef/regenerate_keypair",
 *     (c) => userPackagesChefRegenerateKeypair(c))` + the GET twin
 *     `methodNotAllowed("POST")`.
 *
 * Tests drive the module arms directly (renderToString over the section,
 * the loader, the rotate seam, the response builder) and the mounted POST
 * live through `uiRouter.fetch` + a minted session (the user-settings-keys
 * route harness).
 */

import { contentDispositionAttachment } from "../../services/packages/serve-content";
import {
  generateChefKeyPair,
  getChefPublicPem,
  setChefPublicPem,
} from "../../services/packages/chef-auth";

// ---------------------------------------------------------------------------
// The locale (gitea/options/locale/locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

export const userSettingsChefLocale = {
  /** "packages.owner.settings.chef.title" */
  title: "Chef Registry",
  /** "packages.owner.settings.chef.keypair.description" */
  keypair_description:
    "A key pair is necessary to authenticate to the Chef registry. If you have generated a key pair before, generating a new key pair will discard the old key pair.",
  /** "packages.owner.settings.chef.keypair" */
  keypair: "Generate key pair",
  /** "packages.registry.documentation" — the two %s args are rendered
   *  structurally (the anchor is a JSX element, never a raw-HTML sink). */
  documentation_registry: "Chef",
  documentation_url: "https://docs.gitea.com/usage/packages/chef/",
  documentation_link_text: "the documentation",
} as const;

// ---------------------------------------------------------------------------
// The key-state read (the section's data arm)
// ---------------------------------------------------------------------------

/** The section's data record. `hasPublicPem` is the chef.public_pem
 *  presence read; the template renders NO state indicator, so the markup
 *  does not branch on it (the module header's key-state note). */
export interface ChefKeypairSectionData {
  hasPublicPem: boolean;
}

/** `user_model.GetSetting(ctx, u.ID, SettingPublicPem)`'s presence walk
 *  (auth.go:103) — the section loader for the GET fold-back. */
export async function loadChefKeypairSectionData(d1: D1Database, userId: number): Promise<ChefKeypairSectionData> {
  return { hasPublicPem: (await getChefPublicPem(d1, userId)) !== null };
}

// ---------------------------------------------------------------------------
// The regenerate seam — setting/packages.go:103-119's body
// ---------------------------------------------------------------------------

/**
 * RegenerateChefKeyPair's body (:104-112): `util.GenerateKeyPair(KeyBits)`
 * (the service's 4096 default), then `SetUserSetting(SettingPublicPem,
 * pub)` — ONLY the public PEM persists — and the PRIVATE PEM returns for
 * the caller's single response. The upstream error arms are bare
 * `ctx.ServerError` (:105-108); there are no input fields, so this seam
 * has no validation ladder — a failure propagates to the app-level onError
 * (the honest 500 map, no partial state: the generate precedes the store).
 */
export async function regenerateChefKeypair(d1: D1Database, userId: number): Promise<string> {
  const pair = await generateChefKeyPair();
  await setChefPublicPem(d1, userId, pair.publicPem);
  return pair.privatePem;
}

// ---------------------------------------------------------------------------
// The private-key download — ctx.ServeContent's exact header set
// ---------------------------------------------------------------------------

/**
 * ServeContent(strings.NewReader(priv), {ContentType:
 * "application/x-pem-file", Filename: ctx.Doer.Name + ".priv"})
 * (setting/packages.go:113-118 → base.go:178-181): ServeSetHeaders'
 * content block + the attachment disposition + the zero-MaxAge private
 * cache posture (each line's cite inline), then net/http ServeContent's
 * seekable-reader `accept-ranges` + `content-length`. NO last-modified —
 * upstream passes no LastModified (serve.go:101's zero-time skip). The
 * body is the PRIVATE PEM verbatim, generated fresh, persisted nowhere.
 */
export function chefKeypairDownloadResponse(username: string, privatePem: string): Response {
  const body = new TextEncoder().encode(privatePem);
  return new Response(body, {
    status: 200,
    headers: {
      // serveSetHeaderContentRelated (serve.go:56-75 — the non-pdf,
      // non-audio/video CSP default).
      "content-type": "application/x-pem-file",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox allow-scripts allow-modals allow-popups allow-downloads",
      // ServeSetHeaders' filename arm (serve.go:90-93): ContentDisposition
      // zero → attachment; path.Base + the mime encoding ride the landed
      // contentDispositionAttachment port (the Go-oracle-verified shape).
      "content-disposition": contentDispositionAttachment(`${username}.priv`),
      "access-control-expose-headers": "Content-Disposition",
      // SetCacheControlInHeader (httpcache.go:31-35): CacheDuration zero,
      // IsPublic false — the prod posture.
      "cache-control": "max-age=0, private, must-revalidate",
      // http.ServeContent (base.go:178-181's second step — the seekable
      // reader advertises the byte range posture).
      "accept-ranges": "bytes",
      "content-length": String(body.byteLength),
    },
  });
}

// ---------------------------------------------------------------------------
// The section — packages.tmpl:6-21 (the fold-back renders this inside the
// user-setting-content div, after the cleanup-rules segment)
// ---------------------------------------------------------------------------

/**
 * The chef keypair section. `base` is the page URI `{{.Link}}` — the user
 * settings packages page's fixed `/user/settings/packages` (the landed
 * list page's base literal), so the form action is
 * `{Link}/chef/regenerate_keypair` byte-exactly. The markup is identical
 * whether a public PEM is stored or not (the template renders no
 * indicator — the header's key-state note).
 */
export function ChefKeypairSection(props: { base: string }) {
  return (
    <>
      <h4 class="ui top attached header">{userSettingsChefLocale.title}</h4>
      <div class="ui attached segment">
        <div class="ui form">
          <div class="field">
            <label>{userSettingsChefLocale.keypair_description}</label>
          </div>
          {/* packages.tmpl:14-16 — the bare POST (NO confirm dialog: no
              data-* / fetch-action attributes upstream). */}
          <form class="field" action={`${props.base}/chef/regenerate_keypair`} method="post">
            <button type="submit" class="ui primary button">{userSettingsChefLocale.keypair}</button>
          </form>
          <div class="field">
            {/* packages.tmpl:17-19 — packages.registry.documentation with
                ("Chef", the chef docs URL); the anchor is structural. */}
            <label>
              {`For more information on the ${userSettingsChefLocale.documentation_registry} registry, see `}
              <a target="_blank" rel="noopener noreferrer" href={userSettingsChefLocale.documentation_url}>
                {userSettingsChefLocale.documentation_link_text}
              </a>
              .
            </label>
          </div>
        </div>
      </div>
    </>
  );
}
