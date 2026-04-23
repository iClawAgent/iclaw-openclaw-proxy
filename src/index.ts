import { Hono } from "hono";
import { logger } from "hono/logger";
import { validateEnv, getSidecarAdminToken } from "./env.js";
import { adminAuth } from "./middleware/admin-auth.js";
import { proxyRouter } from "./routes/proxy.js";
import { adminRouter } from "./routes/admin.js";
import { internalRouter } from "./routes/internal.js";

validateEnv();

const app = new Hono();
app.use("*", logger());

// Health — open (health checks + Orchestrator)
app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Admin API — protected by X-Admin-Token (Orchestrator via IPv6)
app.use("/admin/*", adminAuth(getSidecarAdminToken()));
app.route("/", adminRouter);

// Internal API — no adminAuth; self-authenticated via token exchange
app.route("/", internalRouter);

// LLM Reverse Proxy — /v1/* (OpenClaw process on same machine)
app.route("/", proxyRouter);

// Webhook relay — IPv6-to-IPv4 bridge for Telegram webhook traffic.
// The OpenClaw gateway webhook listener binds only to IPv4 (0.0.0.0:8787)
// while IPv6 is used. The sidecar (dual-stack via Bun) relays here.
app.all("*", async (c) => {
  const gatewayUrl = `http://127.0.0.1:${Number(process.env.OPENCLAW_WEBHOOK_PORT ?? "8787")}${c.req.path}`;
  try {
    const res = await fetch(gatewayUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (err) {
    console.error("[sidecar] Webhook relay failed:", err);
    return c.json({ error: "gateway_unreachable" }, 502);
  }
});

app.onError((err, c) => {
  console.error("[sidecar] Unhandled error:", err);
  return c.json({ error: "internal_server_error" }, 500);
});

const port = Number(process.env.PORT ?? "8080");
console.log(`[sidecar] Inference Proxy starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
