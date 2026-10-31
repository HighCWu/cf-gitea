/**
 * The register-notify mail (specs/email-outbound.md §2.5) — the port of
 * upstream `SendRegisterNotifyMail`
 * (gitea/services/mailer/mail_user.go:102-127) over the outbox service, and
 * the mailer's FIRST real trigger surface: upstream fires it from BOTH admin
 * creation handlers with `form.SendNotify`
 * (routers/api/v1/admin/user.go:153-156; routers/web/admin/users.go:262),
 * gated ONLY on `setting.MailService != nil` + `u.IsMailable()` —
 * `mail_user.go:104`. (The notify-mail arm's `ENABLE_NOTIFY_MAIL` gate is
 * the ISSUE/PR fan-out's, mailer.go:33-35; this surface does not ride it.)
 *
 * Our trigger is `POST /admin/users` with `send_notify: true`
 * (api/routes/admin-t2.ts — the field the route previously carried as
 * accepted-and-ignored deviation 1). The upstream fire-and-forget posture
 * (`SendAsync`, mailer.go:66-80) is the issue-events seam posture here: the
 * route awaits the outbox INSERT (cheap, D1 — the durable record) and the
 * queue send rides inside it, best-effort; the route catches and logs —
 * a mailer outage must never fail the 201.
 *
 * Upstream default `AppName` ("Gitea", `modules/setting`'s `APP_NAME`
 * fallback) — our tree declares no APP_NAME var yet, so the default is the
 * constant; a future var threads through this one call site.
 */

import { parseMailFrom } from "./message";
import { enqueueMailOutbox, type EnqueueOutcome, type MailOutboxEnv } from "./outbox";
import { registerNotifySubject, renderRegisterNotify } from "./templates";

/** Upstream `AppName` default (no cf-gitea APP_NAME var yet — see header). */
export const GITEA_APP_NAME = "Gitea";

/** Upstream `IsMailable` (models/user/user.go:538-540) over our row:
 *  a real, active, individual row with an address. */
export function isMailable(user: {
  id: number;
  email: string | null;
  status: string;
  type: string;
}): boolean {
  return user.id > 0 && user.status === "active" && user.type === "user" && (user.email ?? "") !== "";
}

/** The user shape the trigger reads (the `users` row's used slice). */
export interface MailUser {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  fullName: string | null;
  status: string;
  type: string;
}

/** Upstream `DisplayName()` (models/user/user.go): FullName when set, else
 *  the username — the `display_name` column stays NULL on our creation
 *  paths, so this is the fullName fallback in practice. */
function displayNameOf(user: MailUser): string {
  const full = (user.displayName ?? user.fullName ?? "").trim();
  return full === "" ? user.username : full;
}

/** AppUrl in upstream's trailing-slash form (templates concatenate
 *  `AppUrl + "user/login"` directly, register_notify.tmpl). */
export function appUrlWithSlash(appUrl: string | undefined): string {
  const base = appUrl === undefined || appUrl === "" ? "https://localhost" : appUrl;
  return base.endsWith("/") ? base : `${base}/`;
}

/** The env slice the trigger reads (all vars; both bindings via outbox). */
export type RegisterNotifyEnv = Pick<MailOutboxEnv, "DB" | "REPO_TASKS" | "APP_URL"> & {
  MAIL_ENABLED?: string;
  MAIL_FROM?: string;
};

export type RegisterNotifyOutcome =
  | { outcome: "disabled" }
  | { outcome: "not-mailable" }
  | { outcome: "misconfigured"; message: string }
  | { outcome: "enqueued"; enqueue: EnqueueOutcome; mailId: number };

/**
 * `SendRegisterNotifyMail`'s port: gate → render → outbox. Never throws for
 * disabled/not-mailable/misconfigured (upstream returns silently for all
 * three classes, mail_user.go:53-56,104) — only a D1 failure propagates,
 * and the route catches it (the § header posture).
 */
export async function enqueueRegisterNotifyMail(
  env: RegisterNotifyEnv,
  user: MailUser,
  options: { now?: Date } = {},
): Promise<RegisterNotifyOutcome> {
  // The master gate — upstream `MailService == nil` parity (SPEC §5.1:
  // strict polarity, only the exact "true" arms; a self-hosted deployment
  // NEVER sends mail by accident).
  if (env.MAIL_ENABLED !== "true") return { outcome: "disabled" };
  if (!isMailable(user)) return { outcome: "not-mailable" };

  const from = parseMailFrom(env.MAIL_FROM ?? "");
  if (from === null) {
    const message = `[mail] MAIL_ENABLED=true but MAIL_FROM is missing or unparseable; skipping register-notify for UID ${user.id}`;
    console.warn(message);
    return { outcome: "misconfigured", message };
  }

  const displayName = displayNameOf(user);
  const appUrl = appUrlWithSlash(env.APP_URL);
  const subject = registerNotifySubject(displayName, GITEA_APP_NAME);
  const body = renderRegisterNotify({
    displayName,
    username: user.username,
    appName: GITEA_APP_NAME,
    appUrl,
  });

  // Upstream `msg.Info = fmt.Sprintf("UID: %d, registration notify", u.ID)`
  // (mail_user.go:124); the To is `u.EmailTo()` — our render is the bare
  // address plus the display form the transport maps via `formatAddress`.
  const enqueue = await enqueueMailOutbox(
    env,
    {
      info: `UID: ${user.id}, registration notify`,
      fromAddress: from.address,
      fromDisplayName: from.displayName,
      toAddr: user.email!,
      replyTo: null,
      subject,
      bodyHtml: body,
      headers: null,
      dedupeKey: `register-notify:${user.id}`,
    },
    options,
  );
  return { outcome: "enqueued", enqueue, mailId: enqueue.mailId };
}
