import { describe, expect, it } from "vitest";
import {
  withCodexOAuthTransition,
  buildCodexOAuthAgentsDefaults,
  CODEX_OAUTH_DEFAULT_MODEL,
} from "../services/codex-oauth.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex OAuth canonical model config (OpenClaw 2026.6.x)", () => {
  it("CODEX_OAUTH_DEFAULT_MODEL is a canonical openai/* ref, not legacy openai-codex/*", () => {
    // Must stay in sync with @iclawagent/shared OPENCLAW_DEFAULTS.codexOAuthDefaultModel.
    expect(CODEX_OAUTH_DEFAULT_MODEL).toBe("openai/gpt-5.4");
    expect(CODEX_OAUTH_DEFAULT_MODEL).not.toContain("openai-codex/");
  });

  it("buildCodexOAuthAgentsDefaults binds the model to the native codex runtime", () => {
    const defaults = buildCodexOAuthAgentsDefaults();
    expect(defaults.model).toBe("openai/gpt-5.4");
    expect(defaults.models["openai/gpt-5.4"]).toEqual({
      agentRuntime: { id: "codex" },
    });
  });
});

describe("withCodexOAuthTransition", () => {
  it("serializes overlapping OAuth state transitions in request order", async () => {
    const events: string[] = [];

    const first = withCodexOAuthTransition(async () => {
      events.push("first:start");
      await delay(20);
      events.push("first:end");
      return "first";
    });

    const second = withCodexOAuthTransition(async () => {
      events.push("second:start");
      await delay(1);
      events.push("second:end");
      return "second";
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("continues processing after a failed transition", async () => {
    const events: string[] = [];

    await expect(
      withCodexOAuthTransition(async () => {
        events.push("fail:start");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      withCodexOAuthTransition(async () => {
        events.push("next:start");
        return "next";
      }),
    ).resolves.toBe("next");

    expect(events).toEqual(["fail:start", "next:start"]);
  });
});
