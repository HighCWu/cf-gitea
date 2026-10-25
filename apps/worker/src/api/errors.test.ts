/**
 * giteaErrorHandler shape tests — SPEC-0004 §2.5 error family.
 *
 * The untyped-throw fallback is the production finding ef2c049 seam: an
 * untyped Error (whose `.message` may itself be empty) must never reach the
 * wire — neither its text nor `{"message":""}` — only the constant
 * `internal server error` fallback. Typed error paths keep their messages.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiEnv } from "./env";
import { ApiError, giteaErrorHandler } from "./errors";

const SWAGGER_URL = "https://example.com/api/swagger";

const buildApp = (): Hono<ApiEnv> => {
  const app = new Hono<ApiEnv>();
  app.onError(giteaErrorHandler);
  app.get("/typed", () => {
    throw new ApiError(422, "user does not exist [uid: 0, name: nobody]");
  });
  app.get("/http-exception", () => {
    throw new HTTPException(415, { message: "unsupported media type" });
  });
  app.get("/untyped", () => {
    throw new Error("select * from tokens failed: connection reset");
  });
  app.get("/untyped-empty", () => {
    // The exact ef2c049 shape: a thrown Error with an empty message —
    // rendered as `{"message":""}` before the fallback existed.
    throw new Error();
  });
  return app;
};

const app = buildApp();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("giteaErrorHandler", () => {
  it("typed ApiError keeps its status and message", async () => {
    const res = await app.request("https://example.com/typed");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: "user does not exist [uid: 0, name: nobody]", url: SWAGGER_URL });
  });

  it("HTTPException keeps its status and message", async () => {
    const res = await app.request("https://example.com/http-exception");
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ message: "unsupported media type", url: SWAGGER_URL });
  });

  it("untyped throw → 500 with the constant fallback, never the error text", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("https://example.com/untyped");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "internal server error", url: SWAGGER_URL });
    // The real error goes to the logs, not the wire.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("/untyped");
  });

  it("untyped Error with an EMPTY message → the same fallback (ef2c049 reproduction)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("https://example.com/untyped-empty");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "internal server error", url: SWAGGER_URL });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
