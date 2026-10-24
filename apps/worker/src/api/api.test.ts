import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  createStubAuthResolver,
  extractTokenHeader,
  STUB_USER,
} from "./auth";
import { SERVER_VERSION } from "./config";
import type { ApiEnv } from "./env";
import { userSchema } from "./models/user";
import {
  DEFAULT_PAGING_NUM,
  MAX_RESPONSE_ITEMS,
  parseListOptions,
  setPaginationHeaders,
} from "./pagination";
import { createApiRouter } from "./router";

const router = createApiRouter();

describe("GET /api/v1/version", () => {
  it("returns the exact ServerVersion shape with the pinned upstream version", async () => {
    const res = await router.request("https://example.com/version");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ version: SERVER_VERSION });
  });
});

describe("GET /api/v1/user", () => {
  it("responds 401 with the Gitea error body without a token", async () => {
    const res = await router.request("https://example.com/user");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "token is required",
      url: "https://example.com/api/swagger",
    });
  });

  it("responds 401 for a foreign Authorization scheme (Basic)", async () => {
    const res = await router.request("https://example.com/user", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "token is required",
      url: "https://example.com/api/swagger",
    });
  });

  it("responds 200 with the full stub user for a token", async () => {
    const res = await router.request("https://example.com/user", {
      headers: { Authorization: "token stub-token" },
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    // Exactly the vendored contract's User fields, nothing more.
    expect(Object.keys(body).sort()).toEqual(Object.keys(userSchema.shape).sort());
    expect(body).toMatchObject({ id: STUB_USER.id, login: STUB_USER.login });
  });

  it("responds 401 for a token the resolver does not accept", async () => {
    const strict = createApiRouter({ auth: createStubAuthResolver(["secret-token"]) });
    const res = await strict.request("https://example.com/user", {
      headers: { Authorization: "token wrong-token" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "token is required",
      url: "https://example.com/api/swagger",
    });
  });
});

describe("extractTokenHeader", () => {
  it("extracts the token from `Authorization: token <x>`", () => {
    expect(extractTokenHeader("token abc")).toBe("abc");
    expect(extractTokenHeader("Token abc")).toBe("abc");
    expect(extractTokenHeader("token   spaced")).toBe("spaced");
  });

  it("rejects absent headers and foreign schemes", () => {
    expect(extractTokenHeader(undefined)).toBeNull();
    expect(extractTokenHeader("Bearer abc")).toBeNull();
    expect(extractTokenHeader("token")).toBeNull();
    expect(extractTokenHeader("")).toBeNull();
  });
});

describe("pagination clamping (upstream ToCorrectPageSize)", () => {
  it("keeps the upstream settings constants", () => {
    expect(DEFAULT_PAGING_NUM).toBe(30);
    expect(MAX_RESPONSE_ITEMS).toBe(50);
  });

  it.each([
    ["no params", "https://example.com/list", { page: 1, limit: 30 }],
    ["zero values", "https://example.com/list?page=0&limit=0", { page: 1, limit: 30 }],
    ["negative values", "https://example.com/list?page=-3&limit=-9", { page: 1, limit: 30 }],
    ["cap at 50", "https://example.com/list?page=2&limit=100", { page: 2, limit: 50 }],
    ["in range", "https://example.com/list?page=3&limit=10", { page: 3, limit: 10 }],
    ["garbage values", "https://example.com/list?page=abc&limit=xyz", { page: 1, limit: 30 }],
    ["non-integer page", "https://example.com/list?page=2.5&limit=7.5", { page: 1, limit: 30 }],
  ])("%s → %j", (_name, url, expected) => {
    expect(parseListOptions(new URL(url))).toEqual(expected);
  });
});

describe("setPaginationHeaders", () => {
  const fetchList = async (total: number, query: string): Promise<Response> => {
    const app = new Hono<ApiEnv>();
    app.get("/list", (c) => {
      setPaginationHeaders(c, total, parseListOptions(new URL(c.req.url)));
      return c.body(null);
    });
    return app.request(`https://example.com/list${query}`);
  };

  it("emits next+last on the first page with X-Total-Count", async () => {
    const res = await fetchList(75, "?page=1&limit=30");

    expect(res.headers.get("X-Total-Count")).toBe("75");
    expect(res.headers.get("Link")).toBe(
      '<https://example.com/list?page=2&limit=30>; rel="next",' +
        '<https://example.com/list?page=3&limit=30>; rel="last"',
    );
  });

  it("emits first+prev on later pages, preserving other params", async () => {
    const res = await fetchList(75, "?page=2&limit=30&sort=alpha");

    expect(res.headers.get("Link")).toBe(
      '<https://example.com/list?page=3&limit=30&sort=alpha>; rel="next",' +
        '<https://example.com/list?page=3&limit=30&sort=alpha>; rel="last",' +
        '<https://example.com/list?page=1&limit=30&sort=alpha>; rel="first",' +
        '<https://example.com/list?page=1&limit=30&sort=alpha>; rel="prev"',
    );
  });

  it("sends no Link header for a single page", async () => {
    const res = await fetchList(10, "?page=1&limit=30");

    expect(res.headers.get("X-Total-Count")).toBe("10");
    expect(res.headers.get("Link")).toBeNull();
  });

  it("sends no Link header for an empty list", async () => {
    const res = await fetchList(0, "");

    expect(res.headers.get("X-Total-Count")).toBe("0");
    expect(res.headers.get("Link")).toBeNull();
  });
});
