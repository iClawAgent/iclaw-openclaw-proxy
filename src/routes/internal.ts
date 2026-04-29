import { Hono } from "hono";
import { setupBirdSkill, redactBirdSecrets, type BirdSetupResponse } from "../services/bird-skill.js";
import {
  setupGog,
  gogOauthStart,
  gogOauthComplete,
  gogDisconnect,
  type GogSetupRequest,
  type GogOauthCompleteRequest,
} from "../services/gog-skill.js";

export const internalRouter = new Hono();

// ─── Gog token-exchange helpers ───────────────────────────────────────────────

interface GogTokenBody {
  token: string;
  instanceId: string;
  tokenCallbackBaseUrl: string;
}

/**
 * Fetch the gog setup payload from portal-api using the one-time token.
 * Auth: Authorization: Bearer <SIDECAR_ADMIN_TOKEN>.
 * SSRF guard: tokenCallbackBaseUrl must match TOKEN_CALLBACK_BASE_URL env var.
 */
async function fetchGogPayload(body: GogTokenBody): Promise<{ payload: unknown } | null> {
  const expectedBase = process.env.TOKEN_CALLBACK_BASE_URL;
  if (!expectedBase || body.tokenCallbackBaseUrl !== expectedBase) return null;

  const sidecarAdminToken = process.env.SIDECAR_ADMIN_TOKEN ?? "";
  const url = `${body.tokenCallbackBaseUrl}/sidecar/skills/gog/setup-token/${encodeURIComponent(body.token)}?instanceId=${encodeURIComponent(body.instanceId)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${sidecarAdminToken}` },
  });
  if (!resp.ok) return null;
  return resp.json() as Promise<{ payload: unknown }>;
}

// POST /internal/skills/bird/setup-by-token
//
// No adminAuth middleware — self-authenticated via the one-time token exchange.
// The sidecar proves its identity by passing its own SIDECAR_ADMIN_TOKEN when
// calling back to portal-api, which validates it against the Redis-stored value.
//
// SSRF guard: TOKEN_CALLBACK_BASE_URL must be set (fail closed). Requests with a
// mismatched tokenCallbackBaseUrl are rejected unconditionally so the sidecar cannot
// be coerced into POSTing SIDECAR_ADMIN_TOKEN to an attacker-controlled host.

internalRouter.post("/internal/skills/bird/setup-by-token", async (c) => {
  const body = await c.req.json<{ token: string; instanceId: string; tokenCallbackBaseUrl: string }>();
  if (!body.token || !body.instanceId || !body.tokenCallbackBaseUrl) {
    return c.json({ error: "token, instanceId, and tokenCallbackBaseUrl are required" }, 400);
  }

  // Fail closed: TOKEN_CALLBACK_BASE_URL must be provisioned in the sidecar env.
  // Without it we cannot validate the callback URL and must refuse.
  const expectedBase = process.env.TOKEN_CALLBACK_BASE_URL;
  if (!expectedBase) {
    console.error("[sidecar] setup-by-token: TOKEN_CALLBACK_BASE_URL not configured (fail closed)");
    return c.json({ error: "token_callback_url_not_configured" }, 503);
  }
  if (body.tokenCallbackBaseUrl !== expectedBase) {
    console.error("[sidecar] setup-by-token: tokenCallbackBaseUrl mismatch (SSRF guard)");
    return c.json({ error: "invalid_token_callback_url" }, 403);
  }

  const sidecarAdminToken = process.env.SIDECAR_ADMIN_TOKEN ?? "";

  let authToken: string;
  let ct0: string;
  try {
    const url = `${body.tokenCallbackBaseUrl}/sidecar/skills/bird/setup-token/${encodeURIComponent(body.token)}?instanceId=${encodeURIComponent(body.instanceId)}`;
    const credResponse = await fetch(url, {
      headers: { "X-Sidecar-Admin-Token": sidecarAdminToken },
    });
    if (!credResponse.ok) {
      console.error("[sidecar] bird token exchange rejected:", credResponse.status);
      return c.json({ error: "token_exchange_failed" }, 401);
    }
    const creds = await credResponse.json() as { authToken: string; ct0: string };
    authToken = creds.authToken;
    ct0 = creds.ct0;
  } catch {
    return c.json({ error: "token_exchange_failed" }, 502);
  }

  try {
    const result = await setupBirdSkill({ slug: "bird", authMode: "cookies", authToken, ct0 });
    return c.json(redactBirdSecrets(result) as BirdSetupResponse);
  } catch {
    return c.json({ error: "bird_setup_failed" }, 502);
  }
});

// ─── POST /internal/skills/gog/setup-by-token ────────────────────────────────

internalRouter.post("/internal/skills/gog/setup-by-token", async (c) => {
  const body = await c.req.json<GogTokenBody>();
  if (!body.token || !body.instanceId || !body.tokenCallbackBaseUrl) {
    return c.json({ error: "token, instanceId, and tokenCallbackBaseUrl are required" }, 400);
  }
  if (!process.env.TOKEN_CALLBACK_BASE_URL) {
    console.error("[sidecar] gog setup-by-token: TOKEN_CALLBACK_BASE_URL not configured (fail closed)");
    return c.json({ error: "token_callback_url_not_configured" }, 503);
  }
  if (body.tokenCallbackBaseUrl !== process.env.TOKEN_CALLBACK_BASE_URL) {
    console.error("[sidecar] gog setup-by-token: tokenCallbackBaseUrl mismatch (SSRF guard)");
    return c.json({ error: "invalid_token_callback_url" }, 403);
  }
  let result;
  try {
    result = await fetchGogPayload(body);
  } catch {
    return c.json({ error: "token_exchange_failed" }, 502);
  }
  if (!result) return c.json({ error: "token_exchange_failed" }, 401);
  try {
    const res = await setupGog(result.payload as GogSetupRequest);
    return c.json(res);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_setup_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog setup-by-token failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── POST /internal/skills/gog/oauth-start-by-token ──────────────────────────

internalRouter.post("/internal/skills/gog/oauth-start-by-token", async (c) => {
  const body = await c.req.json<GogTokenBody>();
  if (!body.token || !body.instanceId || !body.tokenCallbackBaseUrl) {
    return c.json({ error: "token, instanceId, and tokenCallbackBaseUrl are required" }, 400);
  }
  if (!process.env.TOKEN_CALLBACK_BASE_URL) {
    return c.json({ error: "token_callback_url_not_configured" }, 503);
  }
  if (body.tokenCallbackBaseUrl !== process.env.TOKEN_CALLBACK_BASE_URL) {
    return c.json({ error: "invalid_token_callback_url" }, 403);
  }
  let result;
  try {
    result = await fetchGogPayload(body);
  } catch {
    return c.json({ error: "token_exchange_failed" }, 502);
  }
  if (!result) return c.json({ error: "token_exchange_failed" }, 401);
  const req = result.payload as { accountEmail: string };
  try {
    const res = await gogOauthStart(req.accountEmail);
    return c.json(res);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_oauth_start_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog oauth-start-by-token failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── POST /internal/skills/gog/oauth-complete-by-token ───────────────────────

internalRouter.post("/internal/skills/gog/oauth-complete-by-token", async (c) => {
  const body = await c.req.json<GogTokenBody>();
  if (!body.token || !body.instanceId || !body.tokenCallbackBaseUrl) {
    return c.json({ error: "token, instanceId, and tokenCallbackBaseUrl are required" }, 400);
  }
  if (!process.env.TOKEN_CALLBACK_BASE_URL) {
    return c.json({ error: "token_callback_url_not_configured" }, 503);
  }
  if (body.tokenCallbackBaseUrl !== process.env.TOKEN_CALLBACK_BASE_URL) {
    return c.json({ error: "invalid_token_callback_url" }, 403);
  }
  let result;
  try {
    result = await fetchGogPayload(body);
  } catch {
    return c.json({ error: "token_exchange_failed" }, 502);
  }
  if (!result) return c.json({ error: "token_exchange_failed" }, 401);
  try {
    const res = await gogOauthComplete(result.payload as GogOauthCompleteRequest);
    return c.json(res);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_oauth_complete_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog oauth-complete-by-token failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── POST /internal/skills/gog/disconnect-by-token ───────────────────────────

internalRouter.post("/internal/skills/gog/disconnect-by-token", async (c) => {
  const body = await c.req.json<GogTokenBody>();
  if (!body.token || !body.instanceId || !body.tokenCallbackBaseUrl) {
    return c.json({ error: "token, instanceId, and tokenCallbackBaseUrl are required" }, 400);
  }
  if (!process.env.TOKEN_CALLBACK_BASE_URL) {
    return c.json({ error: "token_callback_url_not_configured" }, 503);
  }
  if (body.tokenCallbackBaseUrl !== process.env.TOKEN_CALLBACK_BASE_URL) {
    return c.json({ error: "invalid_token_callback_url" }, 403);
  }
  let result;
  try {
    result = await fetchGogPayload(body);
  } catch {
    return c.json({ error: "token_exchange_failed" }, 502);
  }
  if (!result) return c.json({ error: "token_exchange_failed" }, 401);
  const req = result.payload as { accountEmail: string };
  try {
    const res = await gogDisconnect(req.accountEmail);
    return c.json(res);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_disconnect_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog disconnect-by-token failed:", code);
    return c.json({ error: code }, 502);
  }
});
