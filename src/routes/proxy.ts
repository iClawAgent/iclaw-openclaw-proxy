import { Hono } from "hono";
import type { Context } from "hono";
import {
  getLlmApiKey,
  getLlmBaseUrl,
  getLlmApiStyle,
} from "../env.js";
import { checkSidecarQuota } from "../services/quota.js";

export const proxyRouter = new Hono();

async function quotaGateAndForward(c: Parameters<typeof forwardToUpstream>[0]): Promise<Response> {
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
}

// POST /v1/chat/completions — quota-gated (OpenAI / OpenRouter / DeepSeek)
proxyRouter.post("/v1/chat/completions", (c) => quotaGateAndForward(c));

// POST /v1/messages — quota-gated (Anthropic native Messages API)
proxyRouter.post("/v1/messages", (c) => quotaGateAndForward(c));

// All other /v1/* (models, embeddings, etc.) — pass-through, no quota
proxyRouter.all("/v1/*", (c) => forwardToUpstream(c));

// ---------------------------------------------------------------------------
// Upstream forwarder — injects real LLM API key, streams response back.
// Only used for API Key mode. Codex OAuth uses OpenClaw native auth directly.
// ---------------------------------------------------------------------------

async function forwardToUpstream(c: Context): Promise<Response> {
  const reqPath = c.req.path;
  const baseUrl = getLlmBaseUrl();
  const apiStyle = getLlmApiStyle();

  // For google-generative-ai, OpenClaw emits paths under /v1/* but the native
  // Gemini base is /v1beta. Strip the /v1 prefix so /v1/models/… becomes
  // /v1beta/models/… when joined with the base URL path.
  let upstreamPath = reqPath;
  if (apiStyle === "google-generative-ai" && reqPath.startsWith("/v1/")) {
    upstreamPath = reqPath.slice("/v1".length); // "/models/…"
  }

  const baseParsed = new URL(baseUrl);
  const basePath = baseParsed.pathname.replace(/\/$/, "");
  baseParsed.pathname = basePath + upstreamPath;
  const target = baseParsed;
  target.search = new URL(c.req.url).search;

  const headers = new Headers();
  for (const [k, v] of c.req.raw.headers.entries()) {
    const lower = k.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "authorization" ||
      lower === "x-api-key" ||
      lower === "x-goog-api-key"
    )
      continue;
    headers.set(k, v);
  }

  const authToken = getLlmApiKey();
  if (apiStyle === "anthropic") {
    headers.set("x-api-key", authToken);
    headers.set("anthropic-version", "2023-06-01");
  } else if (apiStyle === "google-generative-ai") {
    headers.set("x-goog-api-key", authToken);
  } else {
    // "openai" style: OpenAI, OpenRouter, DeepSeek — all use Bearer auth
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
