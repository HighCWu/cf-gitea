/**
 * The ADMIN MONITOR platform-arms' ROUTE tests (the 6cc57d8 module's
 * ui/index.ts fold — the module header's Platform-arms HANDOFF): the three
 * new families driven through the mounted uiRouter —
 *
 *   POST /-/admin/monitor/queue/{qid}/set — the Pool Settings write (the
 *     guard-first ladder, the junk-qid 404, the invalid-form error flash
 *     re-render, the unconfigured honest skip, and the applied loop with
 *     its audit row over a stubbed platform fetch)
 *   GET /-/admin/monitor/diagnosis — the composite report (the gate ladder
 *     + the honest unconfigured/unavailable arms + a configured read)
 *   GET /-/admin/monitor/profile — the pprof trigger download (the
 *     unconfigured/bad-params 303 skip back to the trace page, the ok
 *     arm's octet-stream attachment over the stub, the failed trigger's
 *     303)
 *
 * The harness is the admin-monitor module tests' mounted-route pattern
 * (minted admin sessions, the synthetic manifest, real D1 via the
 * generated migrations); the platform seam is stubbed at globalThis.fetch —
 * the route passes no fetchImpl, so the services' default fetch IS the
 * seam. The route-claim pins ride too (parse ↔ registration agreement at
 * the exact upstream shapes: the {qid} group's /set write, the two
 * 2-segment literals).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { auditEvents, users } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { MONITOR_QUEUE_SET_AUDIT_ACTION } from "../../services/monitor/queue-concurrency";

// --- fixtures (the admin-monitor module tests' mounted-route pattern) -------

const ORIGIN = "https://test.local";
const AT = new Date("2026-11-01T12:00:00Z");

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The configured platform slice (the queue-set allowlist with one entry —
 *  the services' platformConfig twin; spread-only additions so the literal
 *  stays assignable to the pre-wrangler-fold Env). */
const platformSlice = {
  CLOUDFLARE_ACCOUNT_ID: "acct01",
  CLOUDFLARE_QUEUES_TOKEN: "q-tok",
  CLOUDFLARE_PROFILE_TOKEN: "p-tok",
  MONITOR_QUEUE_CONSUMERS: JSON.stringify({
    "repo-tasks": { queue_id: "repo-tasks", consumer_id: "c1", declared_max_concurrency: 1 },
  }),
};

async function fetchUiOn(envX: RouteEnv, path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), envX, context);
  await waitOnExecutionContext(context);
  return response;
}

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return fetchUiOn(routeEnv, path, init);
}

/** A minted session cookie header for the user id (the real mintSession
 *  path — the module harness's posture; wiped per test via beforeEach). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A principal row (`isAdmin` decides the admin prologue's gate — the flag
 *  is re-read from the users row per request); returns the fresh id. */
async function seedPrincipal(username: string, isAdmin: boolean): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), isAdmin, createdAt: AT })
    .returning({ id: users.id })
    .all();
  return rows[0]!.id;
}

async function adminSessionHeader(): Promise<string> {
  return sessionHeader(await seedPrincipal("root", true));
}

/** A urlencoded POST to one queue's set route (default: the browser's
 *  same-origin Origin header + an admin cookie). */
async function queueSetPost(
  fields: Record<string, string>,
  envX: RouteEnv = routeEnv,
  cookie: string | undefined = undefined,
  origin: string = ORIGIN,
): Promise<Response> {
  return fetchUiOn(envX, "/-/admin/monitor/queue/repo-tasks/set", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- the platform seam stub (call-order responses; the services'
// stubFetch shape lifted onto the global the route's services resolve) -----

interface RecordedRequest {
  url: string;
  method: string;
  body: string | undefined;
}

function stubPlatformFetch(responses: (Response | ((req: RecordedRequest) => Response))[]): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body =
      init?.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : new TextDecoder().decode(await new Response(init.body as BodyInit).arrayBuffer());
    calls.push({ url, method: init?.method ?? "GET", body });
    const response = responses[calls.length - 1];
    if (response === undefined) throw new Error(`unexpected platform request #${calls.length}: ${init?.method ?? "GET"} ${url}`);
    return typeof response === "function" ? response(calls[calls.length - 1]!) : response;
  };
  vi.stubGlobal("fetch", stub);
  return calls;
}

const consumerEnvelope = (maxConcurrency: number | null) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        consumer_id: "c1",
        created_on: "2026-10-01T00:00:00Z",
        dead_letter_queue: "repo-tasks-dlq",
        queue_name: "repo-tasks",
        script_name: "cf-gitea",
        type: "worker",
        settings: {
          batch_size: 3,
          max_concurrency: maxConcurrency,
          max_retries: 5,
          max_wait_time_ms: 5000,
          retry_delay: 10,
        },
      },
    }),
    { status: 200 },
  );

const deploymentsEnvelope = () =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        deployments: [
          {
            id: "dep-1234567890abcdef",
            created_on: "2026-10-31T00:00:00Z",
            source: "upload",
            message: null,
            annotations: {},
            versions: [{ percentage: 100, version_id: "ver-abcdef12345678" }],
          },
        ],
      },
    }),
    { status: 200 },
  );

/** A minimal gzip-magic-prefixed body (the trigger's validation is the size
 *  cap + the RFC 1952 magic — the deep pprof parse is the probe battery's). */
const profileBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 2, 1, 2, 3]);

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_event").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM users").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the route claims (parse ↔ registration agreement) -----------------------

describe("the platform-arms route claims (the module header's HANDOFF shapes)", () => {
  it("the {qid} group's /set write parses with the queue NAME qid (upstream's web.go:807 group shape)", () => {
    expect(parseUiRoute("/-/admin/monitor/queue/repo-tasks/set")).toEqual({ family: "admin-monitor-queue-set", qid: "repo-tasks" });
    expect(handlesUiRoute("/-/admin/monitor/queue/repo-tasks/set")).toBe(true);
  });

  it("the diagnosis and profile literals parse (web.go:811 + the PerfTrace download arm)", () => {
    expect(parseUiRoute("/-/admin/monitor/diagnosis")).toEqual({ family: "admin-monitor-diagnosis" });
    expect(parseUiRoute("/-/admin/monitor/profile")).toEqual({ family: "admin-monitor-profile" });
    expect(handlesUiRoute("/-/admin/monitor/diagnosis")).toBe(true);
    expect(handlesUiRoute("/-/admin/monitor/profile")).toBe(true);
  });

  it("junk tails stay unclaimed — the engine's 404 funnel", () => {
    expect(parseUiRoute("/-/admin/monitor/queue/repo-tasks/set/extra")).toBeNull();
    expect(parseUiRoute("/-/admin/monitor/diagnosis/extra")).toBeNull();
    expect(parseUiRoute("/-/admin/monitor/profilez")).toBeNull();
    expect(parseUiRoute("/-/admin/monitor/queue/repo-tasks/sets")).toBeNull();
    expect(handlesUiRoute("/-/admin/monitor/diagnosis/extra")).toBe(false);
  });
});

// --- POST /-/admin/monitor/queue/{qid}/set -----------------------------------

describe("POST /-/admin/monitor/queue/{qid}/set (the Pool Settings write)", () => {
  it("303s an anonymous same-origin POST onto the login round-trip (guard passes, then the gate)", async () => {
    const res = await queueSetPost({ "max-number": "5" }, routeEnv, undefined, ORIGIN);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/monitor/queue/repo-tasks/set")}`);
  });

  it("403s a cross-origin POST before the gate (the guard-first posture)", async () => {
    const res = await queueSetPost({ "max-number": "5" }, routeEnv, await adminSessionHeader(), "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("404s a junk qid (the decode funnel)", async () => {
    const res = await fetchUiOn(routeEnv, `/-/admin/monitor/queue/${encodeURIComponent("repo%zztasks")}/set`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await adminSessionHeader() },
      body: new URLSearchParams({ "max-number": "5" }).toString(),
    });
    expect(res.status).toBe(404);
  });

  it("an invalid form re-renders the fresh manage page with upstream's maxnumberworkers.error flash (the honest skip arm's unconfigured panel)", async () => {
    const res = await queueSetPost({ "max-number": "junk" }, routeEnv, await adminSessionHeader());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Max number of workers must be a number");
    expect(html).toContain('class="ui negative message"');
    // The unconfigured platform panel renders its honest posture (no tokens).
    expect(html).toContain("Not configured");
  });

  it("an unconfigured token answers the honest skip: the manage page re-render with the service's negative flash, never a fabricated success", async () => {
    const res = await queueSetPost({ "max-number": "5" }, routeEnv, await adminSessionHeader());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The queue platform arm is not configured (no CLOUDFLARE_QUEUES_TOKEN).");
    expect(html).not.toContain("Settings Updated");
  });

  it("an applied write carries the positive flash, preserves the untouched settings in the PUT, and emits the audit row", async () => {
    const calls = stubPlatformFetch([
      consumerEnvelope(1), // the loop's read (before = 1)
      consumerEnvelope(5), // the PUT's ack envelope
      consumerEnvelope(5), // the verify GET (effective = 5)
      consumerEnvelope(5), // the re-rendered manage page's runtime read
    ]);
    const cookie = await adminSessionHeader();
    const res = await queueSetPost({ "max-number": "5" }, { ...routeEnv, ...platformSlice }, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Settings Updated");
    expect(html).toContain('class="ui positive message"');
    // The closed loop over the platform API: GET read → PUT → GET verify,
    // then the page's runtime read.
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/acct01/queues/repo-tasks/consumers/c1" });
    expect(calls[1]!.method).toBe("PUT");
    const putBody = JSON.parse(calls[1]!.body!) as { settings: Record<string, unknown> };
    expect(putBody.settings.max_concurrency).toBe(5);
    expect(putBody.settings.batch_size).toBe(3); // the preservation rule
    expect(calls[2]).toMatchObject({ method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/acct01/queues/repo-tasks/consumers/c1" });
    // The audit row: operator, before, after, API result (the freeze).
    const rows = await drizzle(env.DB)
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, MONITOR_QUEUE_SET_AUDIT_ACTION))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorName: "root", scopeType: "system", origin: "ui" });
    expect(rows[0]!.message).toBe("Changed queue consumer repo-tasks max_concurrency from 1 to 5 (API updated).");
    const metadata = JSON.parse(rows[0]!.metadata!) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      queue: "repo-tasks",
      consumer_id: "c1",
      before_max_concurrency: 1,
      after_max_concurrency: 5,
      effective_max_concurrency: 5,
      declared_max_concurrency: 1,
      api_result: "ok",
    });
  });
});

// --- GET /-/admin/monitor/diagnosis ------------------------------------------

describe("GET /-/admin/monitor/diagnosis (the composite report)", () => {
  it("303s an anonymous GET onto the login round-trip; a non-admin 404-shells", async () => {
    const anon = await fetchUi("/-/admin/monitor/diagnosis");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/monitor/diagnosis")}`);
    const peon = await fetchUi("/-/admin/monitor/diagnosis", { headers: { cookie: await sessionHeader(await seedPrincipal("peon", false)) } });
    expect(peon.status).toBe(404);
  });

  it("an unconfigured platform renders every degraded arm honestly (unavailable + Not configured), never a fabricated zero", async () => {
    const res = await fetchUi("/-/admin/monitor/diagnosis", { headers: { cookie: await adminSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Diagnosis Report");
    expect(html).toContain("unavailable");
    expect(html).toContain("Not configured");
    // The D1 mirror rows stay available (the local read) — the two status
    // dimensions share the report without conflation.
    expect(html).toContain("D1 business mirror");
  });

  it("a configured platform reads the queue truth and the serving deployment over the stubbed API (per-source stamps)", async () => {
    const calls = stubPlatformFetch([consumerEnvelope(2), deploymentsEnvelope()]);
    const res = await fetchUiOn({ ...routeEnv, ...platformSlice }, "/-/admin/monitor/diagnosis", {
      headers: { cookie: await adminSessionHeader() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Queue consumer repo-tasks (Cloudflare queue truth)");
    expect(html).toContain("max_concurrency 2");
    expect(html).toContain("Deployment version (serving)");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/acct01/queues/repo-tasks/consumers/c1" });
    expect(calls[1]).toMatchObject({ method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/acct01/workers/scripts/cf-gitea/deployments" });
  });
});

// --- GET /-/admin/monitor/profile --------------------------------------------

describe("GET /-/admin/monitor/profile (the pprof trigger download)", () => {
  it("303s an anonymous GET onto the login round-trip", async () => {
    const res = await fetchUi("/-/admin/monitor/profile?type=cpu&seconds=5");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/monitor/profile?type=cpu&seconds=5")}`);
  });

  it("an unconfigured token skips honestly: 303 back onto the trace page (the arm's only surface), no platform call", async () => {
    const res = await fetchUi("/-/admin/monitor/profile?type=cpu&seconds=5", { headers: { cookie: await adminSessionHeader() } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/-/admin/monitor/stacktrace");
  });

  it("bad params skip the same way (the failed binding is never a guessed default)", async () => {
    const calls = stubPlatformFetch([]);
    const res = await fetchUiOn({ ...routeEnv, ...platformSlice }, "/-/admin/monitor/profile?type=cpu&seconds=junk", {
      headers: { cookie: await adminSessionHeader() },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/-/admin/monitor/stacktrace");
    expect(calls).toHaveLength(0); // the parse precedes any platform call
  });

  it("the ok arm streams the verified bytes as the attachment, versioned by the deployments read", async () => {
    const calls = stubPlatformFetch([deploymentsEnvelope(), new Response(profileBytes, { status: 200 })]);
    const res = await fetchUiOn({ ...routeEnv, ...platformSlice }, "/-/admin/monitor/profile?type=heap&seconds=10", {
      headers: { cookie: await adminSessionHeader() },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment; filename=");
    expect(res.headers.get("content-disposition")).toContain("cf-gitea-profile-heap-");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body[0]).toBe(0x1f); // the gzip magic rides verbatim
    expect(body[1]).toBe(0x8b);
    // The deployments GET resolved the serving version into the trigger.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/acct01/workers/scripts/cf-gitea/deployments" });
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toContain("/workers/cf-gitea/versions/ver-abcdef12345678/profile");
    const triggerBody = JSON.parse(calls[1]!.body!) as Record<string, unknown>;
    expect(triggerBody).toEqual({ duration_ms: 10000, profile_type: "heap" });
  });

  it("a degraded platform answer 303s back onto the trace page (the console carries the reason)", async () => {
    const con = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      stubPlatformFetch([deploymentsEnvelope(), new Response('{"errors":[{"message":"boom"}]}', { status: 500 })]);
      const res = await fetchUiOn({ ...routeEnv, ...platformSlice }, "/-/admin/monitor/profile?type=cpu&seconds=5", {
        headers: { cookie: await adminSessionHeader() },
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/-/admin/monitor/stacktrace");
    } finally {
      con.mockRestore();
    }
  });
});
