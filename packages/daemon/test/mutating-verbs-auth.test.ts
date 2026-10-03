import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import {
  mutatingVerbsBearerMiddleware,
} from "../src/middleware/auth-bearer-token.js";

const OPERATOR_TOKEN = "operator-token-0123456789abcdef";
const TERMINAL_TOKEN = "terminal-token-0123456789abcdef";

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

function smallApp(opts: { expectedToken: string | null; additionalTokens?: Array<string | null | undefined> }): Hono {
  const app = new Hono();
  app.use("/api/*", mutatingVerbsBearerMiddleware(opts));
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/thing", (c) => c.json({ mutated: true }));
  app.on(["GET", "HEAD"], "/api/thing", (c) => c.json({ read: true }));
  return app;
}

describe("mutatingVerbsBearerMiddleware", () => {
  it("refuses a POST without a token when one is configured", async () => {
    const res = await smallApp({ expectedToken: OPERATOR_TOKEN }).request("/api/thing", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, string>;
    expect(body.error).toBe("unauthorized");
    expect(body.what_failed).toBeTruthy();
    expect(body.why_it_matters).toBeTruthy();
    expect(body.what_to_do).toContain("OPENRIG_AUTH_BEARER_TOKEN");
  });

  it("refuses a POST with the wrong token", async () => {
    const res = await smallApp({ expectedToken: OPERATOR_TOKEN })
      .request("/api/thing", { method: "POST", ...bearer("wrong") });
    expect(res.status).toBe(401);
  });

  it("lets a POST through with the configured operator token", async () => {
    const res = await smallApp({ expectedToken: OPERATOR_TOKEN })
      .request("/api/thing", { method: "POST", ...bearer(OPERATOR_TOKEN) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mutated: true });
  });

  it("lets a POST through with a configured additional (terminal) token", async () => {
    const res = await smallApp({ expectedToken: OPERATOR_TOKEN, additionalTokens: [TERMINAL_TOKEN] })
      .request("/api/thing", { method: "POST", ...bearer(TERMINAL_TOKEN) });
    expect(res.status).toBe(200);
  });

  it("keeps reads open while a token is configured", async () => {
    const app = smallApp({ expectedToken: OPERATOR_TOKEN });
    const get = await app.request("/api/thing");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ read: true });
    const head = await app.request("/api/thing", { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("passes everything through when no token is configured (loopback default)", async () => {
    const app = smallApp({ expectedToken: null });
    const post = await app.request("/api/thing", { method: "POST" });
    expect(post.status).toBe(200);
    const get = await app.request("/api/thing");
    expect(get.status).toBe(200);
  });

  it("covers every mutating verb", async () => {
    const app = smallApp({ expectedToken: OPERATOR_TOKEN });
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const res = await app.request("/api/thing", { method });
      expect(res.status, method).toBe(401);
    }
  });

  it("waives routes that run their own equivalent credential check", async () => {
    // /api/activity/hooks accepts the DEDICATED activity-hook token (possibly
    // in a non-Authorization header), so the operator-bearer floor must not
    // stand in front of it — the route's own check is the gate there.
    const app = new Hono();
    app.use("/api/*", mutatingVerbsBearerMiddleware({
      expectedToken: OPERATOR_TOKEN,
      exemptPaths: ["/api/activity/hooks"],
    }));
    app.post("/api/activity/hooks", (c) => {
      // the route's own check: hook token only
      if (c.req.header("x-openrig-activity-token") !== "hook-token") {
        return c.json({ ok: false, code: "activity_hook_unauthorized" }, 401);
      }
      return c.json({ ok: true });
    });
    const withHookToken = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "x-openrig-activity-token": "hook-token" },
    });
    expect(withHookToken.status).toBe(200);
    const withoutHookToken = await app.request("/api/activity/hooks", { method: "POST" });
    expect(withoutHookToken.status).toBe(401);
    expect(((await withoutHookToken.json()) as Record<string, unknown>).code).toBe("activity_hook_unauthorized");
  });

  it("keeps gating mutating routes that are NOT exempt", async () => {
    const app = new Hono();
    app.use("/api/*", mutatingVerbsBearerMiddleware({
      expectedToken: OPERATOR_TOKEN,
      exemptPaths: ["/api/activity/hooks"],
    }));
    app.post("/api/queue", (c) => c.json({ ok: true }));
    const res = await app.request("/api/queue", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("createApp mounts the mutating-verbs bearer gate", () => {
  let db: Database.Database;
  db = createFullTestDb();

  it("refuses an unauthenticated mutation on a previously ungated route", async () => {
    const { app } = createTestApp(db, {
      appDeps: { missionControlBearerToken: OPERATOR_TOKEN, terminalBearerToken: TERMINAL_TOKEN },
    });
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("accepts the terminal token on that route (web UI keeps working)", async () => {
    const { app } = createTestApp(db, {
      appDeps: { missionControlBearerToken: OPERATOR_TOKEN, terminalBearerToken: TERMINAL_TOKEN },
    });
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${TERMINAL_TOKEN}` },
      body: "{}",
    });
    expect(res.status).not.toBe(401);
  });

  it("keeps reads and the whole app open when no token is configured", async () => {
    const { app } = createTestApp(db);
    const post = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(post.status).not.toBe(401);
    const get = await app.request("/api/ps");
    expect(get.status).toBe(200);
  });

  it("leaves the deliberately-open pre-token bootstrap legs open even with a token configured", async () => {
    const { app } = createTestApp(db, {
      appDeps: { missionControlBearerToken: OPERATOR_TOKEN, terminalBearerToken: TERMINAL_TOKEN },
    });
    // hosts.ts: the target-side pair-request issuance legs are open so a
    // pairing client without any token can still mint a request.
    const res = await app.request("/api/hosts/pair-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status, "pair-request must not be refused by the bearer floor").not.toBe(401);
  });
});
