import fs from "node:fs";
import path from "node:path";
import { setCodexOAuthAccessToken, setLlmAuthMode } from "../env.js";
import { STATE_DIR } from "../lib/state-dir.js";

const TOKEN_FILE = path.join(STATE_DIR, "codex-oauth.json");

// SQLite auth store path. Hardcodes agent id 'main' — the default for current
// OpenClaw images. Update if the agent layout changes.
const AGENT_SQLITE_PATH = path.join(
  STATE_DIR,
  "agents/main/agent/openclaw-agent.sqlite",
);

// OpenClaw 2026.6.x merged Codex OAuth into the canonical `openai` provider.
// The ChatGPT/Codex OAuth credential lives under the `openai:default` profile
// (legacy installs used `openai-codex:default`, migrated by `openclaw doctor`).
const CODEX_OAUTH_PROFILE_KEY = "openai:default";
const LEGACY_CODEX_PROFILE_PREFIX = "openai-codex:";

export interface CodexOAuthStatus {
  connected: boolean;
  authMode: string;
  expiresAt?: string;
}

interface PersistedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

let transitionQueue: Promise<void> = Promise.resolve();

export function withCodexOAuthTransition<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const run = transitionQueue.then(operation, operation);
  transitionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function persistTokens(tokens: PersistedTokens): void {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), "utf-8");
  } catch (err) {
    console.error("[codex-oauth] Failed to persist tokens:", err);
  }
}

export function loadPersistedTokens(): PersistedTokens | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
    const data = JSON.parse(raw) as PersistedTokens;
    if (!data.accessToken || !data.refreshToken) return null;
    // D1: return the persisted record even when expired. Token freshness is
    // OpenClaw's responsibility (sole refresher via SQLite auth_profile_store);
    // the sidecar token file is a liveness flag only. Returning null would
    // mis-report a healthy instance as disconnected after a restart.
    return data;
  } catch {
    return null;
  }
}

export function storeTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): void {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  setCodexOAuthAccessToken(accessToken);
  persistTokens({ accessToken, refreshToken, expiresAt });
  console.log(`[codex-oauth] Tokens stored, expires at ${expiresAt}`);
}

export function clearTokens(): void {
  setCodexOAuthAccessToken(null);
  setLlmAuthMode("platform");
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    console.error("[codex-oauth] Failed to delete token file:", err);
  }
  console.log("[codex-oauth] Tokens cleared");
}

// ---------------------------------------------------------------------------
// SQLite auth_profile_store management (OpenClaw 2026.6.x)
// ---------------------------------------------------------------------------

// auth_profile_store mirrors OpenClaw's SQLite schema (keep in sync with the
// running OpenClaw image — same manual discipline as buildCodexOAuthAgentsDefaults):
//   CREATE TABLE auth_profile_store (
//     store_key TEXT PRIMARY KEY,
//     store_json TEXT NOT NULL,
//     updated_at INTEGER NOT NULL
//   )
// Row store_key='primary' holds: { version: 1, profiles: Record<string, Credential> }
interface AuthProfileStore {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
}

/**
 * Low-level SQLite DB interface — injectable seam (mirrors gogBinaryInternals).
 * Only this primitive is replaced in tests; all schema/merge/retry logic lives
 * outside the seam so tests exercise the real SQL.
 */
export interface AuthStoreDb {
  exec(sql: string): void;
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
  run(sql: string, ...params: unknown[]): void;
  close(): void;
}

const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY_MAX_RETRIES = 3;
const SQLITE_BUSY_RETRY_DELAY_MS = 100;

// Inline type to avoid depending on @types/bun for the dynamic-import cast.
type BunSqliteModule = {
  Database: new (
    path: string,
    opts?: { create?: boolean; readonly?: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): void;
    };
    close(): void;
  };
};

// Dynamic import: package is ESM so top-level require() would throw
// "require is not defined". Top-level import("bun:sqlite") would break
// Vitest/Node at module load. Lazy dynamic import() is the safe choice.
// `import type { Database } from "bun:sqlite"` is NOT needed here because
// we cast the module result with BunSqliteModule above.
async function openAuthStoreDbImpl(dbPath: string): Promise<AuthStoreDb> {
  const { Database } = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new Database(dbPath, { create: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return {
    exec: (sql) => db.exec(sql),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    close: () => db.close(),
  };
}

/**
 * Injectable seam for the low-level SQLite open primitive.
 * Replace `codexAuthStoreInternals.openAuthStoreDb` in tests to inject a
 * node:sqlite or fake double without mocking the entire service module.
 * All schema/merge/retry logic lives OUTSIDE this seam.
 */
export const codexAuthStoreInternals: {
  openAuthStoreDb: (dbPath: string) => Promise<AuthStoreDb>;
} = {
  openAuthStoreDb: openAuthStoreDbImpl,
};

const CREATE_STORE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS auth_profile_store " +
  "(store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)";

const UPSERT_STORE_SQL =
  "INSERT INTO auth_profile_store (store_key, store_json, updated_at) " +
  "VALUES (?, ?, ?) ON CONFLICT(store_key) DO UPDATE SET " +
  "store_json=excluded.store_json, updated_at=excluded.updated_at";

function parseStoreJson(raw: unknown): AuthProfileStore {
  if (!raw || typeof raw !== "string") return { version: 1, profiles: {} };
  try {
    const parsed = JSON.parse(raw) as AuthProfileStore;
    if (parsed?.profiles && typeof parsed.profiles === "object") {
      return { version: parsed.version ?? 1, profiles: parsed.profiles };
    }
  } catch {}
  return { version: 1, profiles: {} };
}

async function withSqliteBusyRetry<T>(op: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < SQLITE_BUSY_MAX_RETRIES; attempt++) {
    try {
      return await op();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("SQLITE_BUSY") && attempt < SQLITE_BUSY_MAX_RETRIES - 1) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, SQLITE_BUSY_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function extractAccountIdFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString(),
    );
    const authClaim = payload["https://api.openai.com/auth"];
    return (
      authClaim?.chatgpt_account_id ??
      payload.account_id ??
      payload.sub ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * Upsert the openai:default OAuth credential into OpenClaw's SQLite
 * auth_profile_store (store_key='primary'). Preserves all sibling profiles.
 *
 * OQ#4 bare-upsert decision: writes ONLY auth_profile_store.store_json.
 * Does NOT touch auth_profile_state or write any order/promotion entry.
 * A lone openai:default is selected by OpenClaw without an order entry
 * (resolver falls back to all-provider-profiles — verified against OpenClaw
 * 2026.6.6_ver source: order.ts:294-299,318-319).
 *
 * Field names per OpenClaw docs: access, refresh, expires (ms epoch), accountId.
 */
export async function writeAuthProfiles(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  if (expiresIn <= 300) {
    console.warn(
      `[codex-oauth] Low expiresIn=${expiresIn}s — token may be single-use or ` +
        "near-expiry; refresh will trigger immediately on first use",
    );
  }
  const expires = Date.now() + expiresIn * 1000;
  const accountId = extractAccountIdFromJwt(accessToken);

  const credential: Record<string, unknown> = {
    provider: "openai",
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires,
    ...(accountId ? { accountId } : {}),
  };

  await withSqliteBusyRetry(async () => {
    const dir = path.dirname(AGENT_SQLITE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = await codexAuthStoreInternals.openAuthStoreDb(AGENT_SQLITE_PATH);
    try {
      db.exec(CREATE_STORE_TABLE_SQL);
      const row = db.get(
        "SELECT store_json FROM auth_profile_store WHERE store_key = ?",
        "primary",
      );
      const store = parseStoreJson(row?.store_json);
      // Overwrite-always (OQ#3): replace any stale openai:default credential.
      store.profiles[CODEX_OAUTH_PROFILE_KEY] = credential;
      db.run(UPSERT_STORE_SQL, "primary", JSON.stringify(store), Date.now());
    } finally {
      db.close();
    }
  });

  console.log(
    `[codex-oauth] Wrote SQLite auth_profile_store profile ${CODEX_OAUTH_PROFILE_KEY}`,
  );
}

/**
 * Remove the Codex OAuth profile from OpenClaw's SQLite auth_profile_store.
 * Clears openai:default (type=oauth) and legacy openai-codex:* profiles.
 * A BYOK api_key openai:default profile is preserved. Does NOT unlink or
 * DROP the DB. Does NOT touch auth_profile_state (OQ#4 bare-upsert only).
 */
export async function clearAuthProfiles(): Promise<void> {
  await withSqliteBusyRetry(async () => {
    if (!fs.existsSync(AGENT_SQLITE_PATH)) return;

    const db = await codexAuthStoreInternals.openAuthStoreDb(AGENT_SQLITE_PATH);
    try {
      db.exec(CREATE_STORE_TABLE_SQL);
      const row = db.get(
        "SELECT store_json FROM auth_profile_store WHERE store_key = ?",
        "primary",
      );
      if (!row) return;
      const store = parseStoreJson(row.store_json);
      let modified = false;
      for (const key of Object.keys(store.profiles)) {
        const isLegacyCodex = key.startsWith(LEGACY_CODEX_PROFILE_PREFIX);
        const isCanonicalOAuth =
          key === CODEX_OAUTH_PROFILE_KEY &&
          store.profiles[key]?.type === "oauth";
        if (isLegacyCodex || isCanonicalOAuth) {
          delete store.profiles[key];
          modified = true;
        }
      }
      if (modified) {
        db.run(UPSERT_STORE_SQL, "primary", JSON.stringify(store), Date.now());
      }
    } finally {
      db.close();
    }
  });

  console.log(
    "[codex-oauth] Cleared Codex OAuth profiles from SQLite auth_profile_store",
  );
}

// ---------------------------------------------------------------------------
// models.json + openclaw.json direct manipulation
// ---------------------------------------------------------------------------

// OpenClaw 2026.6.x retired the `openai-codex/*` namespace (legacy refs fail at
// runtime with "Unknown model"). Codex OAuth now uses a canonical
// `openai/<model>` ref. Keep in sync with @iclawagent/shared
// OPENCLAW_DEFAULTS.codexOAuthDefaultModel.
export const CODEX_OAUTH_DEFAULT_MODEL = "openai/gpt-5.4";

/**
 * Build the OpenClaw `agents.defaults` fragment for Codex OAuth.
 * Mirrors @iclawagent/shared `buildCodexOAuthAgentsDefaults` — the sidecar is an
 * isolated submodule and cannot import the shared package, so this is kept in
 * sync manually. The per-model `agentRuntime.id: "codex"` binding routes the
 * turn through OpenClaw's native Codex app-server harness.
 */
export function buildCodexOAuthAgentsDefaults(
  model: string = CODEX_OAUTH_DEFAULT_MODEL,
): { model: string; models: Record<string, { agentRuntime: { id: string } }> } {
  return {
    model,
    models: { [model]: { agentRuntime: { id: "codex" } } },
  };
}

// ---------------------------------------------------------------------------
// Extracted service functions — unit-testable without the Hono app (OQ#1)
// ---------------------------------------------------------------------------

type RelayConfigPatchFn = (patch: string) => Promise<unknown>;

/**
 * Activate Codex OAuth: write SQLite auth store -> config-patch -> flip auth mode.
 * Write-before-patch ordering (OQ#1): auth store is written before the patch so
 * a retryable state exists if the patch is interrupted.
 * On patch failure, rolls back the just-written openai:default OAuth row and
 * clears the liveness token — a failed activation MUST leave no live OAuth
 * credential (rollback deletes the row, not restores a prior value).
 */
export async function activateCodexOAuth(
  params: { accessToken: string; refreshToken: string; expiresIn: number },
  deps: { relayConfigPatch: RelayConfigPatchFn },
): Promise<{ ok: true } | { error: string }> {
  const { accessToken, refreshToken, expiresIn } = params;

  // 1. Persist liveness token and SQLite auth store BEFORE config patch.
  storeTokens(accessToken, refreshToken, expiresIn);
  await writeAuthProfiles(accessToken, refreshToken, expiresIn);

  // 2. Attempt gateway config patch.
  const modelPatch = JSON.stringify({
    agents: { defaults: buildCodexOAuthAgentsDefaults() },
  });
  try {
    await deps.relayConfigPatch(modelPatch);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "activate_patch_failed";
    console.error("[codex-oauth] Activation patch failed, rolling back:", message);
    // Rollback: remove the just-written openai:default row and clear liveness.
    try {
      await clearAuthProfiles();
    } catch (rbErr) {
      console.error("[codex-oauth] Rollback clearAuthProfiles failed:", rbErr);
    }
    clearTokens();
    return { error: message };
  }

  // 3. Patch succeeded — flip sidecar auth mode.
  setLlmAuthMode("codex_oauth");
  return { ok: true };
}

/**
 * Deactivate Codex OAuth: config-patch restore model -> clear auth store + liveness.
 * On patch failure, credentials are preserved so deactivation can be retried.
 * OQ#6 deploy-time check: confirm restoreModel is valid in the running OpenClaw
 * image before relying on deactivation in production (a bad model ref causes the
 * patch to 502 and leaves the OAuth credential live until the patch is retried).
 */
export async function deactivateCodexOAuth(
  params: { restoreModel?: string },
  deps: { relayConfigPatch: RelayConfigPatchFn },
): Promise<{ ok: true } | { error: string }> {
  // Default openai/gpt-4o must be confirmed valid in the running OpenClaw image
  // (see OQ#6). A bad ref causes this patch to 502.
  const restoreModel = params.restoreModel ?? "openai/gpt-4o";
  const modelPatch = JSON.stringify({
    agents: { defaults: { model: restoreModel } },
  });

  try {
    await deps.relayConfigPatch(modelPatch);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "deactivate_patch_failed";
    console.error("[codex-oauth] Deactivation patch failed:", message);
    return { error: message };
  }

  // clearTokens() resets llmAuthMode to "platform".
  await clearAuthProfiles();
  clearTokens();
  return { ok: true };
}
