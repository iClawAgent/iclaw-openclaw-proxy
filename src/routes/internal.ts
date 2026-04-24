import { Hono } from "hono";
import { setupBirdSkill, redactBirdSecrets, type BirdSetupResponse } from "../services/bird-skill.js";

export const internalRouter = new Hono();

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
