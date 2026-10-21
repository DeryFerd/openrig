import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { archiveIdentityProvenanceSchema } from "../src/db/migrations/082_archive_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { queueRoutes } from "../src/routes/queue.js";

/**
 * `POST /api/queue/:qitemId/fallback` re-routes a durable queue item to a
 * destination the caller names. Every other mutating route in this controller
 * calls `requireSenderIdentity` first, so the channel of record has an actor to
 * attribute the write to; the fallback route was the one that took the caller's
 * destination and reason with nothing to attribute them to.
 */
describe("queue: the fallback route needs an actor to attribute the reroute to", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      queueTransitionsArchiveSchema,
      watchdogJobsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      queueTargetRepoSchema,
      i3IdentityProvenanceSchema,
      archiveIdentityProvenanceSchema,
    ]);
    db.exec(`
      CREATE TABLE queue_transition_wakes (
        transition_id INTEGER PRIMARY KEY,
        qitem_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        wake_kind TEXT NOT NULL,
        wake_ref TEXT NOT NULL,
        delivery_status TEXT
      );
      CREATE INDEX idx_queue_transition_wakes_qitem ON queue_transition_wakes(qitem_id, transition_id);
      CREATE INDEX idx_queue_transition_wakes_ref ON queue_transition_wakes(wake_ref, phase);
    `);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    const inbox = new InboxHandler(db, bus, queueRepo);
    const outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("queueRepo" as never, queueRepo);
      c.set("inboxHandler" as never, inbox);
      c.set("outboxHandler" as never, outbox);
      await next();
    });
    app.route("/api/queue", queueRoutes());
  });

  afterEach(() => db.close());

  it("refuses a fallback with no transport identity and no actor in the body", async () => {
    const row = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });

    const res = await app.request(`/api/queue/${row.qitemId}/fallback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallbackDestination: "c@r", reason: "unreachable" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("actor_required");
  });

  it("refuses a fallback whose body names no actor either", async () => {
    const row = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });

    const res = await app.request(`/api/queue/${row.qitemId}/fallback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallbackDestination: "c@r" }),
    });
    expect(res.status).toBe(400);
  });

  it("reroutes the item when the transport identity names the actor", async () => {
    const row = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });

    const res = await app.request(`/api/queue/${row.qitemId}/fallback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ fallbackDestination: "c@r", reason: "unreachable" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { destinationSession: string }).destinationSession).toBe("c@r");
  });

  it("reroutes the item when the body names the actor", async () => {
    const row = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });

    const res = await app.request(`/api/queue/${row.qitemId}/fallback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallbackDestination: "c@r", reason: "unreachable", actor: "a@r" }),
    });
    expect(res.status).toBe(200);
  });
});
