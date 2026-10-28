/**
 * The user settings ACCOUNT tab, `/user/settings/account` — the
 * user-settings family's credentials tab (bench row `wave-settings-account`,
 * MOUNTED at 2f7afe9 — the routes live in `index.ts`).
 *
 * Upstream pin: `routers/web/user/setting/account.go` over
 * `templates/user/settings/account.tmpl`, mounted at web.go:641-647's
 * `/account` group inside the reqSignIn `/user/settings` group:
 *
 *   GET  /user/settings/account            → Account        (the page)
 *   POST /user/settings/account            → AccountPost    (change password)
 *   POST /user/settings/account/email      → EmailPost      (add / PRIMARY /
 *                                            SENDACTIVATION via `_method`)
 *   POST /user/settings/account/email/delete → DeleteEmail
 *   POST /user/settings/account/delete     → DeleteAccount  (user suicide —
 *                                            this tab owns it; verified: the
 *                                            security tab mounts no deletion)
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the wiring HANDOFF is retired)
 *
 * Every arm (GET and POST) resolves the doer's users ROW through
 * `loadUserSettingsAccountPageData` — a `null` (the session doer has no D1
 * row) 404-shells (`renderNotFound`, the silent-auth-failure convention);
 * the row feeds the apply functions and the same load renders the page.
 *   GET /user/settings/account → `userSettingsTabPrologue(c, false)` →
 *            `loadUserSettingsAccountPageData`; a `null` data (the session
 *            doer has no D1 row) 404-shells (`renderNotFound`, the
 *            silent-auth-failure convention), else
 *            `renderUserSettingsAccountPage(p.ctx, data)`.
 *   POST /user/settings/account/email → `userSettingsTabPrologue(c, true)`
 *            (sameOriginGuard FIRST — §2.8), `readUrlEncodedForm`,
 *            `parseUserSettingsAccountEmailForm`,
 *            `applyUserSettingsAccountEmailForm(c.env.DB, <the loaded user
 *            row>, form)`:
 *              "added"/"primary"/"redirect" → 303 onto
 *              `/user/settings/account` (upstream's Redirect/
 *              JSONRedirect; the flash lines — add_email_success,
 *              email_deletion_success, email_primary_not_found — do not
 *              render, the family's no-flash reduction);
 *              "invalid" → reload the page data and re-render at 200 with
 *              `{ error: outcome.message, email: form.email }` (upstream's
 *              RenderWithErrDeprecated arm; the submitted email IS carried —
 *              it is not secret-like).
 *   POST /user/settings/account/email/delete → the prologue(true), the
 *            delete parse + `deleteUserSettingsAccountEmail`; BOTH outcomes
 *            303 back (a stale/foreign id is the idempotent silent-303
 *            reduction — upstream's miss is a ServerError 500, unreachable
 *            from the rendered page and worthless to reproduce; the flash
 *            success does not render).
 *   POST /user/settings/account/delete → the prologue(true), the delete
 *            parse + `applyUserSettingsAccountDeleteForm(c.env.DB, <the
 *            loaded user row>, form)`:
 *              "deleted" → 303 onto `/` (upstream JSONRedirect("/") — the
 *              users-row delete cascades the session rows, so the redirect
 *              lands anonymous exactly like upstream);
 *              "invalid" → reload and re-render at 200 with the message;
 *              the password input re-renders EMPTY — the re-auth credential
 *              is never carried back into the DOM (the secrets value rule).
 *
 * ## Nav (components/settings-nav.tsx — the swap LANDED in the mount window)
 *
 * The page renders the SHARED `UserSettingsNavbar active="account"` — the
 * wave-114 consolidation convention (the organizations precedent): the
 * mount window added `"account"` to `UserSettingsNavTab`, the
 * `settingsNavLocale` key + item (between Profile and Appearance,
 * navbar.tmpl:7-11's exact position — the upstream
 * `manage_credentials`/`deletion` disabled-features gate is unmodelled:
 * upstream's default is enabled, the security module's wrapper-gate
 * posture), and deleted this module's local `AccountSettingsNav` copy.
 *
 * ## The password arm — UNMOUNTED (the standing no-password-model rule)
 *
 * cf-gitea has NO password credential at all: the login credential IS a PAT
 * (pages/login.tsx; SPEC-0010 §1.3), `users` carries no passwd column
 * (schema.ts), and no hashing/verify service exists (src/auth is
 * token-only). The security module (pages/user-settings-security.tsx) already
 * recorded the family rule: "no password form renders anywhere". Upstream's
 * own template answers the same shape for credential-less accounts — the
 * `{{else}}` arm of the IsLocal/IsOAuth2 gate (account.tmpl:30-34): the
 * section header + the `settings.password_change_disabled` info message.
 * That arm renders here; the change-password form (account.tmpl:8-29,
 * ChangePasswordForm old_password/password/retype) and its POST
 * (AccountPost: the ValidatePassword check, the MinLength/Complexity/Pwned
 * ladder, UpdateAuth) stay UNMOUNTED — no store backs them, and per the
 * security-module precedent an unbacked write mounts nothing. The
 * forgot-password link rides the form arm and never renders. A future
 * password wave needs, before this form can land: a passwd column +
 * migration, a hashing service, and a session-rotation-on-change hook
 * (src/ui/session.ts's rotateSession is the seam) — then the form renders
 * per account.tmpl:8-29 exactly.
 *
 * ## The email arms — FULLY PORTED (the no-mail convention)
 *
 * The landed store is migration 0016's `email_addresses` (schema.ts: the
 * column-faithful EmailAddress port) with the SPEC-0002 model: the PRIMARY
 * lives on `users.email`, rows are secondaries, and the read side unions the
 * primary back as a SYNTHESIZED entry when no row carries it (the
 * routes/misc-t3.ts email-service port's exact rule). The repo's no-mail
 * convention is upstream's `RegisterEmailConfirm = false` default (the
 * schema's isActivated note; misc-t3's "API-added addresses activate
 * immediately"): NO mail pipeline exists, nothing is ever pending, so
 *
 *   - the ADD arm behaves like upstream with the setting false: validate →
 *     used-check → insert an ACTIVATED row → the success flash (which does
 *     not render) → redirect. The validation failures are upstream's two
 *     RenderWithErrDeprecated arms (form.email_been_used /
 *     form.email_invalid) — re-render 200 with the message + carried email.
 *   - the SENDACTIVATION arm (`_method=SENDACTIVATION`, account.go:81-115)
 *     is UNREACHABLE: it renders only for `not .IsActivated` rows
 *     (account.tmpl:70-80) and no cf-gitea write path inserts one. The
 *     button never renders; a forged post answers upstream's
 *     already-activated arm (account.go:96-99: log.Debug + silent Redirect)
 *     as the `{ outcome: "redirect" }` no-op. Unmounted-but-faithful.
 *   - the PRIMARY arm (`_method=PRIMARY`, MakeActiveEmailPrimary,
 *     email_address.go:250-298) ports the three-step tx onto the
 *     synthesized-primary model: step 1 (user.Email = the row's address)
 *     is `users.email` UPDATE; step 2 (demote the old primary row) IS a
 *     materialization here — the old address leaves `users.email`, so a
 *     demoted ACTIVATED row is inserted for it (the inverse of the read
 *     rule; skipped when a row already carries it); step 3 (promote the new
 *     row) is a no-op — promotion is the users.email match the loader
 *     derives. The activated-gate and not-exist arms port: a foreign/
 *     null/unactivated id answers the flash-error arm (email_primary_not_
 *     found + Redirect) as the silent 303.
 *   - the DELETE arm (DeleteEmail → DeleteEmailAddresses) deletes the
 *     doer-scoped row by id. The synthesized primary has no row id and the
 *     template renders no Remove button on a primary — ours renders none on
 *     id-null entries either; the never-buttoned arms cannot be forged into
 *     deleting users.email (rows cannot duplicate it — the add path treats
 *     it as taken).
 *
 * The list loader derives `isPrimary` per entry from the users.email match
 * (the store's isPrimary column is never written — schema.ts's note), so a
 * PRIMARY flip renders without any flag write, exactly like upstream's
 * demote/promote render.
 *
 * ## The deletion arm — PORTED over the PAT-as-password model
 *
 * Upstream DeleteAccount (account.go:230-274): auth.UserSignIn(name,
 * password) → the admin self-guard → user.DeleteUser(doer, false) with its
 * last-admin / owns-repos / has-orgs / owns-packages guards, then
 * JSONRedirect("/"). The cf-gitea port keeps the exact guard ORDER and
 * messages, with two documented credential-model reductions:
 *
 *   - UserSignIn's port is the login POST's own verification convention:
 *     the posted `password` IS a PAT (TokenService.verify — prefix lookup +
 *     sha256 + timing-safe compare + expiry, the login flow's step 2). It
 *     must verify AND belong to the doer (a credential valid for another
 *     account fails this check, upstream's per-account password semantics).
 *     A failure answers the UserSignIn switch's invalid-password arm
 *     (form.enterred_invalid_password). The unset_password arm is not
 *     reachable in this model: every doer presents a token or fails the
 *     check.
 *   - owns-packages: cf-gitea models no packages store — the guard's
 *     `count > 0` is never producible (the still_own_packages message is
 *     dead upstream too under disabled packages).
 *
 * The cascade is the landed admin DELETE /users/{username} ladder's exact
 * shape (routes/admin-t2.ts:972-1005): the scrub
 * (`scrubUserFromAllRules`, services/branch-protection — the
 * RemoveUserIDFromProtectedBranch sweep, services/user/delete.go:134-155)
 * then the D1 batch (watchers, collaborators, reactions, issue
 * subscriptions, the users row — the deleteUser DeleteBeans census,
 * delete.go:74-103; FK cascades carry tokens/sessions/emails/memberships/
 * redirects/follows/stars/settings). The users-row delete cascades the
 * doer's session rows (schema.ts sessions FK), so the 303 onto `/` lands
 * anonymous — upstream's own post-deletion shape. Upstream's
 * UserDeleteWithComments ghost-comment window (account.tmpl:114-116,
 * loadAccountData's `UserDeleteWithCommentsMaxTime != 0` gate) renders
 * nothing: the setting's default is 0 (disabled).
 *
 * The `manage_credentials` / `deletion` UserDisabledFeatures gates never
 * fire: cf-gitea models no per-user disabled-feature list and upstream's
 * default is enabled (the security module's wrapper-gate posture).
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { TokenService } from "../../auth/token-service";
import { scrubUserFromAllRules } from "../../services/branch-protection";
import {
  emailAddresses,
  issueSubscriptions,
  orgMembers,
  reactions,
  repoCollaborators,
  repositories,
  repoWatchers,
  users,
} from "../../db/schema";
import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key, the pin's
// locale_en-US.json texts)
// ---------------------------------------------------------------------------

export const userSettingsAccountLocale = {
  account: "Account", // "settings.account" (the title — ctx.Data["Title"], account.go:38 — + the navbar item)
  password: "Password", // "settings.password" (the section header, account.tmpl:4)
  password_change_disabled:
    "Non-local users cannot update their password through the Gitea web interface.", // "settings.password_change_disabled" (the else arm, account.tmpl:32)
  manage_emails: "Manage Email Addresses", // "settings.manage_emails" (account.tmpl:39)
  primary: "Primary", // "settings.primary"
  activated: "Activated", // "settings.activated"
  requires_activation: "Requires activation", // "settings.requires_activation"
  delete_email: "Remove", // "settings.delete_email" (the row's Remove button)
  primary_email: "Make Primary", // "settings.primary_email"
  add_new_email: "Add New Email Address", // "settings.add_new_email"
  add_email: "Add Email Address", // "settings.add_email"
  delete_account: "Delete Your Account", // "settings.delete_account" (the error header, account.tmpl:109)
  confirm_delete_account: "Confirm Deletion", // "settings.confirm_delete_account"
  delete_prompt_prefix: "This operation will permanently delete your user account. It ", // "settings.delete_prompt" — the <strong>CANNOT</strong> markup renders as elements
  delete_prompt_strong: "CANNOT", // the strong arm of the same prompt
  delete_prompt_suffix: " be undone.", // the prompt's tail
  password_label: "Password", // "password" (the deletion form's field label, account.tmpl:121)
  // The apply functions' message texts (the upstream switches' exact lines).
  email_been_used: "The email address is already used.", // "form.email_been_used" (account.go:158)
  email_invalid: "The email address is invalid.", // "form.email_invalid" (account.go:163)
  enterred_invalid_password: "The password you entered is incorrect.", // "form.enterred_invalid_password" (account.go:248)
  admin_cannot_delete_self:
    "You cannot delete yourself when you are an admin. Please remove your admin privileges first.", // "form.admin_cannot_delete_self" (account.go:257)
  still_own_repo: "Your account owns one or more repositories. Delete or transfer them first.", // "form.still_own_repo" (account.go:264)
  still_has_org: "Your account is a member of one or more organizations. Leave them first.", // "form.still_has_org" (account.go:267)
  last_admin: "You cannot remove the last admin. There must be at least one admin.", // "auth.last_admin" (DeleteUser's ErrDeleteLastAdminUser arm, account.go:270)
} as const;

/** The page's full `users` row (schema.ts) — the email arms read
 *  `users.email`, the deletion arm reads `isAdmin`. */
export type UserSettingsAccountUser = typeof users.$inferSelect;

/** One renderable email entry (upstream loadAccountData's
 *  `UserEmail{EmailAddress, CanBePrimary}`, account.go:277-290). `id` is
 *  null for the SYNTHESIZED primary (users.email with no row) — the
 *  synthesized entry renders no buttons, like any primary. */
export interface AccountEmailEntry {
  id: number | null;
  email: string;
  isActivated: boolean;
  isPrimary: boolean;
  /** Upstream `CanBePrimary = IsActivated` (account.go:286). */
  canBePrimary: boolean;
}

/** The page render inputs. */
export interface UserSettingsAccountPageData {
  user: UserSettingsAccountUser;
  emails: AccountEmailEntry[];
}

/**
 * The page load — the doer's full users row (null = the no-row 404 shell)
 * plus the email list: the doer's rows id-ordered (GetEmailAddresses,
 * email_address.go:171-179) with the primary SYNTHESIZED first from
 * `users.email` when no row carries it (the routes/misc-t3.ts read rule —
 * upstream materializes the signup address as the is_primary row at user
 * creation; cf-gitea keeps the primary on users.email). `isPrimary` derives
 * from the users.email match (the store's is_primary column is never
 * written — the schema's note), so the PRIMARY arm's flip renders without a
 * flag write.
 */
export async function loadUserSettingsAccountPageData(d1: D1Database, userId: number): Promise<UserSettingsAccountPageData | null> {
  const db = drizzle(d1);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user === undefined) return null;
  const primaryLower = user.email !== null && user.email !== "" ? user.email.toLowerCase() : null;
  const rows = await db.select().from(emailAddresses).where(eq(emailAddresses.userId, userId)).orderBy(asc(emailAddresses.id));
  const emails: AccountEmailEntry[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    isActivated: row.isActivated,
    isPrimary: primaryLower !== null && row.lowerEmail === primaryLower,
    canBePrimary: row.isActivated,
  }));
  if (primaryLower !== null && !rows.some((row) => row.lowerEmail === primaryLower)) {
    emails.unshift({ id: null, email: user.email!, isActivated: true, isPrimary: true, canBePrimary: true });
  }
  return { user, emails };
}

// ---------------------------------------------------------------------------
// The email arms (upstream EmailPost / DeleteEmail over the synthesized-
// primary model — the module header)
// ---------------------------------------------------------------------------

/** The `/account/email` POST body (AddEmailForm's `email` + the template's
 *  `_method`/`id` pairs, account.tmpl:63-79/91-99; `id` is upstream's
 *  FormInt64 — junk parses null). */
export interface UserSettingsAccountEmailForm {
  method: string;
  id: number | null;
  email: string;
}

export function parseUserSettingsAccountEmailForm(params: URLSearchParams): UserSettingsAccountEmailForm {
  const rawId = params.get("id") ?? "";
  return {
    method: params.get("_method") ?? "",
    id: /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : null,
    email: params.get("email") ?? "",
  };
}

/** The email POST's outcomes — the mount record's render map (the module header). */
export type EmailFormOutcome =
  | { outcome: "added" } // the add arm wrote a row → 303 (upstream Flash.Success + Redirect, account.go:170-176)
  | { outcome: "primary" } // the PRIMARY arm flipped users.email → 303 (upstream Redirect, account.go:76)
  | { outcome: "redirect" } // the silent arms → bare 303 (SENDACTIVATION :96-99 / primary-not-found :67-70 / already-primary)
  | { outcome: "invalid"; message: string }; // the add arm's re-render (RenderWithErrDeprecated :158/:163, 200)

/** Upstream ValidateEmail (email_address.go:121-129) — the routes/misc-t3.ts
 *  port's RFC-5322-lite stand-in for Go's net/mail.ParseAddress (the module
 *  header documents the pragmatic divergence; borderline-syntax addresses
 *  may classify differently, the message does not change). The web binding's
 *  `MaxSize(254)` (AddEmailForm, forms/user_form.go:189-193) rides the same
 *  invalid arm — upstream's binding failure lands in the HasError re-render
 *  beside the invalid-syntax arm. */
function validateEmailFormat(email: string): boolean {
  if (email === "" || email.length > 254 || /[^\x21-\x7e]/.test(email)) {
    return false;
  }
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    return false;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 255) {
    return false;
  }
  if (/^[.-]|[.-]$|\.\./.test(local)) {
    return false;
  }
  if (domain.startsWith("[")) {
    return /^\[(\d{1,3}(\.\d{1,3}){3}|IPv6:[0-9a-fA-F:]+)\]$/.test(domain); // address literal
  }
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(domain);
}

/**
 * The email POST — upstream EmailPost (account.go:60-176) in its pin order:
 * the `_method` arms first (PRIMARY, then SENDACTIVATION), then the add arm.
 *
 * PRIMARY (MakeActiveEmailPrimary, email_address.go:250-298): the id must
 * resolve to the doer's ACTIVATED row — a null/foreign/unactivated id is the
 * flash-error arm (email_primary_not_found + Redirect :67-70) as the silent
 * redirect. The flip: `users.email` takes the row's address (step 1), the
 * old primary MATERIALIZES as a demoted activated row (step 2's demotion in
 * the synthesized-primary model — skipped when a row already carries the
 * address), and step 3's promotion is the loader's users.email derivation.
 * A row that already IS the primary answers the bare redirect (the
 * template's `not .IsPrimary` gate means no button posts it; a re-post
 * no-ops like upstream's flag-rewrite idempotence).
 *
 * SENDACTIVATION (account.go:81-115): unreachable from the DOM (no
 * unactivated row can exist — every insert path writes activated under the
 * no-mail convention); a forged post answers the already-activated arm's
 * silent redirect (:96-99).
 *
 * ADD (user_service.AddEmailAddresses, services/user/email.go:76-121 over
 * the misc-t3 port): validate → the used-check (rows ∪ users.email, global
 * like upstream's GetEmailAddressByEmail) → insert an ACTIVATED secondary
 * (`IsActivated: !RegisterEmailConfirm` with the setting false — the
 * no-mail convention). The invalid-format arm answers form.email_invalid,
 * the used arm form.email_been_used — upstream's exact RenderWithErr
 * texts (:158-166).
 */
export async function applyUserSettingsAccountEmailForm(
  d1: D1Database,
  user: UserSettingsAccountUser,
  form: UserSettingsAccountEmailForm,
): Promise<EmailFormOutcome> {
  const db = drizzle(d1);

  if (form.method === "PRIMARY") {
    if (form.id === null) return { outcome: "redirect" };
    const row = (
      await db
        .select()
        .from(emailAddresses)
        .where(and(eq(emailAddresses.id, form.id), eq(emailAddresses.userId, user.id)))
        .limit(1)
    )[0];
    if (row === undefined || !row.isActivated) return { outcome: "redirect" }; // the email_primary_not_found arm, silent
    const currentLower = user.email !== null && user.email !== "" ? user.email.toLowerCase() : null;
    if (currentLower === row.lowerEmail) return { outcome: "redirect" }; // already the primary — no write
    // Step 2's demotion as a materialization (the module header): the old
    // primary leaves users.email, so it becomes a plain activated row.
    if (currentLower !== null && !(await db.select({ id: emailAddresses.id }).from(emailAddresses).where(eq(emailAddresses.lowerEmail, currentLower)).limit(1)).length) {
      await db.insert(emailAddresses).values({
        userId: user.id,
        email: user.email!,
        lowerEmail: currentLower,
        isActivated: true,
        isPrimary: false,
      });
    }
    // Step 1: users.email takes the row's address (step 3's promotion is the
    // loader's derivation — no flag write exists).
    await db.update(users).set({ email: row.email }).where(eq(users.id, user.id));
    return { outcome: "primary" };
  }

  if (form.method === "SENDACTIVATION") {
    // account.go:96-99 — the already-activated arm's silent redirect (the
    // only reachable shape; the module header).
    return { outcome: "redirect" };
  }

  // The add arm.
  if (!validateEmailFormat(form.email)) {
    return { outcome: "invalid", message: userSettingsAccountLocale.email_invalid };
  }
  const lower = form.email.toLowerCase();
  const rowTaken = (await db.select({ id: emailAddresses.id }).from(emailAddresses).where(eq(emailAddresses.lowerEmail, lower)).limit(1)).length > 0;
  const selfTaken = user.email !== null && user.email.toLowerCase() === lower;
  const scanTaken =
    selfTaken
      ? false
      : (
          await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.type, "user"), sql`lower(${users.email}) = ${lower}`))
            .limit(1)
        ).length > 0;
  if (rowTaken || selfTaken || scanTaken) {
    return { outcome: "invalid", message: userSettingsAccountLocale.email_been_used };
  }
  await db.insert(emailAddresses).values({ userId: user.id, email: form.email, lowerEmail: lower, isActivated: true, isPrimary: false });
  return { outcome: "added" };
}

/** The `/account/email/delete` POST body (upstream's `id` — DeleteEmail's
 *  GetEmailAddressByID, account.go:180). */
export interface UserSettingsAccountEmailDeleteForm {
  id: number | null;
}

export function parseUserSettingsAccountEmailDeleteForm(params: URLSearchParams): UserSettingsAccountEmailDeleteForm {
  const raw = params.get("id") ?? "";
  return { id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/**
 * The email delete — upstream DeleteEmail → DeleteEmailAddresses
 * (account.go:179-199 over services/user/email.go:130-166): resolve the id
 * within the doer's rows, delete the row. `"missing"` covers a null id, a
 * foreign id, and a stale (already-deleted) id — upstream's miss is a
 * ServerError 500 (unreachable from the rendered page; the secrets-delete
 * idempotent-303 reduction covers it) and every outcome 303s back (the
 * flash success does not render).
 */
export async function deleteUserSettingsAccountEmail(d1: D1Database, userId: number, form: UserSettingsAccountEmailDeleteForm): Promise<"deleted" | "missing"> {
  if (form.id === null) return "missing";
  const db = drizzle(d1);
  const row = (
    await db
      .select({ id: emailAddresses.id })
      .from(emailAddresses)
      .where(and(eq(emailAddresses.id, form.id), eq(emailAddresses.userId, userId)))
      .limit(1)
  )[0];
  if (row === undefined) return "missing";
  await db.delete(emailAddresses).where(eq(emailAddresses.id, row.id));
  return "deleted";
}

// ---------------------------------------------------------------------------
// The deletion arm (upstream DeleteAccount over the PAT-as-password model)
// ---------------------------------------------------------------------------

/** The `/account/delete` POST body (the template's `password`,
 *  account.tmpl:122). */
export interface UserSettingsAccountDeleteForm {
  password: string;
}

export function parseUserSettingsAccountDeleteForm(params: URLSearchParams): UserSettingsAccountDeleteForm {
  return { password: params.get("password") ?? "" };
}

/** The deletion POST's outcomes (the mount record's render map). */
export type AccountDeleteOutcome = { outcome: "deleted" } | { outcome: "invalid"; message: string };

/**
 * The self-deletion — upstream DeleteAccount (account.go:230-274) with the
 * guard order and messages verbatim; the two credential-model reductions
 * are the module header's. Upstream's owns-packages guard is not
 * reproducible (no packages store — the count is never > 0).
 */
export async function applyUserSettingsAccountDeleteForm(
  d1: D1Database,
  user: UserSettingsAccountUser,
  form: UserSettingsAccountDeleteForm,
): Promise<AccountDeleteOutcome> {
  const db = drizzle(d1);

  // 1. The re-auth (auth.UserSignIn's port — the login POST's PAT
  //    verification, ui/session.ts loginSubmit step 2): the credential must
  //    verify AND belong to the doer. Failures answer the switch's
  //    invalid-password arm (account.go:248); nothing about the miss
  //    distinguishes unknown from foreign credentials.
  const verified = form.password === "" ? null : await new TokenService(d1).verify(form.password);
  if (verified === null || verified.user.id !== user.id) {
    return { outcome: "invalid", message: userSettingsAccountLocale.enterred_invalid_password };
  }
  // 2. The admin self-guard (account.go:256-259) — checked AFTER the
  //    credential, upstream's exact order.
  if (user.isAdmin) {
    return { outcome: "invalid", message: userSettingsAccountLocale.admin_cannot_delete_self };
  }
  // 3. The last-admin guard (DeleteUser's IsLastAdminUser arm,
  //    account.go:270 → services/user/user.go:143-145 — false for
  //    non-admins) — unreachable behind the self-guard, kept for upstream's
  //    depth.
  if (user.isAdmin && !(await db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, true), sql`${users.id} != ${user.id}`)).limit(1)).length) {
    return { outcome: "invalid", message: userSettingsAccountLocale.last_admin };
  }
  // 4+5. The owns-repos / has-orgs guards (DeleteUser's in-tx checks,
  //    services/user/user.go:238-251 → the account.go JSONError arms).
  const repoCount = await db.select({ total: sql<number>`count(*)` }).from(repositories).where(eq(repositories.ownerId, user.id)).get();
  if ((repoCount?.total ?? 0) > 0) {
    return { outcome: "invalid", message: userSettingsAccountLocale.still_own_repo };
  }
  const memberCount = await db.select({ total: sql<number>`count(*)` }).from(orgMembers).where(eq(orgMembers.userId, user.id)).get();
  if ((memberCount?.total ?? 0) > 0) {
    return { outcome: "invalid", message: userSettingsAccountLocale.still_has_org };
  }
  // 6. The cascade — the admin DELETE /users/{username} ladder's exact
  //    sweep (routes/admin-t2.ts:995-1005): the branch-protection whitelist
  //    scrub, then the FK-less stores by id with the users row (the FK
  //    cascades carry the rest — tokens, sessions, email rows, memberships,
  //    redirects, follows, stars, settings).
  await scrubUserFromAllRules(d1, user.id);
  await db.batch([
    db.delete(repoWatchers).where(eq(repoWatchers.userId, user.id)),
    db.delete(repoCollaborators).where(eq(repoCollaborators.userId, user.id)),
    db.delete(reactions).where(eq(reactions.userId, user.id)),
    db.delete(issueSubscriptions).where(eq(issueSubscriptions.userId, user.id)),
    db.delete(users).where(eq(users.id, user.id)),
  ]);
  return { outcome: "deleted" };
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/account.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's message (null on the plain GET); `email` carries the failed
 *  add submission back into the input (the carried-form family — the email
 *  is not secret-like). The password inputs never carry a value. */
export function renderUserSettingsAccountPage(ctx: UiContext, data: UserSettingsAccountPageData, error: string | null = null, email = ""): string {
  return renderPage(<UserSettingsAccountPage ctx={ctx} data={data} error={error} email={email} />);
}

/** The account page (§2.4.1 discriminator: `user settings account` —
 *  layout_head's pageClass, account.tmpl:1; upstream's Title on the GET is
 *  settings.account, account.go:38 — the POST re-renders upstream
 *  settings_title, a cosmetic divergence the fixed title folds away). The
 *  navbar is the SHARED UserSettingsNavbar (the wave-114 consolidation —
 *  the module-local scaffolding copy deleted in the mount window). */
export function UserSettingsAccountPage(props: { ctx: UiContext; data: UserSettingsAccountPageData; error: string | null; email: string }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userSettingsAccountLocale.account} pageClass="user settings account">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="account" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* account.tmpl:3-35 — the password section's disabled arm (the
                module header: no password model, the security module's
                "no password form renders anywhere" rule). */}
            <h4 class="ui top attached header">{userSettingsAccountLocale.password}</h4>
            <div class="ui attached segment">
              <div class="ui info message">
                <p class="text left">{userSettingsAccountLocale.password_change_disabled}</p>
              </div>
            </div>

            {/* account.tmpl:37-105 — the emails section. The disabled add
                input / the activations-pending warning (CanAddEmails false)
                never render: no pending state exists under the no-mail
                convention (the module header). */}
            <h4 class="ui top attached header">{userSettingsAccountLocale.manage_emails}</h4>
            <div class="ui attached segment">
              <div class="ui list flex-items-block">
                {data.emails.map((row) => (
                  <div class="item tw-flex-wrap" key={row.id ?? row.email}>
                    <div class="content tw-flex-1">
                      <strong>{row.email}</strong>
                      {row.isPrimary ? <div class="ui primary label">{userSettingsAccountLocale.primary}</div> : null}
                      {row.isActivated ? (
                        <div class="ui green label">{userSettingsAccountLocale.activated}</div>
                      ) : (
                        <div class="ui label">{userSettingsAccountLocale.requires_activation}</div>
                      )}
                    </div>
                    <div class="flex-text-block">
                      {/* account.tmpl:58-61's link-action+modal Remove — the
                          plain-form reduction (the secrets row's remove). */}
                      {!row.isPrimary && row.id !== null ? (
                        <form class="tw-inline-block" action="/user/settings/account/email/delete" method="post">
                          <input type="hidden" name="id" value={String(row.id)} />
                          <button type="submit" class="ui red tiny button">
                            {userSettingsAccountLocale.delete_email}
                          </button>
                        </form>
                      ) : null}
                      {/* account.tmpl:62-68 — already a plain form upstream. */}
                      {!row.isPrimary && row.canBePrimary && row.id !== null ? (
                        <form class="tw-inline-block" action="/user/settings/account/email" method="post">
                          <input type="hidden" name="_method" value="PRIMARY" />
                          <input type="hidden" name="id" value={String(row.id)} />
                          <button type="submit" class="ui primary tiny button">
                            {userSettingsAccountLocale.primary_email}
                          </button>
                        </form>
                      ) : null}
                      {/* account.tmpl:70-80's Send Activation form never
                          renders — no unactivated row can exist (the module
                          header). */}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div class="ui bottom attached segment">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <form class="ui form" action="/user/settings/account/email" method="post">
                <div class="required field">
                  <label for="email">{userSettingsAccountLocale.add_new_email}</label>
                  <input id="email" name="email" type="email" required value={props.email} />
                </div>
                <button type="submit" class="ui primary button">
                  {userSettingsAccountLocale.add_email}
                </button>
              </form>
            </div>

            {/* account.tmpl:107-141 — the deletion section. The
                UserDeleteWithComments line never renders (the setting's
                default is 0, loadAccountData); the confirm dialog +
                data-modal-confirm button are the plain-form reduction (the
                hooks-list reduction); the prompt's octicon-alert is outside
                the generated icon allowlist — octicon-info is the documented
                stand-in (the secrets KEY_ICON convention). */}
            <h4 class="ui top attached error header">{userSettingsAccountLocale.delete_account}</h4>
            <div class="ui attached error segment">
              <div class="ui red message">
                <p class="text left">
                  <Icon name="octicon-info" /> {userSettingsAccountLocale.delete_prompt_prefix}
                  <strong>{userSettingsAccountLocale.delete_prompt_strong}</strong>
                  {userSettingsAccountLocale.delete_prompt_suffix}
                </p>
              </div>
              <form class="ui form" action="/user/settings/account/delete" method="post">
                <div class="required field">
                  {/* The re-auth credential — never carries a value (the
                      secrets value rule). */}
                  <label for="password-confirmation">{userSettingsAccountLocale.password_label}</label>
                  <input id="password-confirmation" name="password" type="password" autocomplete="off" required />
                </div>
                <div class="field">
                  <button type="submit" class="ui red button">
                    {userSettingsAccountLocale.confirm_delete_account}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
