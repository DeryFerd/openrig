import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const TOKEN = "test-terminal-bearer-token";

/**
 * The node lifecycle routes in `routes/sessions.ts` share one controller with the
 * session-admin routes, and that controller already guards its read and terminal
 * control verbs with `terminalAuthGuard()`. The four state-mutating verbs below
 * were the ones it left open, so a caller that could not present the configured
 * bearer could still launch a seat, take its pane focus, or delete it.
 */
describe("sessions: the node lifecycle routes honour the configured bearer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function protectedApp() {
    return createTestApp(db, { appDeps: { terminalBearerToken: TOKEN } });
  }

  it("refuses a seat launch with no Authorization header when a bearer is configured", async () => {
    const { app, rigRepo } = protectedApp();
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses a seat launch whose bearer does not match", async () => {
    const { app, rigRepo } = protectedApp();
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, {
      method: "POST",
      headers: { Authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  it("launches the seat when the bearer matches", async () => {
    const { app, rigRepo } = protectedApp();
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(201);
  });

  it("refuses a subset launch with no Authorization header", async () => {
    const { app, rigRepo } = protectedApp();
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: ["dev1-impl"] }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a pane focus with no Authorization header", async () => {
    const { app, rigRepo } = protectedApp();
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses a node delete with no Authorization header", async () => {
    const { app, rigRepo } = protectedApp();
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("still launches the seat on a daemon that runs without a bearer", async () => {
    const { app, rigRepo } = createTestApp(db, { appDeps: { terminalBearerToken: null } });
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, { method: "POST" });
    expect(res.status).toBe(201);
  });
});
