import { Hono } from "hono";
import type { Context } from "hono";
import {
  getLlmApiKey,
  getLlmAuthMode,
  getLlmBaseUrl,
  getLlmProvider,
} from "../env.js";
import { checkSidecarQuota } from "../services/quota.js";
import { forwardToCodex } from "../services/codex-forwarder.js";

export const proxyRouter = new Hono();

// POST /v1/chat/completions — quota-gated
proxyRouter.post("/v1/chat/completions", async (c) => {
  const quota = await checkSidecarQuota();

  if (!quota.allowed) {
    const message = quota.trialExpired
      ? "Free trial has expired. Please upgrade your plan."
      : "Daily inference quota exceeded.";

    return c.json(
      {
        error: {
          message,
          type: "quota_exceeded",
          code: "quota_exceeded",
        },
        retry_after: quota.resetAt ?? null,
      },
      { status: 429, headers: { "x-should-retry": "false" } },
    );
  }

  return forwardToUpstream(c);
});

// All other /v1/* (models, embeddings, etc.) — pass-through, no quota
proxyRouter.all("/v1/*", (c) => forwardToUpstream(c));

// ---------------------------------------------------------------------------
// Upstream forwarder — routes to the correct backend based on auth mode.
//   platform    → injects API key, forwards to LLM_BASE_URL/v1/*
//   codex_oauth → translates to Codex Responses API, forwards to chatgpt.com
// ---------------------------------------------------------------------------

async function forwardToUpstream(c: Context): Promise<Response> {
  if (getLlmAuthMode() === "codex_oauth") {
    return forwardToCodex(c.req.raw.body);
  }

  const reqPath = c.req.path;
  const target = new URL(reqPath, getLlmBaseUrl());
  target.search = new URL(c.req.url).search;

  const headers = new Headers();
  for (const [k, v] of c.req.raw.headers.entries()) {
    const lower = k.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "authorization" ||
      lower === "x-api-key"
    )
      continue;
    headers.set(k, v);
  }

  const authToken = getLlmApiKey();
  const provider = getLlmProvider();
  if (provider === "anthropic") {
    headers.set("x-api-key", authToken);
  } else {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: c.req.method,
      headers,
      body:
        c.req.method === "GET" || c.req.method === "HEAD"
          ? undefined
          : c.req.raw.body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (err) {
    console.error("[sidecar] Upstream fetch error:", err);
    return c.json(
      {
        error: {
          message: "LLM upstream unreachable",
          type: "upstream_error",
          code: "upstream_error",
        },
      },
      502,
    );
  }
}
