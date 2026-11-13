/**
 * The ADMIN USER CREATE page — `/-/admin/users/new` — the GET+POST combo of
 * upstream web.go:815's
 * `m.Combo("/new").Get(admin.NewUser).Post(web.Bind[*forms.AdminCreateUserForm](), admin.NewUserPost)`
 * (routers/web/admin/users.go:129-263 — the GET's sources pull at :137-145,
 * the POST at :151-265, rendered by templates/admin/user/new.tmpl). B-88
 * (the census module-3 pass): the page
 * U22 cited but never graded — the route was UNLANDED and the list header's
 * "Create User Account" button omitted (admin-users.tsx's note), while
 * everything the page needs was landed beside it: the API create's ladder +
 * insert (PW12's admin-t2 arm), the web edit-page family, the `user:create`
 * audit id (B-73), and the register-notify mailer. A mere deferral under
 * ADR-0008's extensions — implemented here at upstream's shape.
 *
 * ## The web arm carries its OWN ladder (the reuse-vs-own derive)
 *
 * Upstream's web arm shares NOTHING route-level with the API twin
 * (routers/api/v1/admin/user.go:82-156): the web POST binds
 * forms.AdminCreateUserForm (services/forms/admin.go:14-24 — LoginType
 * Required, UserName Required;Username;MaxSize(40), UserType In(,User,Bot),
 * Email Required;Email;MaxSize(254), Password MaxSize(255), Visibility),
 * builds the user_model.User directly, calls user_model.AdminCreateUser,
 * and answers in RE-RENDERS and a redirect (RenderWithErrDeprecated /
 * Flash) rather than JSON — the ladder (:199-219), the error mapping
 * (:226-249), the audit (:256), the notify (:262) and the redirect (:265)
 * are the web ladder's own. The port keeps that shape: this module carries
 * its own web ladder over the LANDED seams the API arm already uses
 * (validateNewPassword / usableUsernameError / invalidEmailMessage / the
 * insertCreatedUser column set / auditEventInsert + AuditActions.UserCreate
 * / enqueueRegisterNotifyMail), mirrored module-local because admin-t2.ts's
 * create arm is route-private there (the edit page's renameUserRow posture).
 *
 * ## The field set (new.tmpl at the pin) and the port's reductions
 *
 * pageClass `admin new user` (layout_head's dict), the AdminFamilyShell
 * (active "users"), then the ONE `<form action="/-/admin/users/new"
 * method="post">` whose field set reads exactly upstream's:
 *
 *   - `user_name` — required, maxlength 40, autofocus (new.tmpl:8-13).
 *   - `user_type` — the User/Bot selector (new.tmpl:15-27), default User.
 *     LANDED (B-72, 2026-11-13): the Bot option is LIVE — upstream's create
 *     arm mints bot rows (:190-193: `u.Type = UserTypeBot; u.Passwd = ""`),
 *     our users.type enum now carries 'bot' (the schema's block comment;
 *     drizzle-kit generates NO migration — the TEXT column has no CHECK
 *     constraint, the enum is type-level). The bot branch semantics (the
 *     POST ladder section below): type 'bot', the whole password ladder
 *     SKIPPED (:199's `!u.IsTypeBot()` gate), must_change_password stored
 *     FALSE (:220-221's assignment sits inside that gate — bots get the Go
 *     zero value), passwd='' + salt='' + passwd_hash_algo='' with the Rands
 *     salt still written (createUser :785-794's empty-passwd branch), the
 *     name/collision/email/audit/notify/redirect arms UNCHANGED (bots ride
 *     them like any create). Bots never password-authenticate: the row
 *     carries no hash AND the login lookups are Individual-only upstream
 *     (user.go:1137/:1405) — mirrored by password-auth.ts's `type='user'`
 *     filters, so a bot name answers the generic not-exist credential
 *     failure ("Bot accounts cannot sign in",
 *     admin.users.bot_token_desc).
 *   - `login_type` — the auth-source dropdown (new.tmpl:29-47): Local
 *     (0-0) + the landed login_sources (findLoginSources — the edit page's
 *     dropdown tail). The posted value rides the ACCEPTED-AND-IGNORED set
 *     (deviation 1: our users rows carry no login_source column; the edit
 *     page's recorded posture) — so is `login_name` (new.tmpl:72-76,
 *     rendered hidden at the 0-0 default exactly like upstream's
 *     `{{if eq .login_type "0-0"}}tw-hidden{{end}}` arm).
 *   - `visibility` — the required dropdown (new.tmpl:49-70), upstream's
 *     0/1/2 wire values; the pristine default is public (the landed
 *     users.visibility column default — upstream's
 *     DefaultUserVisibilityMode), junk re-renders flagged on the field
 *     (upstream's Err_Visibility bind arm, silent).
 *   - `email` — required (new.tmpl:77-80); a format miss re-renders
 *     flagged, silent (the Required;Email bind arm — the edit page's
 *     posture).
 *   - `password` — required for local (new.tmpl:82-89). NO empty-keep arm
 *     on create (unlike the edit page's FromNonDefault): the ladder is
 *     REAL and UNCONDITIONED (deviation 1 makes every created user local —
 *     upstream skips the ladder for non-local login types, :202, and no
 *     non-local row can be created here). The re-render ECHOES the typed
 *     value (new.tmpl:88's `value="{{.password}}"` — upstream's own create
 *     shape; the EDIT page's no-echo is edit.tmpl's, which has no value
 *     attr).
 *   - `must_change_password` — the checkbox (new.tmpl:91-97) renders
 *     CHECKED (new.tmpl:83's checked literal — the create default) and the
 *     submit stores the as-posted value (upstream :221's
 *     `u.MustChangePassword = form.MustChangePassword` — the web form has
 *     no nil→true default; that default is the API arm's, PW12).
 *   - `send_notify` — the checkbox (new.tmpl:99-105). Upstream renders it
 *     only when CanSendEmail (setting.MailService != nil, users.go:137);
 *     the register-notify seam is LANDED with its own master gate
 *     (MAIL_ENABLED, register-notify.ts's fail-closed polarity), so the
 *     checkbox renders and the seam answers "disabled" when mail is off —
 *     upstream's render gate is subsumed by the seam's runtime gate.
 *   - base/disable_form_autofill's dummy inputs are omitted — every landed
 *     form omits the autofill bait.
 *   - the email-domain-allowlist warning flash (users.go:252-254) has no
 *     allowlist config landed — dead arm, not ported (the edit page's
 *     posture); the pwned ladder arm (:211-219) is dormant —
 *     PASSWORD_CHECK_PWNED is default-OFF and no HIBP client ships
 *     (password-policy.ts header, the API twin's recorded posture).
 *   - the flash banners: the no-flash reduction — the landing 303s
 *     (upstream's redirect half, :265) and the failure arms re-render WITH
 *     the banner text (RenderWithErrDeprecated's message half); upstream's
 *     success banner (admin.users.new_success) is dropped (the edit page's
 *     posture).
 *
 * ## The POST ladder (NewUserPost's observable order)
 *
 * the BIND phase (silent flagged re-renders, NOTHING else runs —
 * users.go:169-172's HasError arm) → the Bot branch (upstream :190-193 —
 * type 'bot', Passwd='') → the password ladder (:199-211 — min length then
 * complexity, gated `!u.IsTypeBot()` so BOTS SKIP IT entirely; the texts
 * are validateNewPassword's, the landed web-EDIT twin's ladder texts) →
 * the must_change_password store (as-posted for users; the assignment
 * :220-221 sits inside the non-bot gate, so bots store FALSE) → the name
 * rules
 * (AdminCreateUser's arms, users.go:226-249's mapping: reserved / pattern
 * / chars carry the WEB texts) → the collision + email-duplicate arms
 * (users.go:227-232) → the redirect consumption (user.go:798's
 * DeleteUserRedirect — creating on a live redirect consumes it; the API
 * arm's posture) → the INSERT batch (the API arm's insertCreatedUser
 * column set + the B-73 audit row in the SAME batch — "a failed write
 * emits nothing"; origin "ui", actor the ADMIN, scope the created user) →
 * the notify (send_notify → enqueueRegisterNotifyMail, caught-and-logged —
 * never load-bearing, the API twin's posture) → the caller's 303 onto
 * /-/admin/users/{id}.
 *
 * ## Mount recipe (the orchestrator's index.ts fold)
 *
 * 1. `UiRoute` gains the `"admin-user-new"` family (no payload — the
 *    static literal claim).
 * 2. `parseUiRoute`, in the `raw[1] === "-" && raw[2] === "admin"` tail
 *    parse, directly beside the bare `users` literal (static-before-
 *    dynamic; "new" cannot shadow the digits-only {userid} claim and vice
 *    versa):
 *
 *      if (tail.length === 2 && tail[0] === "users" && tail[1] === "new") {
 *        return { family: "admin-user-new" };
 *      }
 *
 * 3. Handlers (the adminUserEditPage shapes — the prologue IS the admin
 *    gate: anonymous 303s onto the login round-trip, a non-admin
 *    404-shells; the POST adds the §2.8 sameOriginGuard first):
 *
 *      async function adminUserNewPage(c) {
 *        const p = await adminPagePrologue(c);
 *        if (!p.ok) return p.response;
 *        const data = await loadAdminUserNew(c.env.DB);
 *        return p.respond(c.html(renderAdminUserNewPage(p.ctx, { sources: data.sources, form: adminUserNewDefaults(), error: null, errorField: null, oauth2Enabled: oauth2FeatureEnabled(c.env) }), 200));
 *      }
 *
 *      async function adminUserNewSubmit(c) {
 *        const guard = sameOriginGuard(c.req.raw);
 *        if (guard !== null) return guard;
 *        const p = await adminPagePrologue(c);
 *        if (!p.ok) return p.response;
 *        const form = parseAdminUserCreateForm(await readUrlEncodedForm(c.req.raw));
 *        const doerId = p.ctx.viewer.kind === "user" ? p.ctx.viewer.id : 0;
 *        const outcome = await submitAdminUserCreate(c.env.DB, doerId, form, c.env);
 *        if (outcome.outcome === "invalid") {
 *          const data = await loadAdminUserNew(c.env.DB);
 *          return p.respond(c.html(renderAdminUserNewPage(p.ctx, { sources: data.sources, form, error: outcome.message, errorField: outcome.field, oauth2Enabled: oauth2FeatureEnabled(c.env) }), 200));
 *        }
 *        return p.respond(new Response(null, { status: 303, headers: { location: adminUserLink(outcome.userId) } }));
 *      }
 *
 * 4. Registration beside the bare users literal (before the dynamic
 *    {userid} arms; both verbs are REAL upstream — no chi-405 twins):
 *
 *      uiRouter.get("/-/admin/users/new", (c) => adminUserNewPage(c));
 *      uiRouter.post("/-/admin/users/new", (c) => adminUserNewSubmit(c));
 *
 * 5. Null pin that flips with this landing (the list OWNER's fold — the
 *    file is outside this module's ownership): pages/admin-users.tsx's
 *    header note — the "Create User Account" button (list.tmpl:6 →
 *    `/-/admin/users/new`) can render now that the page is landed.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userRedirects, users } from "../../db/schema";
import { invalidEmailMessage, validateNewPassword } from "../../services/user-accounts";
import {
  OrgError,
  OrgNameCharsInvalidError,
  OrgNameCollisionError,
  OrgNamePatternNotAllowedError,
  OrgNameReservedError,
} from "../../services/orgs/errors";
import { usableUsernameError } from "../../services/orgs/orgs";
import { findLoginSources, type LoginSourceRow } from "../../services/auth-sources/store";
import { newPasswordRecord, newSalt } from "../../auth/password";
import { AuditActions, auditEventInsert } from "../../services/audit";
import {
  enqueueRegisterNotifyMail,
  type MailUser,
  type RegisterNotifyEnv,
} from "../../services/mail/register-notify";
import { AdminFamilyShell, adminUsersLocale } from "./admin-users";
import { adminUserEditLocale } from "./admin-user-edit";
import type { UiContext } from "../ui-context";
import { renderPage } from "../shell";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminUserNewLocale = {
  new_account: "Create User Account", // "admin.users.new_account" (the Title + the h4 + the submit label, users.go:133/:162, new.tmpl:6/:86)
  allow_password_change: "Require user to change password (recommended)", // "auth.allow_password_change" (new.tmpl:81's label)
  send_register_notify: "Send User Registration Notification", // "admin.users.send_register_notify" (new.tmpl:92's label)
} as const;

// ---------------------------------------------------------------------------
// The form parse (web.Bind[*forms.AdminCreateUserForm] — forms/admin.go:
// 14-24; an unchecked checkbox is ABSENT, not false-valued — the
// org-settings parse convention)
// ---------------------------------------------------------------------------

export interface AdminUserCreateForm {
  userName: string;
  /** The raw `user_type` wire value ("" | "User" | "Bot" pass upstream's
   *  In(,User,Bot) bind; junk is absorbed to "" in the submit). */
  userType: string;
  /** The raw `login_type` wire value ("0-0" local; the Required bind) —
   *  the accepted-and-ignored set (deviation 1). */
  loginType: string;
  loginName: string;
  email: string;
  password: string;
  /** The raw `visibility` wire value ("0" | "1" | "2" upstream). */
  visibility: string;
  mustChangePassword: boolean;
  sendNotify: boolean;
}

export function parseAdminUserCreateForm(params: URLSearchParams): AdminUserCreateForm {
  return {
    userName: params.get("user_name") ?? "",
    userType: params.get("user_type") ?? "",
    loginType: params.get("login_type") ?? "",
    loginName: params.get("login_name") ?? "",
    email: params.get("email") ?? "",
    password: params.get("password") ?? "",
    visibility: params.get("visibility") ?? "",
    mustChangePassword: params.get("must_change_password") !== null,
    sendNotify: params.get("send_notify") !== null,
  };
}

/** The pristine GET's form (new.tmpl's defaults: user_type User, login_type
 *  0-0, visibility 0 — DefaultUserVisibilityMode, must_change_password
 *  CHECKED at :83, send_notify unchecked). A function — no shared mutable
 *  literal. */
export function adminUserNewDefaults(): AdminUserCreateForm {
  return {
    userName: "",
    userType: "User",
    loginType: "0-0",
    loginName: "",
    email: "",
    password: "",
    visibility: "0",
    mustChangePassword: true,
    sendNotify: false,
  };
}

// ---------------------------------------------------------------------------
// The loader (NewUser's data pull — users.go:137-145's FindSources; the
// CanSendEmail / DefaultUserVisibilityMode / AllowedUserVisibilityModes
// data arms fold into the seam gates and the column default, the header)
// ---------------------------------------------------------------------------

export interface AdminUserNewData {
  /** The auth-source dropdown's tail (FindSources — every row, name ASC). */
  sources: LoginSourceRow[];
}

export async function loadAdminUserNew(d1: D1Database): Promise<AdminUserNewData> {
  return { sources: await findLoginSources(d1) };
}

// ---------------------------------------------------------------------------
// The submit (NewUserPost, users.go:151-265, over the landed seams)
// ---------------------------------------------------------------------------

/** The fields the re-render can flag (upstream's Err_UserName /
 *  Err_LoginType / Err_Visibility / Err_Email / Err_Password class hooks —
 *  ALL reachable on create: the template carries a flag hook for each;
 *  Err_LoginName has no hook upstream and no arm here). */
export type AdminUserCreateErrorField = "userName" | "loginType" | "visibility" | "email" | "password";

/** The arm's outcome union (the wiring's map, the module header's recipe):
 *  `invalid` re-renders at 200 with the POSTED values + the banner
 *  (`message`, null = the silent bind arms) + the flagged field;
 *  `created` is the caller's 303 onto the new user's detail page (upstream
 *  :265's redirect; the flash dropped). */
export type AdminUserCreateOutcome =
  | { outcome: "created"; userId: number }
  | { outcome: "invalid"; message: string | null; field: AdminUserCreateErrorField | null };

/** The WEB name-rule texts (users.go:236-249's mapping) from the typed org
 *  errors — the locale strings upstream's RenderWithErr arms carry (the
 *  edit page's renameErrorMessage twin; the collision arm here is the
 *  explicit pre-check + the insert race below, not a rename). */
function createNameErrorMessage(error: OrgError, name: string): string {
  if (error instanceof OrgNameCollisionError) return adminUserEditLocale.username_been_taken;
  if (error instanceof OrgNameCharsInvalidError) return adminUserEditLocale.name_chars_not_allowed.replace("%s", name);
  if (error instanceof OrgNameReservedError) return adminUserEditLocale.name_reserved.replace("%s", name);
  if (error instanceof OrgNamePatternNotAllowedError) return adminUserEditLocale.name_pattern_not_allowed.replace("%s", name);
  return error.message; // the remaining rule texts (the 40-char cap class)
}

/** admin-t2.ts's `emailUsedByOther` (route-private — mirrored module-local,
 *  no self-exclusion: a create is never self). Upstream IsEmailUsed over
 *  any user row. */
async function emailUsedByOther(d1: D1Database, email: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .all();
  return rows.length > 0;
}

/** new.tmpl's visibility wire values (0/1/2) → the landed enum (the bind
 *  phase already guarantees the domain). */
function visibilityFromString(raw: string): "public" | "limited" | "private" {
  return raw === "1" ? "limited" : raw === "2" ? "private" : "public";
}

/** The UNIQUE(users.username_lower) race arbiter (the API arm's
 *  convention — the pre-check above raced a concurrent create): the
 *  batch's error chain carries the constraint text. */
function isUniqueCollision(error: unknown): boolean {
  let text = error instanceof Error ? error.message : String(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text.includes("UNIQUE constraint failed");
}

/**
 * POST /-/admin/users/new (admin.NewUserPost, users.go:151-265) over the
 * landed seams — the module header carries the ladder and every reduction.
 * The caller supplies the prologue-gated doer (the audit's actor; the
 * DisplayName read resolves inside — upstream ctx.Doer is the full row).
 * `mailer` is the wiring's env (RegisterNotifyEnv's structural slice);
 * omitting it skips the notify arm (the seam's gate still answers
 * "disabled" for an unconfigured mailer at runtime — never load-bearing).
 */
export async function submitAdminUserCreate(
  d1: D1Database,
  doerId: number,
  form: AdminUserCreateForm,
  mailer?: RegisterNotifyEnv,
): Promise<AdminUserCreateOutcome> {
  const db = drizzle(d1);

  // --- the bind phase (web.Bind's AdminCreateUserForm validation; a miss
  // re-renders at 200 with the flagged field and NO banner — the silent
  // HasError arm, users.go:169-172 — and NOTHING else runs).
  if (form.loginType === "") return { outcome: "invalid", message: null, field: "loginType" };
  if (form.userName === "" || form.userName.length > 40) {
    // The Required;MaxSize(40) bind — Err_UserName flagged, silent.
    return { outcome: "invalid", message: null, field: "userName" };
  }
  if (form.userType !== "" && form.userType !== "User" && form.userType !== "Bot") {
    // In(,User,Bot): junk fails the bind with no Err_ hook on the template
    // — the flag-less silent re-render.
    return { outcome: "invalid", message: null, field: null };
  }
  if (form.email === "" || invalidEmailMessage(form.email) !== null) {
    // The Required;Email bind — Err_Email flagged, silent.
    return { outcome: "invalid", message: null, field: "email" };
  }
  if (!/^(0|1|2)$/.test(form.visibility)) {
    // The VisibleType bind — Err_Visibility flagged, silent.
    return { outcome: "invalid", message: null, field: "visibility" };
  }

  // --- the Bot branch (B-72, upstream users.go:190-193): type "Bot" mints
  // a bot row — the password ladder below is SKIPPED (:199's
  // `!u.IsTypeBot()` gate wraps the whole ladder INCLUDING the
  // must_change_password assignment, so bots store the Go zero value
  // false), and the row carries passwd='' + salt='' + passwd_hash_algo=''
  // (createUser's empty-passwd branch, user.go:788-794) with the Rands
  // salt still written (:785-786, unconditional). Every other arm — name
  // rules, collision, email duplicate, redirect consumption, audit,
  // notify, redirect — rides for bots exactly like any create.
  const isBot = form.userType === "Bot";

  // --- the password ladder (users.go:199-211 — min length then
  // complexity; gated `!u.IsTypeBot()` so bots answer no ladder; for
  // users it is UNCONDITIONED because deviation 1 makes every created
  // user local — upstream's :202 login-type gate has no non-local target
  // here). The texts are validateNewPassword's — the landed web-EDIT
  // twin's ladder (the pwned arm :211-219 is dormant, the API twin's
  // posture).
  if (!isBot) {
    const policy = validateNewPassword(form.password);
    if (policy !== null) {
      return { outcome: "invalid", message: policy, field: "password" };
    }
  }

  // --- the name rules (AdminCreateUser's arms, users.go:226-249's
  // mapping — upstream's bind-level Username checker subsumes into this
  // banner arm: same flag, the message the mapping carries).
  const nameError = usableUsernameError(form.userName);
  if (nameError !== null) {
    return { outcome: "invalid", message: createNameErrorMessage(nameError, form.userName), field: "userName" };
  }

  // --- the collision + email-duplicate arms (AdminCreateUser's
  // IsErrUserAlreadyExist / IsErrEmailAlreadyUsed, users.go:227-232).
  const lower = form.userName.toLowerCase();
  const nameTaken = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, lower)).get();
  if (nameTaken !== undefined) {
    return { outcome: "invalid", message: adminUserEditLocale.username_been_taken, field: "userName" };
  }
  if (await emailUsedByOther(d1, form.email)) {
    return { outcome: "invalid", message: adminUserEditLocale.email_been_used, field: "email" };
  }

  // --- the redirect consumption (user.go:798's DeleteUserRedirect —
  // creating on a live redirect consumes it; the API arm's posture).
  await db.delete(userRedirects).where(eq(userRedirects.lowerName, lower));

  // --- the INSERT batch: the API arm's insertCreatedUser column set
  // (route-private there — mirrored module-local; the WEB form has no
  // full_name field, so both display columns stay null where the API's
  // optional full_name would land) plus the B-73 audit row in the SAME
  // batch ("a failed write emits nothing", §4.2 — upstream's audit.Record
  // at users.go:256, actor the ADMIN, scope the created user). The new
  // user's numeric id is allocated by the insert of the same batch, so
  // scope_id resolves through the scalar subquery (cast to text — the
  // scope_id drift note) exactly like the API arm's.
  const now = new Date();
  // The hashed record only for a user create; a bot row carries the
  // empty-passwd triple (user.go:788-794 — no hash call, salt+algo '').
  const record = isBot ? null : await newPasswordRecord(form.password);
  const doer = await db
    .select({ username: users.username, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, doerId))
    .get();
  // Upstream's DisplayName mapping (user.go:476-482): FullName when set,
  // else Name — the API arm's actorName convention.
  const actorName =
    doer !== undefined && (doer.fullName ?? "").trim() !== "" ? (doer.fullName as string) : (doer?.username ?? "");
  let createdId: number;
  try {
    const [inserts] = await db.batch([
      db
        .insert(users)
        .values({
          username: form.userName,
          usernameLower: lower,
          email: form.email,
          displayName: null,
          isAdmin: false,
          status: "active",
          visibility: visibilityFromString(form.visibility),
          fullName: null,
          type: isBot ? "bot" : "user",
          createdAt: now,
          passwd: record?.passwd ?? "",
          salt: record?.salt ?? "",
          passwdHashAlgo: record?.passwdHashAlgo ?? "",
          rands: newSalt(),
          mustChangePassword: isBot ? false : form.mustChangePassword,
        })
        .returning({ id: users.id }),
      auditEventInsert(db, {
        action: AuditActions.UserCreate,
        actorId: doerId,
        actorName,
        scopeType: "user",
        scopeId: sql`(select cast(id as text) from users where username_lower = ${lower})`,
        scopeName: form.userName,
        origin: "ui",
        vars: { scope: form.userName },
        timestamp: now,
      }),
    ]);
    createdId = inserts[0]!.id;
  } catch (error) {
    // The UNIQUE(users.username_lower) race arbiter (the API arm's
    // convention — the pre-check above raced a concurrent create): the
    // loser answers the collision text.
    if (isUniqueCollision(error)) {
      return { outcome: "invalid", message: adminUserEditLocale.username_been_taken, field: "userName" };
    }
    throw error;
  }

  // --- the register-notify arm (users.go:262's SendRegisterNotifyMail —
  // the API twin's posture: fire-and-forget in EFFECT, EVERY failure class
  // caught-and-logged, never load-bearing for the landing; NO type gate —
  // a posted send_notify fires for a bot create too, upstream's shape).
  if (form.sendNotify && mailer !== undefined && createdId > 0) {
    const mailUser: MailUser = {
      id: createdId,
      username: form.userName,
      email: form.email,
      displayName: null,
      fullName: null,
      status: "active",
      type: isBot ? "bot" : "user",
    };
    try {
      await enqueueRegisterNotifyMail(mailer, mailUser);
    } catch (error) {
      console.error(`admin-user-new: register-notify enqueue failed: ${String(error)}`);
    }
  }

  return { outcome: "created", userId: createdId };
}

// ---------------------------------------------------------------------------
// The render (new.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The re-render's model (RenderWithErrDeprecated's posture — the POSTED
 *  form values repopulate the fields, upstream's `&form` data arm): the
 *  sources + the form + the banner text (null = pristine GET) + the
 *  flagged field. */
export interface AdminUserNewRenderData {
  sources: LoginSourceRow[];
  form: AdminUserCreateForm;
  error: string | null;
  errorField: AdminUserCreateErrorField | null;
  /** The shell's Integrations gate (the AdminUsersData convention — the
   *  route threads `oauth2FeatureEnabled(c.env)`). Absent/true = enabled. */
  oauth2Enabled?: boolean;
}

/** One field div's class (new.tmpl's `{{if .Err_X}}error{{end}}` hooks). */
function fieldClass(field: AdminUserCreateErrorField | null, mine: AdminUserCreateErrorField, base: string): string {
  return field === mine ? `${base} error` : base;
}

/** The full-document render (the render.tsx pattern). */
export function renderAdminUserNewPage(ctx: UiContext, data: AdminUserNewRenderData): string {
  return renderPage(<AdminUserNewPage ctx={ctx} data={data} />);
}

/** The admin user create page (§2.4.1 discriminator: layout_head's
 *  `admin new user`, new.tmpl:1). */
export function AdminUserNewPage(props: { ctx: UiContext; data: AdminUserNewRenderData }) {
  const { ctx, data } = props;
  const form = data.form;
  const err = data.errorField;
  return (
    <AdminFamilyShell ctx={ctx} title={adminUserNewLocale.new_account} pageClass="admin new user" active="users" oauth2Enabled={data.oauth2Enabled}>
      {data.error !== null ? (
        <div class="ui negative message">
          <p>{data.error}</p>
        </div>
      ) : null}

      <h4 class="ui top attached header">{adminUserNewLocale.new_account}</h4>
      <div class="ui attached segment">
        <form class="ui form" action="/-/admin/users/new" method="post">
          {/* user_name (new.tmpl:8-13) — required, autofocus, maxlength 40. */}
          <div class={fieldClass(err, "userName", "required field")}>
            <label for="user_name">{adminUserEditLocale.username}</label>
            <input id="user_name" type="text" name="user_name" value={form.userName} autofocus maxlength={40} required />
          </div>
          {/* user_type (new.tmpl:15-27) — the User/Bot selector, default
              User; the Bot option LIVE (B-72 — the module header's branch
              semantics; new.tmpl carries no disabled arm and no notice). */}
          <div class="required field">
            <label for="user_type">{adminUsersLocale.user_type}</label>
            <select id="user_type" name="user_type" class="ui selection dropdown">
              <option value="User" selected={form.userType === "User"}>
                {adminUsersLocale.user_type_user}
              </option>
              <option value="Bot" selected={form.userType === "Bot"}>
                {adminUsersLocale.user_type_bot}
              </option>
            </select>
          </div>
          {/* login_type (new.tmpl:29-47) — Local + the landed sources; the
              posted value is the accepted-and-ignored set (deviation 1). */}
          <div class={fieldClass(err, "loginType", "required js-non-bot field")}>
            <label for="login_type">{adminUserEditLocale.auth_source}</label>
            <select id="login_type" name="login_type" class="ui selection dropdown">
              <option value="0-0" selected={form.loginType === "0-0"}>
                {adminUsersLocale.local}
              </option>
              {data.sources.map((source) => (
                <option value={`${source.type}-${source.id}`}>{source.name}</option>
              ))}
            </select>
          </div>
          {/* visibility (new.tmpl:49-70) — the required dropdown, upstream's
              0/1/2 wire values; the pristine default is public. */}
          <div class={fieldClass(err, "visibility", "required field")}>
            <label for="visibility">{adminUserEditLocale.visibility}</label>
            <select id="visibility" name="visibility" class="ui selection dropdown">
              <option value="0" selected={form.visibility === "0"}>
                {adminUserEditLocale.visibility_public}
              </option>
              <option value="1" selected={form.visibility === "1"}>
                {adminUserEditLocale.visibility_limited}
              </option>
              <option value="2" selected={form.visibility === "2"}>
                {adminUserEditLocale.visibility_private}
              </option>
            </select>
          </div>
          {/* login_name (new.tmpl:72-76) — hidden exactly like upstream's
              `{{if eq .login_type "0-0"}}tw-hidden{{end}}` default render. */}
          <div class="required js-non-local js-non-bot field tw-hidden">
            <label for="login_name">{adminUserEditLocale.auth_login_name}</label>
            <input id="login_name" name="login_name" value={form.loginName} />
          </div>
          {/* email (new.tmpl:77-80) — required. */}
          <div class={fieldClass(err, "email", "required field")}>
            <label for="email">{adminUserEditLocale.email}</label>
            <input id="email" name="email" type="email" value={form.email} required />
          </div>
          {/* password (new.tmpl:82-89) — required for local; the ladder is
              REAL on create (no empty-keep arm — the module header). The
              re-render ECHOES the typed value (new.tmpl:88's
              value="{{.password}}" — upstream's own create shape). */}
          <div class={fieldClass(err, "password", "required js-local js-non-bot field")}>
            <label for="password">{adminUserEditLocale.password}</label>
            <input id="password" name="password" type="password" autocomplete="new-password" value={form.password} required />
          </div>

          {/* must_change_password (new.tmpl:91-97) — CHECKED default
              (:83's checked literal); the submit stores as-posted. */}
          <div class="inline field js-local js-non-bot">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserNewLocale.allow_password_change}</strong>
              </label>
              <input name="must_change_password" type="checkbox" checked={form.mustChangePassword} />
            </div>
          </div>

          {/* send_notify (new.tmpl:99-105) — upstream's CanSendEmail render
              gate is subsumed by the seam's MAIL_ENABLED runtime gate (the
              module header). */}
          <div class="inline js-non-bot field">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserNewLocale.send_register_notify}</strong>
              </label>
              <input name="send_notify" type="checkbox" checked={form.sendNotify} />
            </div>
          </div>

          <div class="field">
            <button type="submit" class="ui primary button">
              {adminUserNewLocale.new_account}
            </button>
          </div>
        </form>
      </div>
    </AdminFamilyShell>
  );
}
