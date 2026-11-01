/**
 * The USER settings packages CHEF keypair web arm's tests
 * (pages/user-settings-packages-chef.tsx): the section's DOM contract
 * (packages.tmpl:6-21 — the title header, the description label, the bare
 * POST form with its primary button, the documentation anchor; NO confirm
 * dialog attributes — the template's exact shape), the key-state loader's
 * arms (no stored public PEM vs one), the regenerate seam (the returned
 * private PEM pairs with the STORED public — the PKCS#1 modulus walk — and
 * rotates: a second call discards the old key both in the response and in
 * the store), the download response's exact ServeContent header set (the
 * application/x-pem-file attachment with NO last-modified — upstream
 * passes no LastModified), and the MOUNTED route's ladder through
 * `uiRouter.fetch` + a minted session (the user-settings-keys route
 * harness): the anonymous 303, the cross-origin 403 ahead of any write,
 * the GET twin's 405, the signed-in round-trip (private key shown ONCE,
 * the stored setting parses as the NEW public PEM, no private material in
 * the store), the rotation POST, and the parse-tree claim arms (the
 * regenerate literal; the junk/deeper tails stay the engine's 404s).
 *
 * The reload-shows-nothing arm drives GET /user/settings/packages and pins
 * the page never carries private material — structurally true now (the
 * landed page's chef section is the fold-back recipe, the module header)
 * and load-bearing once that fold lands.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { userSettingsKv, users } from "../../db/schema";
import { uiEnv } from "../__tests__/harness";
import { uiRouter, parseUiRoute } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { parseChefPublicKey } from "../../services/packages/chef-auth";
import {
  ChefKeypairSection,
  chefKeypairDownloadResponse,
  loadChefKeypairSectionData,
  regenerateChefKeypair,
  userSettingsChefLocale,
} from "./user-settings-packages-chef";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z

beforeAll(async () => {
  await applyAuthD1Migrations();
});

const db = () => drizzle(env.DB);

let aliceId = 0;
const aliceName = "alice";

beforeEach(async () => {
  await db().delete(userSettingsKv).run();
  await db().delete(users).run();
  const rows = await db()
    .insert(users)
    .values({ username: aliceName, usernameLower: aliceName, status: "active", email: "alice@test.local", createdAt: T0 })
    .returning()
    .all();
  aliceId = rows[0]!.id;
});

/** The stored chef.public_pem value (null on the miss). */
async function storedPublicPem(): Promise<string | null> {
  const row = await db()
    .select({ value: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(eq(userSettingsKv.settingKey, "chef.public_pem"))
    .get();
  return row?.value ?? null;
}

/** The PEM body's DER bytes (the single BEGIN/END block's base64). */
function pemDer(pem: string): Uint8Array {
  const body = pem.split("\n").filter((line) => line.length > 0 && !line.startsWith("-----")).join("");
  let binary = "";
  for (const byte of atob(body)) binary += byte;
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Minimal DER walk: the RSAPrivateKey SEQUENCE's children, the content of
 *  child[i] (skipping the version INTEGER at 0 — `n` sits at 1). */
function derChildContent(der: Uint8Array, index: number): Uint8Array {
  const readLength = (offset: number): { length: number; next: number } => {
    const first = der[offset]!;
    if (first < 0x80) return { length: first, next: offset + 1 };
    const count = first & 0x7f;
    let length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | der[offset + 1 + i]!;
    return { length, next: offset + 1 + count };
  };
  const outer = readLength(1);
  let cursor = outer.next;
  for (let i = 0; i < index; i++) {
    const child = readLength(cursor + 1);
    cursor = child.next + child.length;
  }
  const target = readLength(cursor + 1);
  return der.slice(target.next, target.next + target.length);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  const stripped = bytes[0] === 0x00 ? bytes.slice(1) : bytes;
  let result = 0n;
  for (const byte of stripped) result = (result << 8n) | BigInt(byte);
  return result;
}

// --- the section's DOM contract ----------------------------------------------

describe("ChefKeypairSection (packages.tmpl:6-21)", () => {
  const base = "/user/settings/packages";

  it("renders the exact upstream section: title header, description, the bare POST form, the documentation anchor", () => {
    const html = renderToString(<ChefKeypairSection base={base} />);
    expect(html).toContain(`<h4 class="ui top attached header">${userSettingsChefLocale.title}</h4>`);
    expect(html).toContain(`<div class="ui attached segment"><div class="ui form">`);
    // packages.tmpl:11-13 — the description label.
    expect(html).toContain(`<label>${userSettingsChefLocale.keypair_description}</label>`);
    // packages.tmpl:14-16 — {{.Link}}/chef/regenerate_keypair over the page
    // base, method post, ONE primary submit button.
    expect(html).toContain(`<form class="field" action="${base}/chef/regenerate_keypair" method="post">`);
    expect(html).toContain(`<button type="submit" class="ui primary button">${userSettingsChefLocale.keypair}</button>`);
    // packages.tmpl:17-19 — the documentation label with the structural
    // anchor (the locale's target/rel/href verbatim).
    expect(html).toContain(`For more information on the Chef registry, see`);
    expect(html).toContain(`<a target="_blank" rel="noopener noreferrer" href="${userSettingsChefLocale.documentation_url}">`);
    expect(html).toContain(`>${userSettingsChefLocale.documentation_link_text}</a>.`);
    // NO confirm dialog upstream — no data-* / fetch-action attributes on
    // the form (the template's exact shape).
    expect(html).not.toContain("data-");
    expect(html).not.toContain("fetch-action");
    expect(html).not.toContain("confirm");
  });

  it("the form action rides the base ({{.Link}}) — a foreign base moves the whole action", () => {
    const html = renderToString(<ChefKeypairSection base="/other/link" />);
    expect(html).toContain(`action="/other/link/chef/regenerate_keypair"`);
  });

  it("renders no key-state indicator — the template's markup is identical with and without a stored PEM", async () => {
    // The loader's arms (the state read), rendered state-INDEPENDENTLY:
    expect((await loadChefKeypairSectionData(env.DB, aliceId)).hasPublicPem).toBe(false);
    await regenerateChefKeypair(env.DB, aliceId);
    expect((await loadChefKeypairSectionData(env.DB, aliceId)).hasPublicPem).toBe(true);
    // The markup carries no state branch (structural — no state prop; the
    // two renders are byte-identical).
    expect(renderToString(<ChefKeypairSection base="/user/settings/packages" />)).toBe(
      renderToString(<ChefKeypairSection base="/user/settings/packages" />),
    );
    expect(renderToString(<ChefKeypairSection base="/user/settings/packages" />)).not.toContain("hasPublicPem");
  });
});

// --- the regenerate seam ------------------------------------------------------

describe("regenerateChefKeypair (setting/packages.go:104-112)", () => {
  it("stores ONLY the public PEM and returns the private PKCS#1 PEM; the pair matches", async () => {
    const privatePem = await regenerateChefKeypair(env.DB, aliceId);
    expect(privatePem).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(privatePem.endsWith("\n-----END RSA PRIVATE KEY-----\n")).toBe(true);

    const stored = await storedPublicPem();
    expect(stored).not.toBeNull();
    expect(stored!).toContain("BEGIN PUBLIC KEY");
    // The private bytes NEVER persist — the store keeps the public arm.
    expect(stored!).not.toContain("PRIVATE KEY");
    expect(await db().select().from(userSettingsKv).all()).toHaveLength(1);

    // The pairing pin: the private PEM's PKCS#1 modulus equals the stored
    // public PEM's parsed modulus (the response's key IS the stored key's
    // twin — not a stale/parallel pair).
    const privateN = bytesToBigInt(derChildContent(pemDer(privatePem), 1));
    const publicN = (await parseChefPublicKey(stored!)).modulus;
    expect(privateN).toBe(publicN);
  });

  it("a second call rotates: a fresh private body and the old public discarded", async () => {
    const first = await regenerateChefKeypair(env.DB, aliceId);
    const firstN = (await parseChefPublicKey((await storedPublicPem())!)).modulus;
    const second = await regenerateChefKeypair(env.DB, aliceId);
    expect(second).not.toBe(first);
    const secondN = (await parseChefPublicKey((await storedPublicPem())!)).modulus;
    expect(secondN).not.toBe(firstN);
    // Still exactly one setting row (the upsert, never an append).
    expect(await db().select().from(userSettingsKv).all()).toHaveLength(1);
  });
});

// --- the download response -----------------------------------------------------

describe("chefKeypairDownloadResponse (ctx.ServeContent's header set)", () => {
  it("carries the exact ServeContent headers — attachment, nosniff, sandbox CSP, private no-cache, ranges — and NO last-modified", async () => {
    const res = chefKeypairDownloadResponse(aliceName, "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----\n");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-pem-file");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    // serve.go:91 — ContentDisposition zero → attachment; path.Base + the
    // mime encoding (the landed port: a plain token name rides bare).
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename=${aliceName}.priv`);
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // http.ServeContent's seekable-reader posture.
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = await res.text();
    expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).byteLength));
    // serve.go:101 — upstream passes no LastModified (the zero-time skip).
    expect(res.headers.get("last-modified")).toBeNull();
    expect(body).toContain("BEGIN RSA PRIVATE KEY");
  });
});

// --- the mounted route (index.ts: the POST + the 405 twin + the guards) -------

describe("the mounted /user/settings/packages/chef/regenerate_keypair route", () => {
  /** A signed-in POST (the repo-editor-tails harness: the real router over
   *  uiEnv, a minted session cookie, the §2.8 origin header). The body is
   *  read as bytes + decoded (the PEM rides a non-text content-type —
   *  workerd warns on a bare .text()). */
  async function postRegenerate(origin = "https://test.local"): Promise<{ res: Response; body: string }> {
    const res = await uiRouter.fetch(
      new Request("https://test.local/user/settings/packages/chef/regenerate_keypair", {
        method: "POST",
        headers: { origin, cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, aliceId)}` },
      }),
      uiEnv,
    );
    return { res, body: new TextDecoder().decode(await res.arrayBuffer()) };
  }

  it("an anonymous POST 303s onto the login round-trip (the reqSignIn gate)", async () => {
    const res = await uiRouter.fetch(
      new Request("https://test.local/user/settings/packages/chef/regenerate_keypair", { method: "POST" }),
      uiEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login?");
    expect(await storedPublicPem()).toBeNull();
  });

  it("a cross-origin POST 403s with a valid cookie and writes nothing (the §2.8 guard)", async () => {
    const { res, body } = await postRegenerate("https://evil.example");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("cross-origin request rejected");
    expect(await storedPublicPem()).toBeNull();
    expect(await db().select().from(userSettingsKv).all()).toHaveLength(0);
  });

  it("the GET twin answers chi's 405 (upstream registers no GET)", async () => {
    const res = await uiRouter.fetch(
      new Request("https://test.local/user/settings/packages/chef/regenerate_keypair", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, aliceId)}` },
      }),
      uiEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await storedPublicPem()).toBeNull();
  });

  it("a signed-in POST streams the private key ONCE: the download headers, the stored NEW public, no private material anywhere else", async () => {
    const { res, body: privateBody } = await postRegenerate();
    expect(res.status).toBe(200);
    expect(privateBody).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/);
    expect(privateBody.endsWith("\n-----END RSA PRIVATE KEY-----\n")).toBe(true);
    // ctx.Doer.Name + ".priv" (setting/packages.go:117).
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename=${aliceName}.priv`);
    expect(res.headers.get("content-type")).toBe("application/x-pem-file");

    // The stored setting now parses as the NEW public PEM — and pairs with
    // the streamed private arm; the store itself carries no private bytes.
    const stored = await storedPublicPem();
    expect(stored).not.toBeNull();
    expect(stored!).not.toContain("PRIVATE KEY");
    const privateN = bytesToBigInt(derChildContent(pemDer(privateBody), 1));
    expect(privateN).toBe((await parseChefPublicKey(stored!)).modulus);

    // The reload shows no private material: the packages settings page
    // never carries the streamed bytes (load-bearing once the section
    // fold-back lands — the module header's posture).
    const page = await uiRouter.fetch(
      new Request("https://test.local/user/settings/packages", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, aliceId)}` },
      }),
      uiEnv,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("RSA PRIVATE KEY");
    expect(html).not.toContain(privateBody.slice(40, 80)); // no private-body fragment
  });

  it("a second POST rotates the live key: a fresh private body, the old public discarded", async () => {
    const first = await postRegenerate();
    const firstN = (await parseChefPublicKey((await storedPublicPem())!)).modulus;
    const second = await postRegenerate();
    expect(second.res.status).toBe(200);
    expect(second.body).not.toBe(first.body);
    const secondN = (await parseChefPublicKey((await storedPublicPem())!)).modulus;
    expect(secondN).not.toBe(firstN);
    // Exactly one setting row — the upsert.
    expect(await db().select().from(userSettingsKv).all()).toHaveLength(1);
  });
});

// --- the parse-tree claim arms -------------------------------------------------

describe("the parse-tree claim (user-settings-packages-chef-regenerate)", () => {
  it("claims the regenerate literal; the junk/deeper tails stay unclaimed → the engine's 404", () => {
    expect(parseUiRoute("/user/settings/packages/chef/regenerate_keypair")).toEqual({
      family: "user-settings-packages-chef-regenerate",
      id: null,
    });
    // The bare chef tail and the junk/deeper shapes stay unclaimed (the
    // settings block returns null — never the owner/repo parse).
    expect(parseUiRoute("/user/settings/packages/chef")).toBeNull();
    expect(parseUiRoute("/user/settings/packages/chef/regenerate_keypair/extra")).toBeNull();
    expect(parseUiRoute("/user/settings/packages/chef/junk")).toBeNull();
    // The neighbors' claims stand (the static-first ordering intact). The
    // cargo tail IS claimed now (the e4d7e49 substrate's fold — the mirror
    // arms ride pages/user-settings-packages-cargo.tsx).
    expect(parseUiRoute("/user/settings/packages")).toEqual({ family: "user-settings-packages", id: null });
    expect(parseUiRoute("/user/settings/packages/cargo/initialize")).toEqual({
      family: "user-settings-packages-cargo-initialize",
      id: null,
    });
  });
});
