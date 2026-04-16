import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { adminAuth } from "../middleware/admin-auth.js";

const VALID_TOKEN = "correct-admin-token-1234567890";

function createApp() {
  const app = new Hono();
  app.use("/admin/*", adminAuth(VALID_TOKEN));
  app.get("/admin/status", (c) => c.json({ ok: true }));
  return app;
}

describe("sidecar adminAuth middleware", () => {
  const app = createApp();

  it("allows request with correct token", async () => {
    const res = await app.request("/admin/status", {
      headers: { "X-Admin-Token": VALID_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it("rejects request without token", async () => {
    const res = await app.request("/admin/status");
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong token", async () => {
    const res = await app.request("/admin/status", {
      headers: { "X-Admin-Token": "wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects request with empty token", async () => {
    const res = await app.request("/admin/status", {
      headers: { "X-Admin-Token": "" },
    });
    expect(res.status).toBe(401);
  });

  it("timing-safe: rejects token with same prefix but different length", async () => {
    const res = await app.request("/admin/status", {
      headers: { "X-Admin-Token": VALID_TOKEN.slice(0, -1) },
    });
    expect(res.status).toBe(401);
  });

  it("timing-safe: rejects token with one char diff", async () => {
    const wrongToken =
      VALID_TOKEN.slice(0, -1) +
      String.fromCharCode(VALID_TOKEN.charCodeAt(VALID_TOKEN.length - 1) ^ 1);
    const res = await app.request("/admin/status", {
      headers: { "X-Admin-Token": wrongToken },
    });
    expect(res.status).toBe(401);
  });
});
