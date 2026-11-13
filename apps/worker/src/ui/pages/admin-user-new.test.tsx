/**
 * The admin user CREATE page's module-level suite (PORT-FIRST: the GET+POST
 * combo lives behind the orchestrator's index.ts fold — the recipe is the
 * module header's; the seams drive directly, the admin-user-edit.test
 * pattern).
 *
 * Coverage (upstream at the pin: web.go:815's
 * `m.Combo("/new").Get(admin.NewUser).Post(web.Bind[*forms.AdminCreateUserForm](), admin.NewUserPost)`,
 * routers/web/admin/users.go:129-265 over AdminCreateUserForm, and
 * templates/admin/user/new.tmpl — census B-88):
 *
 *   - THE LOADER (NewUser's sources pull).
 *   - THE RENDER (new.tmpl): the shell chrome (`admin new user`), the
 *     pristine defaults (user_type User selected with the Bot option LIVE
 *     — B-72's landed arm, never disabled, no notice; login_type
 *     0-0 + the landed login_sources; visibility 0 with the 0/1/2 wire
 *     values; login_name hidden at the 0-0 default; must_change_password
 *     CHECKED — new.tmpl:83's literal, the create default; send_notify
 *     unchecked), and the failed-submit re-render's POSTED-values echo
 *     (RenderWithErrDeprecated's &form arm — new.tmpl:88 echoes the typed
 *     password) + the flagged field.
 *   - THE SUBMIT round-trip (NewUserPost's ladder): the created row's full
 *     column set (the insertCreatedUser posture — hashed record, rands,
 *     must_change_password as-posted, status active), the must-change
 *     default pair (rendered CHECKED, stored as-posted), the visibility
 *     wire values, the B-73 audit row (origin "ui", actor the ADMIN,
 *     scope the created user, emitted in the SAME batch — nothing on a
 *     failed create), the redirect consumption, the register-notify arm
 *     (armed mailer enqueues; no mailer or MAIL_ENABLED off → created
 *     anyway, fail-closed), the unconditioned password ladder (deviation
 *     1), the LANDED BOT BRANCH (B-72: type 'bot' + the ladder skip +
 *     the empty-passwd triple + must-change false + the
 *     never-password-auth treatment + the unchanged audit/notify arms),
 *     the name rules + collision + duplicate-email texts (bots included),
 *     the silent bind arms, and the nothing-lands discipline on every
 *     failure arm.
 *   - THE MOUNT claim (parseUiRoute's static literal — the wiring's gate
 *     arms ride the adminPagePrologue fold, the recipe in the module
 *     header).
 *
 * THE ADMIN GATE is wiring-level (adminPagePrologue — the seams here are
 * POST-gate inputs, the matrix-harness posture); the signed-in site admin
 * seeds the viewer.
 *
 * Fixture discipline: tables wiped per test (children first), ids captured
 * at seed time — never hardcoded.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { userSignInPassword } from "../../auth/password-auth";
import { auditEvents, emailOutbox, loginSources, userRedirects, users } from "../../db/schema";
import type { MailOutboxMessage } from "../../services/mail/outbox";
import { parseUiRoute } from "../index";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { adminUserNewLocale, adminUserNewDefaults, loadAdminUserNew, parseAdminUserCreateForm, renderAdminUserNewPage, submitAdminUserCreate } from "./admin-user-new";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date("2026-01-01T00:00:00Z");

// vitest's expect.* builders type as `any` — sink them through unknown once
// (the routes.test.ts convention).
const anyNumber = (): unknown => expect.any(Number);

/** Tables the fixtures touch (children first — the edit suite's list plus
 *  the audit + email-outbox pairs this suite's arms write). */
const FIXTURE_TABLES = [
  "sessions",
  "external_login_user",
  "login_source",
  "two_factor",
  "email_addresses",
  "email_outbox",
  "repo_settings",
  "repositories",
  "audit_event",
  "user_redirects",
  "org_members",
  "teams",
  "users",
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin creating/submitting the page (the route stage's
 *  posture — adminPagePrologue gates it; the seams are post-gate). */
let adminViewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

interface Seeded {
  adminId: number;
  neighborId: number;
  sourceId: number;
}

/** Recording Queue — counts sends AND captures every body (the
 *  register-notify.test pattern — no real provider, ever). */
function spyQueue(): Queue & { sends: number; sendBodies: MailOutboxMessage[] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as MailOutboxMessage[],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body as MailOutboxMessage);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sends += messages.length;
      for (const m of messages) queue.sendBodies.push(m.body as MailOutboxMessage);
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The armed mailer env (the RegisterNotifyEnv slice the submit reads). */
function armedMailer(overrides: { MAIL_ENABLED?: string; MAIL_FROM?: string } = {}) {
  return {
    DB: env.DB,
    REPO_TASKS: spyQueue(),
    MAIL_ENABLED: "true",
    MAIL_FROM: "Gitea <noreply@example.com>",
    ...overrides,
  };
}

async function seedNew(): Promise<Seeded> {
  const admin = await seedVerifiedUser({ username: "new-admin", isAdmin: true });
  await drizzle(env.DB).update(users).set({ fullName: "Root Admin" }).where(eq(users.id, admin.id)).run();
  adminViewer = { kind: "user", id: admin.id, username: admin.username, isAdmin: true };
  ctx = { viewer: adminViewer, origin: "https://test.local", assets: shellAssetsFromManifest(manifest) };

  const neighbor = await seedVerifiedUser({ username: "neighbor" });
  await drizzle(env.DB).update(users).set({ email: "neighbor@example.com" }).where(eq(users.id, neighbor.id)).run();

  // The auth source the dropdown lists (FindSources — every row, name ASC).
  const source = (
    await drizzle(env.DB)
      .insert(loginSources)
      .values({ type: 6, name: "corp-oidc", cfg: "{}", createdAt: T0, updatedAt: T0 })
      .returning({ id: loginSources.id })
      .all()
  )[0]!;

  return { adminId: admin.id, neighborId: neighbor.id, sourceId: source.id };
}

/** The full create POST — valid local values by default; `checked` names
 *  the posted checkboxes (presence = checked, the org-settings parse
 *  convention; must_change_password is CHECKED by the rendered default). */
function createForm(overrides: Record<string, string> = {}, checked: string[] = ["must_change_password"]): URLSearchParams {
  const form = new URLSearchParams({
    user_name: "new-user",
    user_type: "User",
    login_type: "0-0",
    login_name: "",
    email: "new-user@example.com",
    password: "Fresh-1a",
    visibility: "0",
    ...overrides,
  });
  for (const name of checked) form.set(name, "on");
  return form;
}

async function submit(seeded: Seeded, form: URLSearchParams, mailer?: ReturnType<typeof armedMailer>, doerId = seeded.adminId) {
  return submitAdminUserCreate(env.DB, doerId, parseAdminUserCreateForm(form), mailer);
}

async function rowByName(name: string) {
  return (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, name)).get()) ?? null;
}

async function userCount() {
  const rows = await drizzle(env.DB).select({ id: users.id }).from(users).all();
  return rows.length;
}

async function renderNew(extra: { form?: ReturnType<typeof adminUserNewDefaults>; error?: string; errorField?: "email" | "userName" | "password" } = {}) {
  const data = await loadAdminUserNew(env.DB);
  return renderAdminUserNewPage(ctx, {
    sources: data.sources,
    form: extra.form ?? adminUserNewDefaults(),
    error: extra.error ?? null,
    errorField: extra.errorField ?? null,
  });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader -----------------------------------------------------------------

describe("the loader (NewUser's data pull)", () => {
  it("pulls the auth-source dropdown's tail (FindSources — every row, name ASC)", async () => {
    const seeded = await seedNew();
    const data = await loadAdminUserNew(env.DB);
    expect(data.sources.map((source) => source.id)).toEqual([seeded.sourceId]);
  });
});

// --- the render -----------------------------------------------------------------

describe("the render (new.tmpl at the pin)", () => {
  it("carries the family shell chrome: pageClass `admin new user`, the active users item, the Title, the form action", async () => {
    await seedNew();
    const html = await renderNew();
    expect(html).toContain('class="page-content admin new user"');
    expect(html).toContain(adminUserNewLocale.new_account);
    expect(html).toContain('class="active item" href="/-/admin/users"');
    expect(html).toContain('action="/-/admin/users/new" method="post"');
  });

  it("renders the pristine defaults: User selected with the Bot option LIVE (B-72, never disabled, no notice), 0-0, visibility 0, hidden login_name", async () => {
    const seeded = await seedNew();
    const html = await renderNew();
    // user_type: the User default, the Bot option LIVE (B-72's landed arm
    // — new.tmpl:24's plain item, no disabled attr, no not-supported notice).
    expect(html).toContain('<option value="User" selected="">');
    expect(html).toContain('<option value="Bot">');
    expect(html).not.toContain("not supported yet");
    // A Bot-posted re-render selects the Bot option (the &form echo).
    const botRender = await renderNew({ form: { ...adminUserNewDefaults(), userType: "Bot" } });
    expect(botRender).toContain('<option value="User">');
    expect(botRender).toContain('<option value="Bot" selected="">');
    // login_type: the 0-0 local default + the landed source tail.
    expect(html).toContain('<option value="0-0" selected="">');
    expect(html).toContain(`<option value="6-${seeded.sourceId}">corp-oidc</option>`);
    // visibility: the public default with upstream's 0/1/2 wire values.
    expect(html).toContain('<option value="0" selected="">');
    expect(html).toContain('<option value="1">');
    expect(html).toContain('<option value="2">');
    // login_name: the 0-0 hidden arm (upstream's eq arm at the default).
    expect(html).toContain("js-non-local js-non-bot field tw-hidden");
    // email + password render empty; the password input is required with
    // the new-password autocomplete.
    expect(html).toContain('name="email" type="email" value="" required');
    expect(html).toContain('name="password" type="password" autocomplete="new-password" value="" required');
  });

  it("renders must_change_password CHECKED and send_notify unchecked (new.tmpl:83's create default)", async () => {
    await seedNew();
    const html = await renderNew();
    expect(html).toContain('name="must_change_password" type="checkbox" checked=""');
    expect(html).toContain(adminUserNewLocale.allow_password_change);
    expect(html).toContain('name="send_notify" type="checkbox"/>');
    expect(html).toContain(adminUserNewLocale.send_register_notify);
  });

  it("the failed-submit re-render carries the POSTED values (RenderWithErrDeprecated's &form), the banner, and the flagged field", async () => {
    await seedNew();
    const posted = { ...adminUserNewDefaults(), userName: "ghost-name", email: "ghost@example.com", password: "Ghost-1a" };
    const html = await renderNew({
      form: posted,
      error: "The email address is already used.",
      errorField: "email",
    });
    expect(html).toContain('<div class="ui negative message"><p>The email address is already used.</p></div>');
    expect(html).toContain('class="required field error"');
    // The &form echo — INCLUDING the typed password (new.tmpl:88's
    // value="{{.password}}"; upstream's own create shape).
    expect(html).toContain('name="user_name" value="ghost-name"');
    expect(html).toContain('name="email" type="email" value="ghost@example.com"');
    expect(html).toContain('name="password" type="password" autocomplete="new-password" value="Ghost-1a" required');
  });
});

// --- the submit: the created round-trip -------------------------------------------

describe("the submit — the created round-trip (NewUserPost's landing)", () => {
  it("creates the row with the full insertCreatedUser column set and answers created+userId", async () => {
    const seeded = await seedNew();
    const outcome = await submit(seeded, createForm());
    expect(outcome).toEqual({ outcome: "created", userId: anyNumber() });
    if (outcome.outcome !== "created") throw new Error("unreachable"); // the narrowing
    expect(outcome.userId).toBeGreaterThan(seeded.neighborId);
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.id, outcome.userId)).get())!;
    expect(row.username).toBe("new-user");
    expect(row.usernameLower).toBe("new-user");
    expect(row.email).toBe("new-user@example.com");
    expect(row.type).toBe("user");
    expect(row.isAdmin).toBe(false);
    expect(row.status).toBe("active");
    expect(row.visibility).toBe("public");
    expect(row.fullName).toBeNull();
    expect(row.displayName).toBeNull();
    // The hashed record + the Rands salt every create writes (user.go:785-791).
    expect(row.passwd).toMatch(/^[0-9a-f]{100}$/);
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(row.passwdHashAlgo).toBe("pbkdf2$50000$50");
    expect(row.rands).toMatch(/^[0-9a-f]{32}$/);
    // The rendered default CHECKED posts through to the store.
    expect(row.mustChangePassword).toBe(true);
  });

  it("stores must_change_password as-posted: the unchecked box stores FALSE (the web form has no nil→true default)", async () => {
    const seeded = await seedNew();
    expect(await submit(seeded, createForm({}, []))).toEqual({ outcome: "created", userId: anyNumber() });
    const row = await rowByName("new-user");
    expect(row!.mustChangePassword).toBe(false);
  });

  it("maps the visibility wire values (1 limited / 2 private)", async () => {
    const seeded = await seedNew();
    expect(await submit(seeded, createForm({ user_name: "lim-user", email: "lim@example.com", visibility: "1" }))).toEqual({
      outcome: "created",
      userId: anyNumber(),
    });
    expect((await rowByName("lim-user"))!.visibility).toBe("limited");
    expect(await submit(seeded, createForm({ user_name: "priv-user", email: "priv@example.com", visibility: "2" }))).toEqual({
      outcome: "created",
      userId: anyNumber(),
    });
    expect((await rowByName("priv-user"))!.visibility).toBe("private");
  });

  it("emits the user:create audit row in the SAME batch — actor the ADMIN, scope the created user, origin ui (B-73, users.go:256)", async () => {
    const seeded = await seedNew();
    const outcome = await submit(seeded, createForm());
    const createdId = outcome.outcome === "created" ? outcome.userId : 0;
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "user:create",
      actorId: seeded.adminId, // ctx.Doer — the admin, not the created user
      actorName: "Root Admin", // DisplayName (user.go:476-482): FullName set → FullName
      scopeType: "user",
      scopeId: String(createdId), // the decimal string (the scope_id drift note)
      scopeName: "new-user",
      origin: "ui",
      message: "Created user new-user.", // the registry template rendered at emit
    });
  });

  it("emits NOTHING on a failed create — the audit row rolls back with the write (§4.2)", async () => {
    const seeded = await seedNew();
    await submit(seeded, createForm()); // one success first
    const failed = await submit(seeded, createForm({ user_name: "second-user", email: "neighbor@example.com" })); // duplicate email
    expect(failed).toEqual({ outcome: "invalid", message: "The email address is already used.", field: "email" });
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1); // only the success's row
  });

  it("consumes a live redirect at the created name (user.go:798's DeleteUserRedirect)", async () => {
    const seeded = await seedNew();
    await drizzle(env.DB).insert(userRedirects).values({ lowerName: "old-name", redirectUserId: seeded.neighborId }).run();
    expect(await submit(seeded, createForm({ user_name: "old-name", email: "old@example.com" }))).toEqual({
      outcome: "created",
      userId: anyNumber(),
    });
    const redirects = await drizzle(env.DB).select().from(userRedirects).where(eq(userRedirects.lowerName, "old-name")).all();
    expect(redirects).toEqual([]); // consumed by the create
  });

  it("the register-notify arm: an armed mailer enqueues; no mailer or MAIL_ENABLED off → created anyway (fail-closed)", async () => {
    const seeded = await seedNew();
    // Armed: the outbox row + the queue send ride the landing.
    const mailer = armedMailer();
    expect(await submit(seeded, createForm({ user_name: "notified", email: "notified@example.com" }, ["must_change_password", "send_notify"]), mailer)).toEqual({
      outcome: "created",
      userId: anyNumber(),
    });
    expect((mailer.REPO_TASKS as unknown as { sends: number }).sends).toBe(1);
    const outbox = await drizzle(env.DB).select().from(emailOutbox).all();
    expect(outbox).toHaveLength(1);

    // No mailer: the arm skips, the create lands.
    expect(await submit(seeded, createForm({ user_name: "quiet", email: "quiet@example.com" }, ["must_change_password", "send_notify"]))).toEqual({
      outcome: "created",
      userId: anyNumber(),
    });

    // MAIL_ENABLED off: the seam answers disabled, the create lands, zero sends.
    const offMailer = armedMailer({ MAIL_ENABLED: "false" });
    expect(await submit(seeded, createForm({ user_name: "off", email: "off@example.com" }, ["must_change_password", "send_notify"]), offMailer)).toEqual({
      outcome: "created",
      userId: anyNumber(),
    });
    expect((offMailer.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });
});

// --- the submit: the password ladder ------------------------------------------------

describe("the submit — the password ladder (users.go:199-211, unconditioned per deviation 1)", () => {
  it("a too-short password re-renders with the min-length text, field flagged, nothing lands", async () => {
    const seeded = await seedNew();
    const before = await userCount();
    expect(await submit(seeded, createForm({ password: "a" }))).toEqual({
      outcome: "invalid",
      message: "Password length cannot be less than 8 characters.",
      field: "password",
    });
    expect(await userCount()).toBe(before);
  });

  it("a WEAK single-class password CREATES at the default config (B-87's correction, attributed cross-edit: upstream's unset PASSWORD_COMPLEXITY is checking OFF — security.go:209-218 seeds \"off\" when the key is unset, app.example.ini:503 states it; the pre-B-87 all-classes arm mis-derived setupComplexity's invalid-values fallback as the default; the ARMED re-render shape pins in admin-t2.test.ts's knob battery)", async () => {
    const seeded = await seedNew();
    const before = await userCount();
    const weak = await submit(seeded, createForm({ password: "alllowercase123" }));
    expect(weak.outcome).toBe("created");
    expect(await userCount()).toBe(before + 1);
    expect((await rowByName("new-user"))!.username).toBe("new-user");
  });

  it("the ladder is UNCONDITIONED — a source login_type still ladders and stores (deviation 1: the accepted-and-ignored set)", async () => {
    const seeded = await seedNew();
    expect(
      await submit(seeded, createForm({ user_name: "src-user", email: "src@example.com", login_type: `6-${seeded.sourceId}`, login_name: "ext-id" })),
    ).toEqual({ outcome: "created", userId: anyNumber() });
    const row = await rowByName("src-user");
    expect(row!.passwd).toMatch(/^[0-9a-f]{100}$/); // the ladder ran; the hash stored
  });
});

// --- the submit: the landed Bot branch (B-72, users.go:190-193 + the :199 gate) -------

describe("the submit — the landed Bot branch (B-72: users.go:190-193's arm over the :199 !IsTypeBot gate)", () => {
  it("user_type Bot CREATES a bot row: type 'bot', the empty-passwd triple (user.go:788-794), the Rands salt, the audit + outcome unchanged", async () => {
    const seeded = await seedNew();
    const outcome = await submit(
      seeded,
      createForm({ user_type: "Bot", user_name: "ci-bot", email: "ci-bot@example.com", password: "x" }),
    );
    expect(outcome).toEqual({ outcome: "created", userId: anyNumber() });
    const row = await rowByName("ci-bot");
    expect(row!.type).toBe("bot");
    // createUser's empty-passwd branch: passwd '' + salt '' + algo '' —
    // and the Rands salt still written (:785-786, unconditional).
    expect(row!.passwd).toBe("");
    expect(row!.salt).toBe("");
    expect(row!.passwdHashAlgo).toBe("");
    expect(row!.rands).toMatch(/^[0-9a-f]{32}$/);
    expect(row!.status).toBe("active");
    expect(row!.email).toBe("ci-bot@example.com");
    const audits = await drizzle(env.DB).select().from(auditEvents).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "user:create", scopeName: "ci-bot", origin: "ui" });
  });

  it("the password ladder is SKIPPED for bots (:199's !IsTypeBot gate wraps it) — a 1-char password still lands", async () => {
    const seeded = await seedNew();
    expect(
      await submit(seeded, createForm({ user_type: "Bot", user_name: "weak-bot", email: "weak-bot@example.com", password: "a" })),
    ).toEqual({ outcome: "created", userId: anyNumber() });
    expect((await rowByName("weak-bot"))!.type).toBe("bot");
  });

  it("must_change_password stores FALSE for bots even when the box posts checked (:220-221's assignment sits inside the non-bot gate)", async () => {
    const seeded = await seedNew();
    await submit(seeded, createForm({ user_type: "Bot", user_name: "nc-bot", email: "nc-bot@example.com" }, ["must_change_password"]));
    expect((await rowByName("nc-bot"))!.mustChangePassword).toBe(false);
  });

  it("a bot NEVER password-authenticates: no hash on the row and the login lookups are Individual-only (user.go:1137/:1405, mirrored by password-auth.ts's type='user' filters) — both arms answer the generic not-exist", async () => {
    const seeded = await seedNew();
    await submit(seeded, createForm({ user_type: "Bot", user_name: "auth-bot", email: "auth-bot@example.com" }));
    const nameArm = await userSignInPassword(env.DB, "auth-bot", "anything");
    expect(nameArm).toEqual({ ok: false, failure: { kind: "user-not-exist" } });
    const emailArm = await userSignInPassword(env.DB, "auth-bot@example.com", "anything");
    expect(emailArm).toEqual({ ok: false, failure: { kind: "user-not-exist" } });
  });

  it("the notify arm runs for a bot create (:262, no type gate at the call site) but the seam's IsMailable refuses bots (mail_user.go:104 over user.go:537-540's IsIndividual conjunct) — created, ZERO sends", async () => {
    const seeded = await seedNew();
    const mailer = armedMailer();
    expect(
      await submit(
        seeded,
        createForm({ user_type: "Bot", user_name: "notify-bot", email: "notify-bot@example.com" }, [
          "must_change_password",
          "send_notify",
        ]),
        mailer,
      ),
    ).toEqual({ outcome: "created", userId: anyNumber() });
    expect((mailer.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
    const outbox = await drizzle(env.DB).select().from(emailOutbox).all();
    expect(outbox).toHaveLength(0);
  });

  it("the name rules ride for bots too — a reserved name still answers the WEB text, nothing lands", async () => {
    const seeded = await seedNew();
    const before = await userCount();
    expect(await submit(seeded, createForm({ user_type: "Bot", user_name: "api" }))).toEqual({
      outcome: "invalid",
      message: 'The username "api" is reserved.',
      field: "userName",
    });
    expect(await userCount()).toBe(before);
  });

  it("junk user_type fails the In() bind — the flag-less silent re-render, nothing lands", async () => {
    const seeded = await seedNew();
    const before = await userCount();
    expect(await submit(seeded, createForm({ user_type: "Organization" }))).toEqual({
      outcome: "invalid",
      message: null,
      field: null,
    });
    expect(await userCount()).toBe(before);
  });
});

// --- the submit: the name rules, collisions, duplicates -------------------------------

describe("the submit — the name rules, the collision, and the duplicate email (users.go:226-249's mapping)", () => {
  it("reserved and junk-char names carry the WEB texts, field flagged, nothing lands", async () => {
    const seeded = await seedNew();
    const before = await userCount();
    expect(await submit(seeded, createForm({ user_name: "api" }))).toEqual({
      outcome: "invalid",
      message: 'The username "api" is reserved.',
      field: "userName",
    });
    expect(await submit(seeded, createForm({ user_name: "a b" }))).toEqual({
      outcome: "invalid",
      message: 'Username "a b" contains invalid characters.',
      field: "userName",
    });
    expect(await userCount()).toBe(before);
  });

  it("the namespace collision answers form.username_been_taken, field flagged", async () => {
    const seeded = await seedNew();
    expect(await submit(seeded, createForm({ user_name: "neighbor" }))).toEqual({
      outcome: "invalid",
      message: "The username is already taken.",
      field: "userName",
    });
    // The case-folded arm too (the UNIQUE(username_lower) pre-check).
    expect(await submit(seeded, createForm({ user_name: "Neighbor", email: "other@example.com" }))).toEqual({
      outcome: "invalid",
      message: "The username is already taken.",
      field: "userName",
    });
  });

  it("a foreign duplicate email (case-folded) answers form.email_been_used, field flagged", async () => {
    const seeded = await seedNew();
    expect(await submit(seeded, createForm({ email: "NEIGHBOR@Example.Com" }))).toEqual({
      outcome: "invalid",
      message: "The email address is already used.",
      field: "email",
    });
  });
});

// --- the submit: the silent bind arms -------------------------------------------------

describe("the submit — the silent bind arms (web.Bind's AdminCreateUserForm, users.go:169-172)", () => {
  it("each bind miss re-renders flagged, NO banner, NOTHING else runs", async () => {
    const seeded = await seedNew();
    const before = await userCount();
    expect(await submit(seeded, createForm({ login_type: "" }))).toEqual({ outcome: "invalid", message: null, field: "loginType" });
    expect(await submit(seeded, createForm({ user_name: "" }))).toEqual({ outcome: "invalid", message: null, field: "userName" });
    expect(await submit(seeded, createForm({ user_name: "x".repeat(41) }))).toEqual({ outcome: "invalid", message: null, field: "userName" });
    expect(await submit(seeded, createForm({ email: "" }))).toEqual({ outcome: "invalid", message: null, field: "email" });
    expect(await submit(seeded, createForm({ email: "not-an-email" }))).toEqual({ outcome: "invalid", message: null, field: "email" });
    expect(await submit(seeded, createForm({ visibility: "9" }))).toEqual({ outcome: "invalid", message: null, field: "visibility" });
    expect(await userCount()).toBe(before);
  });
});

// --- the mount claim -----------------------------------------------------------------

describe("the mount claim (parseUiRoute's static literal — the recipe's step 2)", () => {
  it("claims /-/admin/users/new exactly; every near-miss stays unclaimed (engine-404)", () => {
    expect(parseUiRoute("/-/admin/users/new")).toEqual({ family: "admin-user-new" });
    // The digits-only {userid} claim keeps its own shape (no shadow either way).
    expect(parseUiRoute("/-/admin/users/7")).toEqual({ family: "admin-user-detail", adminUserId: 7 });
    // Near-misses stay engine-404: case, depth, and junk arms.
    expect(parseUiRoute("/-/admin/users/NEW")).toBeNull();
    expect(parseUiRoute("/-/admin/users/new/x")).toBeNull();
    expect(parseUiRoute("/-/admin/users/news")).toBeNull();
  });
});
