/**
 * Codex OAuth Forwarder — translates OpenAI Chat Completions requests into
 * Codex Responses API calls and streams the response back in Chat Completions
 * SSE format.
 *
 * This allows the proxy to enforce quota and maintain a single traffic path
 * regardless of whether the member uses an API key or Codex OAuth.
 *
 * Codex Responses API details (from pi-ai / OpenClaw integration):
 *   URL:     https://chatgpt.com/backend-api/codex/responses
 *   Auth:    Authorization: Bearer <access_token>
 *   Headers: chatgpt-account-id, originator, OpenAI-Beta, User-Agent
 *   Body:    Responses API format (input[], store: false)
 */

import { getCodexOAuthToken, getCodexAccountId } from "../env.js";

const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: unknown;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------

function buildCodexHeaders(
  accessToken: string,
  accountId: string,
): Headers {
  return new Headers({
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    // Whitelisted originator values: codex_cli_rs, codex_vscode, codex_sdk_ts,
    // or strings starting with "Codex"
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs (linux; x86_64)",
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  });
}

// ---------------------------------------------------------------------------
// Request translation: Chat Completions → Codex Responses
// ---------------------------------------------------------------------------

function transformRequestBody(
  chat: ChatCompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: chat.model,
    input: chat.messages,
    store: false,
    stream: chat.stream ?? true,
  };
  if (chat.temperature !== undefined) body.temperature = chat.temperature;
  if (chat.max_tokens !== undefined) body.max_output_tokens = chat.max_tokens;
  if (chat.top_p !== undefined) body.top_p = chat.top_p;
  return body;
}

// ---------------------------------------------------------------------------
// Non-streaming response translation: Codex Responses → Chat Completions
// ---------------------------------------------------------------------------

function extractTextFromOutput(output: unknown[]): string {
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output as Record<string, unknown>[]) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Record<string, unknown>[]) {
        if (part.type === "output_text" && typeof part.text === "string") {
          text += part.text;
        }
      }
    }
  }
  return text;
}

function transformNonStreamingResponse(
  codex: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const content = extractTextFromOutput(codex.output as unknown[]);
  const usage = codex.usage as Record<string, number> | undefined;
  return {
    id: `chatcmpl-${(codex.id as string) ?? "unknown"}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Streaming response translation: Codex Responses SSE → Chat Completions SSE
//
// Codex events we translate:
//   response.output_item.added  → initial chunk with role
//   response.output_text.delta  → content delta chunk
//   response.completed          → finish_reason: stop + [DONE]
// All other events are silently skipped.
// ---------------------------------------------------------------------------

function makeChatChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function createStreamTransformer(
  model: string,
  responseId: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentRole = false;
  let sentDone = false;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        // Skip event type lines and empty lines
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") {
          if (!sentDone) {
            sentDone = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const eventType = parsed.type as string | undefined;

        if (eventType === "response.output_item.added" && !sentRole) {
          sentRole = true;
          const chatChunk = makeChatChunk(
            responseId,
            model,
            { role: "assistant", content: "" },
            null,
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chatChunk)}\n\n`),
          );
          continue;
        }

        if (eventType === "response.output_text.delta") {
          const delta = (parsed.delta as string) ?? "";
          const chatChunk = makeChatChunk(
            responseId,
            model,
            { content: delta },
            null,
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chatChunk)}\n\n`),
          );
          continue;
        }

        if (eventType === "response.completed") {
          const usage = parsed.response
            ? ((parsed.response as Record<string, unknown>).usage as
                | Record<string, number>
                | undefined)
            : (parsed.usage as Record<string, number> | undefined);
          const chatChunk = makeChatChunk(
            responseId,
            model,
            {},
            "stop",
            usage
              ? {
                  prompt_tokens: usage.input_tokens ?? 0,
                  completion_tokens: usage.output_tokens ?? 0,
                  total_tokens: usage.total_tokens ?? 0,
                }
              : undefined,
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chatChunk)}\n\n`),
          );
          if (!sentDone) {
            sentDone = true;
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          continue;
        }

        // All other event types (response.created, response.content_part.added,
        // response.output_text.done, etc.) are skipped.
      }
    },

    flush(controller) {
      if (!sentDone) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Public entry point — called by proxy.ts when authMode === "codex_oauth"
// ---------------------------------------------------------------------------

export async function forwardToCodex(
  body: ReadableStream<Uint8Array> | null,
): Promise<Response> {
  const accessToken = getCodexOAuthToken();
  const accountId = getCodexAccountId();

  if (!accessToken) {
    return Response.json(
      {
        error: {
          message: "Codex OAuth not connected. Push tokens via /admin/activate-codex-oauth first.",
          type: "auth_error",
          code: "codex_oauth_not_connected",
        },
      },
      { status: 401 },
    );
  }

  if (!accountId) {
    return Response.json(
      {
        error: {
          message: "Codex account ID could not be extracted from access token",
          type: "auth_error",
          code: "codex_account_id_missing",
        },
      },
      { status: 401 },
    );
  }

  // Parse incoming Chat Completions body
  let chatBody: ChatCompletionRequest;
  try {
    const raw = body ? await new Response(body).text() : "{}";
    chatBody = JSON.parse(raw);
  } catch {
    return Response.json(
      {
        error: {
          message: "Invalid request body",
          type: "invalid_request_error",
          code: "invalid_body",
        },
      },
      { status: 400 },
    );
  }

  if (!chatBody.model || !chatBody.messages) {
    return Response.json(
      {
        error: {
          message: "model and messages are required",
          type: "invalid_request_error",
          code: "missing_fields",
        },
      },
      { status: 400 },
    );
  }

  const codexBody = transformRequestBody(chatBody);
  const headers = buildCodexHeaders(accessToken, accountId);
  const isStreaming = chatBody.stream !== false;

  try {
    const upstream = await fetch(CODEX_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(codexBody),
    });

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "");
      console.error(
        `[codex-forwarder] Codex API error: ${upstream.status} ${errorText}`,
      );
      return Response.json(
        {
          error: {
            message: `Codex API returned ${upstream.status}`,
            type: "upstream_error",
            code: "codex_api_error",
          },
        },
        { status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502 },
      );
    }

    if (isStreaming && upstream.body) {
      const responseId = crypto.randomUUID().slice(0, 12);
      const transformer = createStreamTransformer(chatBody.model, responseId);
      const transformedStream = upstream.body.pipeThrough(transformer);

      return new Response(transformedStream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // Non-streaming
    const codexResponse = (await upstream.json()) as Record<string, unknown>;
    const chatResponse = transformNonStreamingResponse(
      codexResponse,
      chatBody.model,
    );
    return Response.json(chatResponse);
  } catch (err) {
    console.error("[codex-forwarder] Upstream fetch error:", err);
    return Response.json(
      {
        error: {
          message: "Codex upstream unreachable",
          type: "upstream_error",
          code: "upstream_error",
        },
      },
      { status: 502 },
    );
  }
}
