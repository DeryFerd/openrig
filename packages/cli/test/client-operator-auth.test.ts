import { describe, it, expect, afterEach } from "vitest";
import { DaemonClient, remoteDaemonClient } from "../src/client.js";

function mockFetch(box: { headers: Record<string, string> }): typeof fetch {
  return (async (_url: string | URL | RequestInfo, init?: RequestInit) => {
    box.headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

const savedToken = process.env.OPENRIG_AUTH_BEARER_TOKEN;

afterEach(() => {
  if (savedToken === undefined) delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
  else process.env.OPENRIG_AUTH_BEARER_TOKEN = savedToken;
});

describe("DaemonClient operator-bearer auto-attach", () => {
  it("presents OPENRIG_AUTH_BEARER_TOKEN as Authorization on requests without an explicit header", async () => {
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "op-token-1234567890";
    const box = { headers: {} as Record<string, string> };
    const client = new DaemonClient("http://localhost:7433", { fetchImpl: mockFetch(box) });
    await client.post("/api/queue", { title: "x" });
    expect(box.headers["Authorization"]).toBe("Bearer op-token-1234567890");
  });

  it("does NOT fabricate a header when the env is unset", async () => {
    delete process.env.OPENRIG_AUTH_BEARER_TOKEN;
    const box = { headers: {} as Record<string, string> };
    const client = new DaemonClient("http://localhost:7433", { fetchImpl: mockFetch(box) });
    await client.post("/api/queue", { title: "x" });
    expect(box.headers["Authorization"]).toBeUndefined();
  });

  it("a caller-supplied Authorization header wins over the env", async () => {
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "op-token-1234567890";
    const box = { headers: {} as Record<string, string> };
    const client = new DaemonClient("http://localhost:7433", { fetchImpl: mockFetch(box) });
    await client.post("/api/queue", { title: "x" }, { headers: { Authorization: "Bearer explicit" } });
    expect(box.headers["Authorization"]).toBe("Bearer explicit");
  });

  it("never sends the local operator token to a REMOTE daemon", async () => {
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "op-token-1234567890";
    const box = { headers: {} as Record<string, string> };
    const factory = (url: string) => new DaemonClient(url, { fetchImpl: mockFetch(box) });
    const client = remoteDaemonClient(factory, "http://vps-b:7433", "mm2-openrig1");
    await client.post("/api/queue", { title: "x" });
    expect(box.headers["Authorization"]).toBeUndefined();
  });

  it("does NOT send the token when a plainly-constructed client targets a non-local host", async () => {
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "op-token-1234567890";
    const box = { headers: {} as Record<string, string> };
    // OPENRIG_URL-style construction: the baseUrl can be anything; without the
    // remoteDaemonClient marker the client still must not leak this host's token.
    const client = new DaemonClient("http://vps-b.example.com:7433", { fetchImpl: mockFetch(box) });
    await client.post("/api/queue", { title: "x" });
    expect(box.headers["Authorization"]).toBeUndefined();
  });

  it("sends the token to loopback and tailscale-range local targets", async () => {
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "op-token-1234567890";
    for (const url of ["http://localhost:7433", "http://127.0.0.1:7433", "http://100.101.102.103:7433"]) {
      const box = { headers: {} as Record<string, string> };
      const client = new DaemonClient(url, { fetchImpl: mockFetch(box) });
      await client.post("/api/queue", { title: "x" });
      expect(box.headers["Authorization"], url).toBe("Bearer op-token-1234567890");
    }
  });

  it("detects an existing Authorization header case-insensitively before attaching", async () => {
    process.env.OPENRIG_AUTH_BEARER_TOKEN = "op-token-1234567890";
    for (const key of ["authorization", "AUTHORIZATION"]) {
      const box = { headers: {} as Record<string, string> };
      const client = new DaemonClient("http://localhost:7433", { fetchImpl: mockFetch(box) });
      await client.post("/api/queue", { title: "x" }, { headers: { [key]: "Bearer explicit" } });
      expect(Object.keys(box.headers).filter((k) => k.toLowerCase() === "authorization"), key).toHaveLength(1);
      expect(box.headers["Authorization"] ?? box.headers[key]).toBe("Bearer explicit");
    }
  });
});
