import type {
  QuotaCheckResult,
  MemberPlan,
  OrchestratorQuotaSyncRequest,
} from "../contracts.js";
import { getMemberId } from "../env.js";

// ---------------------------------------------------------------------------
// In-memory quota store (primary)
//
// Sidecar is a per-instance, single-member process — in-memory is safe.
// Orchestrator pushes authoritative quota via POST /admin/quota-sync on every
// completeProvision and syncQuotaChange, so the store is always hydrated after
// startup. SIDECAR_FALLBACK_DAILY_LIMIT (-1 = unlimited) covers the cold-start
// window before orchestrator syncs.
// ---------------------------------------------------------------------------

interface QuotaEntry {
  plan: MemberPlan;
  used: number;
  limit: number;
  trialExpiresAt: number; // ms epoch, 0 = no expiry
  resetAt: number;        // ms epoch
}

const store = new Map<string, QuotaEntry>();

function getOrInitEntry(memberId: string): QuotaEntry {
  let entry = store.get(memberId);
  if (!entry) {
    entry = {
      plan: "free_trial",
      used: 0,
      limit: Number(process.env.SIDECAR_FALLBACK_DAILY_LIMIT ?? "-1"),
      trialExpiresAt: 0,
      resetAt: Date.now() + 86_400_000,
    };
    store.set(memberId, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkSidecarQuota(): Promise<QuotaCheckResult> {
  const memberId = getMemberId();
  const now = Date.now();
  const entry = getOrInitEntry(memberId);

  // Daily reset
  if (entry.resetAt > 0 && now >= entry.resetAt) {
    entry.used = 0;
    entry.resetAt = now + 86_400_000;
  }

  // Trial expiry (free_trial only)
  if (entry.plan === "free_trial" && entry.trialExpiresAt > 0 && now >= entry.trialExpiresAt) {
    return {
      allowed: false,
      remaining: 0,
      plan: entry.plan,
      trialExpired: true,
      resetAt: new Date(entry.resetAt).toISOString(),
    };
  }

  // Daily limit (-1 = unlimited)
  if (entry.limit !== -1 && entry.used >= entry.limit) {
    return {
      allowed: false,
      remaining: 0,
      plan: entry.plan,
      resetAt: new Date(entry.resetAt).toISOString(),
    };
  }

  entry.used++;
  const remaining = entry.limit === -1 ? -1 : entry.limit - entry.used;
  return {
    allowed: true,
    remaining,
    plan: entry.plan,
    resetAt: new Date(entry.resetAt).toISOString(),
  };
}

export async function syncQuota(
  payload: OrchestratorQuotaSyncRequest,
): Promise<void> {
  const memberId = getMemberId();
  const existing = store.get(memberId);
  store.set(memberId, {
    plan: payload.plan,
    used: 0,
    limit: payload.sidecarDailyLimit,
    trialExpiresAt: payload.trialExpiresAt
      ? new Date(payload.trialExpiresAt).getTime()
      : 0,
    resetAt: existing?.resetAt ?? Date.now() + 86_400_000,
  });
}

export async function getQuotaStatus(): Promise<Record<string, unknown>> {
  const memberId = getMemberId();
  const entry = store.get(memberId);
  return {
    source: "memory",
    memberId,
    plan: entry?.plan ?? null,
    sidecarDailyUsed: entry?.used ?? 0,
    sidecarDailyLimit: entry?.limit ?? Number(process.env.SIDECAR_FALLBACK_DAILY_LIMIT ?? "-1"),
    trialExpiresAt: entry?.trialExpiresAt
      ? new Date(entry.trialExpiresAt).toISOString()
      : null,
    resetAt: entry?.resetAt ? new Date(entry.resetAt).toISOString() : null,
  };
}
