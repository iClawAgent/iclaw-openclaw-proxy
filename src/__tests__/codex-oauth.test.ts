import { describe, expect, it } from "vitest";
import { withCodexOAuthTransition } from "../services/codex-oauth.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
