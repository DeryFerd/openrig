import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { viewsRoutes } from "../src/routes/views.js";

const TOKEN = "test-terminal-bearer-token";

function createApp(bearerToken: string | null): Hono {
  const db = createDb();
  migrate(db, [
    coreSchema,
    bindingsSessionsSchema,
    eventsSchema,
    queueItemsSchema,
    viewsCustomSchema,
  ]);
  const projector = new ViewProjector(db, new EventBus(db));
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("viewProjector" as never, projector);
    c.set("eventBus" as never, new EventBus(db));
    await next();
  });
  app.route("/api/views", viewsRoutes({ bearerToken }));
  return app;
}

const REGISTER_BODY = {
  viewName: "operator-view",
  definition: "SELECT 1 AS one",
  registeredBySession: "lead@demo",
};

describe("views: the custom-view register route honours the configured bearer", () => {
  let app: Hono;

  beforeEach(() => {
    app = createApp(TOKEN);
  });

  afterEach(() => {
    app = undefined as unknown as Hono;
  });

  it("refuses a register with no Authorization header when a bearer is configured", async () => {
    const res = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a register whose bearer does not match", async () => {
    const res = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-token" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(res.status).toBe(401);
  });

  it("registers the view when the bearer matches", async () => {
    const res = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("still registers on a daemon that runs without a bearer", async () => {
    const open = createApp(null);
    const res = await open.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(REGISTER_BODY),
    });
    expect(res.status).toBe(201);
  });
});
