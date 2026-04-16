import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../env.js", () => ({
  getMemberId: () => "test-member-id",
  getLlmApiKey: () => "sk-test",
  getLlmBaseUrl: () => "https://api.openai.com",
  validateEnv: vi.fn(),
  getSidecarAdminToken: () => "admin-token",
  setLlmCredentials: vi.fn(),
}));

const { checkSidecarQuota, syncQuota, getQuotaStatus } = await import(
  "../services/quota.js"
);

describe("checkSidecarQuota", () => {
  beforeEach(async () => {
    // Reset store to a known state before each test
    await syncQuota({
      plan: "free_trial",
      dailyLimit: 8,
      sidecarDailyLimit: 8,
      trialExpiresAt: null,
    });
  });

  it("allows when quota available", async () => {
    const result = await checkSidecarQuota();

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(7);
    expect(result.plan).toBe("free_trial");
  });

  it("denies when sidecar quota exhausted", async () => {
    await syncQuota({
      plan: "free_trial",
      dailyLimit: 1,
      sidecarDailyLimit: 1,
      trialExpiresAt: null,
    });
    await checkSidecarQuota(); // uses the 1 allowed call

    const result = await checkSidecarQuota();

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("detects trial expiry", async () => {
    await syncQuota({
      plan: "free_trial",
      dailyLimit: 8,
      sidecarDailyLimit: 8,
      trialExpiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    });

    const result = await checkSidecarQuota();

    expect(result.allowed).toBe(false);
    expect(result.trialExpired).toBe(true);
  });

  it("allows unlimited for plus plan (limit -1)", async () => {
    await syncQuota({
      plan: "plus",
      dailyLimit: -1,
      sidecarDailyLimit: -1,
      trialExpiresAt: null,
    });

    const result = await checkSidecarQuota();

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(-1);
    expect(result.plan).toBe("plus");
  });

  it("does not apply trial expiry to non-free_trial plan", async () => {
    await syncQuota({
      plan: "plus",
      dailyLimit: -1,
      sidecarDailyLimit: -1,
      trialExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result = await checkSidecarQuota();

    expect(result.allowed).toBe(true);
    expect(result.trialExpired).toBeUndefined();
  });
});

describe("syncQuota", () => {
  it("stores plan and limit", async () => {
    await syncQuota({
      plan: "plus",
      dailyLimit: -1,
      sidecarDailyLimit: -1,
      trialExpiresAt: null,
    });

    const status = await getQuotaStatus();
    expect(status.plan).toBe("plus");
    expect(status.sidecarDailyLimit).toBe(-1);
    expect(status.trialExpiresAt).toBeNull();
  });

  it("stores trialExpiresAt when set", async () => {
    const expiry = "2025-12-31T00:00:00Z";
    await syncQuota({
      plan: "free_trial",
      dailyLimit: 8,
      sidecarDailyLimit: 8,
      trialExpiresAt: expiry,
    });

    const status = await getQuotaStatus();
    expect(status.trialExpiresAt).toBe(new Date(expiry).toISOString());
  });

  it("resets usage counter on re-sync", async () => {
    await syncQuota({
      plan: "free_trial",
      dailyLimit: 8,
      sidecarDailyLimit: 8,
      trialExpiresAt: null,
    });
    await checkSidecarQuota(); // used = 1

    // Re-sync (e.g. plan upgrade) — orchestrator is authoritative, resets counter
    await syncQuota({
      plan: "plus",
      dailyLimit: -1,
      sidecarDailyLimit: -1,
      trialExpiresAt: null,
    });

    const status = await getQuotaStatus();
    expect(status.plan).toBe("plus");
    expect(status.sidecarDailyUsed).toBe(0);
  });
});
