/**
 * The team invite mail (census B-77) — the port of upstream
 * `services/mailer/mail_team_invite.go` + `templates/mail/org/team_invite.tmpl`
 * over the landed email funnel (SPEC-0005 §3.6's outbox — upstream SendAsync's
 * in-process queue rides the D1 `email_outbox` row + REPO_TASKS here, the
 * notify-family shape).
 *
 * ## Where the pieces live
 *
 * Upstream splits the lane across the org service and the mailer:
 * `org_service.CreateTeamInvite` (services/org/team_invite.go:15-24) is
 * INSERT-then-mail — the model insert (models/organization/team_invite.go)
 * composes with `mailer.MailTeamInvite`, and a mail failure propagates to the
 * caller (the handler's ServerError) with the invite ROW standing. Ours keeps
 * the same order and failure shape: the row insert is
 * `TeamsService.createTeamInvite` (api/routes/org-teams.ts) and THIS module is
 * the mail half — a compose/insert failure throws to the ui add arm's 500,
 * while the outbox's post-insert queue leg stays best-effort (SPEC §3.2's
 * durable-producer posture).
 *
 * ## The gates, verbatim
 *
 *   - the master gate — `setting.MailService == nil` (mail_team_invite.go:26)
 *     is a silent nil (the ui add arm checks the same gate BEFORE the invite
 *     branch — teams.go:173 — so this arm is a defensive no-op; our polarity
 *     is `MAIL_ENABLED !== "true"`, the SPEC §5.1 strict gate the notify
 *     family rides);
 *   - an unparseable `MAIL_FROM` skips with `misconfigured` (the notify
 *     prelude's log-and-skip semantics — upstream's armed-mailer FROM parse
 *     fails at send time and logs, it never blocks the invite row);
 *   - the invited email resolving to a `ProhibitLogin` account is a HARD
 *     error (mail_team_invite.go:37-39: "login is prohibited for the invited
 *     user") — it THROWS to the add arm's 500, upstream-verbatim;
 *   - every other upstream error arm (the org lookup, the template exec)
 *     propagates the same way.
 *
 * ## The invite URL
 *
 * mail_team_invite.go:45-49: an account with the invited email ALREADY exists
 * → `{AppURL}user/login?redirect_to=<query-escaped /org/invite/{token}>`,
 * otherwise the sign-up twin. Upstream also flips to login when registration
 * is disabled (`DisableRegistration`) or external-only
 * (`AllowOnlyExternalRegistration`) — neither config var is modeled on this
 * tree (no runtime app.ini), so the account-exists probe alone decides; the
 * recorded reduction. The redirect target is the TOKENIZED page, so the
 * bearer lands on the invite after auth (web.go:977's reqSignIn group is the
 * reason the mail routes through sign_up/login first).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { renderTeamInviteMail, teamInviteSubject } from "./templates";
import { enqueueMailOutbox, type MailOutboxEnv } from "./outbox";
import { parseMailFrom } from "./message";
import { appUrlWithSlash, GITEA_APP_NAME } from "./register-notify";

/** Upstream `DisplayName()` (models/user/user.go) — FullName (the display
 *  columns' precedence: `display_name` then `full_name`) when set, else the
 *  username. The register-notify displayNameOf port (module-local there). */
function displayNameOf(user: { username: string; displayName: string | null; fullName: string | null }): string {
  const full = (user.displayName ?? user.fullName ?? "").trim();
  return full === "" ? user.username : full;
}

/** The compose's env slice — outbox (DB + REPO_TASKS) + the shaping inputs. */
export type TeamInviteMailEnv = Pick<MailOutboxEnv, "DB" | "REPO_TASKS"> & {
  APP_URL?: string;
  MAIL_ENABLED?: string;
  MAIL_FROM?: string;
  MAIL_SUBJECT_PREFIX?: string;
};

/** The compose's caller-side data — everything the ui add arm already holds
 *  resolved (upstream reloads the org by team.OrgID at mail_team_invite.go:31;
 *  the caller-resolved row is the same record). */
export interface TeamInviteMailInput {
  /** The inviting org owner (upstream `inviter` — the mail composes in
   *  inviter.Language; the tree is English-only — templates.ts header rule —
   *  so the language rides nothing here). */
  inviter: { username: string; displayName: string | null; fullName: string | null };
  /** The org user row (upstream `org`, reloaded from team.OrgID). */
  org: { username: string; displayName: string | null; fullName: string | null };
  /** The team (upstream `team` — only Name reaches the template). */
  team: { name: string };
  /** The landed invite row (upstream `invite`). */
  invite: { id: number; token: string; email: string };
}

export type TeamInviteMailOutcome =
  | { outcome: "disabled" }
  | { outcome: "misconfigured"; message: string }
  | { outcome: "enqueued"; mailId: number };

/** `query.Escape` of the redirect target (mail_team_invite.go:44) — the login
 *  form carries it through the sign-in flow back to /org/invite/{token}. */
function inviteRedirectPath(token: string): string {
  return `/org/invite/${token}`;
}

export async function sendTeamInviteMail(env: TeamInviteMailEnv, input: TeamInviteMailInput): Promise<TeamInviteMailOutcome> {
  // The master gate (mail_team_invite.go:26-28) — a silent no-op (the ui add
  // arm's own MAIL_ENABLED check makes this arm unreachable from the lane).
  if (env.MAIL_ENABLED !== "true") return { outcome: "disabled" };
  const from = parseMailFrom(env.MAIL_FROM ?? "");
  if (from === null) {
    const message = `[mail] MAIL_ENABLED=true but MAIL_FROM is missing or unparseable; skipping team invite mail for ${input.invite.email}`;
    console.warn(message);
    return { outcome: "misconfigured", message };
  }

  // The account-exists probe over the invited email (mail_team_invite.go:33-39,
  // GetUserByEmail) + the ProhibitLogin hard error. Upstream's GetUserByEmail
  // walks the email_address table besides users.email; our probe reads
  // users.email alone (the tree's single address carrier) — the recorded
  // read-shape reduction.
  const existing = await drizzle(env.DB).select().from(users).where(eq(users.email, input.invite.email)).get();
  if (existing !== undefined && existing.status === "prohibited") {
    throw new Error("login is prohibited for the invited user");
  }
  const origin = appUrlWithSlash(env.APP_URL);
  const redirect = encodeURIComponent(inviteRedirectPath(input.invite.token));
  // mail_team_invite.go:42-49 — login when the account exists (or
  // registration is disabled/external-only, unmodeled here — see header),
  // sign_up otherwise.
  const inviteUrl =
    existing !== undefined
      ? `${origin}user/login?redirect_to=${redirect}`
      : `${origin}user/sign_up?redirect_to=${redirect}`;

  const inviterDisplayName = displayNameOf(input.inviter);
  const orgDisplayName = displayNameOf(input.org);
  // Upstream composes in the INVITER's language (translation.NewLocale(
  // inviter.Language), mail_team_invite.go:35) — the tree serves English
  // only, so the corpus strings are pinned (the templates.ts header rule).
  const subject = teamInviteSubject(inviterDisplayName, orgDisplayName);
  // The render applies the template's DotEscape+escape pipeline itself — the
  // data fields carry the RAW names (templates.ts renderTeamInviteMail).
  const body = renderTeamInviteMail({
    inviterDisplayName,
    teamName: input.team.name,
    orgDisplayName,
    inviteUrl,
    inviteEmail: input.invite.email,
    appUrl: origin,
    appName: GITEA_APP_NAME,
  });

  // SendAsync's queued lane → the outbox (dedupe identity: ONE mail per
  // invite row — the row's lifecycle has exactly one create, team_invite.go:
  // 96-107; a trigger re-drive replays the same row safely).
  const enqueue = await enqueueMailOutbox(
    env,
    {
      info: subject,
      fromAddress: from.address,
      fromDisplayName: from.displayName,
      toAddr: input.invite.email,
      replyTo: null,
      subject,
      bodyHtml: body,
      headers: null,
      dedupeKey: `team-invite:${input.invite.id}`,
    },
  );
  return { outcome: "enqueued", mailId: enqueue.mailId };
}
