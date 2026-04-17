import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — env module returns controllable token + accountId
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  codexToken: null as string | null,
  codexAccountId: null as string | null,
}));

vi.mock("../env.js", () => ({
  getCodexOAuthToken: () => mocks.codexToken,
  getCodexAccountId: () => mocks.codexAccountId,
}));

const { forwardToCodex, createStreamTransformer } = await import(
  "../services/codex-forwarder.js"
);

const originalFetch = globalThis.fetch;

describe("codex-forwarder", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mocks.codexToken = "ey.test.token";
    mocks.codexAccountId = "acct_abc123";
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it("returns 401 when codex token is missing", async () => {
    mocks.codexToken = null;
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ model: "gpt-5", messages: [] }),
          ),
        );
        ctrl.close();
      },
    });
    const res = await forwardToCodex(body);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("codex_oauth_not_connected");
  });

  it("returns 401 when account ID is missing", async () => {
    mocks.codexAccountId = null;
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ model: "gpt-5", messages: [] }),
          ),
        );
        ctrl.close();
      },
    });
    const res = await forwardToCodex(body);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("codex_account_id_missing");
  });

  // -------------------------------------------------------------------------
  // Request body validation
  // -------------------------------------------------------------------------

  it("returns 400 for missing model/messages", async () => {
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("{}"));
        ctrl.close();
      },
    });
    const res = await forwardToCodex(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("missing_fields");
  });

  it("returns 400 for unparseable body", async () => {
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("not-json"));
        ctrl.close();
      },
    });
    const res = await forwardToCodex(body);
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Request translation + upstream call
  // -------------------------------------------------------------------------

  it("translates Chat Completions body to Codex Responses format", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "resp_1", output: [], usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const chatBody = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      temperature: 0.7,
      max_tokens: 100,
    };

    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(JSON.stringify(chatBody)));
        ctrl.close();
      },
    });

    await forwardToCodex(body);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");

    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe("gpt-5");
    expect(sentBody.input).toEqual([{ role: "user", content: "hello" }]);
    expect(sentBody.store).toBe(false);
    expect(sentBody.stream).toBe(false);
    expect(sentBody.temperature).toBe(0.7);
    expect(sentBody.max_output_tokens).toBe(100);
    // messages → input, max_tokens → max_output_tokens
    expect(sentBody.messages).toBeUndefined();
    expect(sentBody.max_tokens).toBeUndefined();
  });

  it("sets correct Codex OAuth headers", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "resp_1", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              model: "gpt-5",
              messages: [{ role: "user", content: "hi" }],
              stream: false,
            }),
          ),
        );
        ctrl.close();
      },
    });

    await forwardToCodex(body);

    const [, init] = mockFetch.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer ey.test.token");
    expect(headers.get("chatgpt-account-id")).toBe("acct_abc123");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("OpenAI-Beta")).toBe("responses=experimental");
  });

  // -------------------------------------------------------------------------
  // Non-streaming response translation
  // -------------------------------------------------------------------------

  it("translates non-streaming Codex response to Chat Completions format", async () => {
    const codexResponse = {
      id: "resp_abc",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello world" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };

    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(codexResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              model: "gpt-5",
              messages: [{ role: "user", content: "hi" }],
              stream: false,
            }),
          ),
        );
        ctrl.close();
      },
    });

    const res = await forwardToCodex(body);
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.object).toBe("chat.completion");
    expect(json.id).toBe("chatcmpl-resp_abc");
    expect(json.model).toBe("gpt-5");

    const choices = json.choices as { message: { role: string; content: string } }[];
    expect(choices[0].message.role).toBe("assistant");
    expect(choices[0].message.content).toBe("Hello world");

    const usage = json.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Upstream error forwarding
  // -------------------------------------------------------------------------

  it("forwards upstream error status codes", async () => {
    mockFetch.mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );

    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              model: "gpt-5",
              messages: [{ role: "user", content: "hi" }],
            }),
          ),
        );
        ctrl.close();
      },
    });

    const res = await forwardToCodex(body);
    expect(res.status).toBe(429);
  });

  it("returns 502 when upstream fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              model: "gpt-5",
              messages: [{ role: "user", content: "hi" }],
            }),
          ),
        );
        ctrl.close();
      },
    });

    const res = await forwardToCodex(body);
    expect(res.status).toBe(502);
  });

  // -------------------------------------------------------------------------
  // Streaming response translation
  // -------------------------------------------------------------------------

  describe("createStreamTransformer", () => {
    it("translates Codex SSE events to Chat Completions chunks", async () => {
      const codexEvents = [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}\n\n',
      ].join("");

      const encoder = new TextEncoder();
      const inputStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(codexEvents));
          ctrl.close();
        },
      });

      const transformer = createStreamTransformer("gpt-5", "test123");
      const outputStream = inputStream.pipeThrough(transformer);
      const reader = outputStream.getReader();
      const decoder = new TextDecoder();
      let output = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }

      const lines = output
        .split("\n\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // Should have: role chunk, 2 delta chunks, stop chunk
      expect(lines.length).toBe(4);

      const roleChunk = JSON.parse(lines[0].slice(6));
      expect(roleChunk.choices[0].delta.role).toBe("assistant");

      const delta1 = JSON.parse(lines[1].slice(6));
      expect(delta1.choices[0].delta.content).toBe("Hello");

      const delta2 = JSON.parse(lines[2].slice(6));
      expect(delta2.choices[0].delta.content).toBe(" world");

      const stopChunk = JSON.parse(lines[3].slice(6));
      expect(stopChunk.choices[0].finish_reason).toBe("stop");
      expect(stopChunk.usage.prompt_tokens).toBe(5);
      expect(stopChunk.usage.completion_tokens).toBe(2);

      // Should end with [DONE]
      expect(output).toContain("data: [DONE]");
    });

    it("skips unrecognised event types", async () => {
      const codexEvents = [
        'event: response.created\ndata: {"type":"response.created","id":"resp_x"}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      ].join("");

      const encoder = new TextEncoder();
      const inputStream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(encoder.encode(codexEvents));
          ctrl.close();
        },
      });

      const transformer = createStreamTransformer("gpt-5", "test456");
      const outputStream = inputStream.pipeThrough(transformer);
      const reader = outputStream.getReader();
      const decoder = new TextDecoder();
      let output = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }

      const dataLines = output
        .split("\n\n")
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // Only the delta event should produce output (no role chunk since
      // response.output_item.added was not sent)
      expect(dataLines.length).toBe(1);
      const chunk = JSON.parse(dataLines[0].slice(6));
      expect(chunk.choices[0].delta.content).toBe("ok");
    });
  });

  // -------------------------------------------------------------------------
  // Streaming end-to-end via forwardToCodex
  // -------------------------------------------------------------------------

  it("returns SSE stream for streaming requests", async () => {
    const codexEvents =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added"}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed"}\n\n';

    mockFetch.mockResolvedValue(
      new Response(codexEvents, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              model: "gpt-5",
              messages: [{ role: "user", content: "hi" }],
              stream: true,
            }),
          ),
        );
        ctrl.close();
      },
    });

    const res = await forwardToCodex(body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain("data: [DONE]");
  });
});
