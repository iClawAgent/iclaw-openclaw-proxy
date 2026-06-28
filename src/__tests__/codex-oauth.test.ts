import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  withCodexOAuthTransition,
  buildCodexOAuthAgentsDefaults,
  CODEX_OAUTH_DEFAULT_MODEL,
} from "../services/codex-oauth.js";
import type { AuthStoreDb } from "../services/codex-oauth.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// node:sqlite test double helpers
// ---------------------------------------------------------------------------

interface NodeSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): void;
}

interface RawNodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => RawNodeSqliteDb;
};

/** Open a node:sqlite connection at dbPath and wrap it as AuthStoreDb. */
async function openNodeSqliteAuthStoreDb(dbPath: string): Promise<{ raw: RawNodeSqliteDb; db: AuthStoreDb }> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const raw = new mod.DatabaseSync(dbPath);
  const db: AuthStoreDb = {
    exec: (sql) => raw.exec(sql),
    get: (sql, ...params) => raw.prepare(sql).get(...params),
    run: (sql, ...params) => { raw.prepare(sql).run(...params); },
    close: () => raw.close(),
  };
  return { raw, db };
}

/**
 * Open a fresh read-only node:sqlite connection to inspect the DB state.
 * Returns the parsed auth_profile_store 'primary' row, or null if absent.
 */
async function queryAuthStore(dbPath: string): Promise<{ version: number; profiles: Record<string, unknown> } | null> {
  if (!fs.existsSync(dbPath)) return null;
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const raw = new mod.DatabaseSync(dbPath);
  try {
    raw.exec(
      "CREATE TABLE IF NOT EXISTS auth_profile_store " +
        "(store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    const row = raw.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary");
    if (!row) return null;
    return JSON.parse((row as { store_json: string }).store_json) as { version: number; profiles: Record<string, unknown> };
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// Existing: Codex OAuth canonical model config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Existing: no-refresh regression
// ---------------------------------------------------------------------------

describe("codex-oauth no-refresh regression", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    // Stub env to avoid real disk state-dir at module load.
    // Also mock state-dir so re-imported modules resolve to the test tmpdir
    // regardless of whether the path starts with '/' (Windows compatibility).
    vi.doMock("../env.js", () => ({
      setCodexOAuthAccessToken: vi.fn(),
      setLlmAuthMode: vi.fn(),
    }));
    vi.doMock("../lib/state-dir.js", () => ({ STATE_DIR: stateDir }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.useRealTimers(); // safety net: prevent fake-timer leak if a test throws
    vi.restoreAllMocks();
  });

  it("storeTokens persists codex-oauth.json and sets in-memory token but never calls fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers();

    const { storeTokens } = await import("../services/codex-oauth.js");
    storeTokens("access-abc", "refresh-xyz", 3600);

    // Advance time well past any expiry to prove no timer fires
    await vi.advanceTimersByTimeAsync(7_200_000);

    const tokenFile = path.join(stateDir, "codex-oauth.json");
    expect(fs.existsSync(tokenFile)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(tokenFile, "utf-8"));
    expect(stored.accessToken).toBe("access-abc");
    expect(stored.refreshToken).toBe("refresh-xyz");

    const oauthCalls = fetchSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);

    vi.useRealTimers();
  });

  it("loadPersistedTokens returns the record for a valid token without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tokenFile = path.join(stateDir, "codex-oauth.json");
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ accessToken: "acc", refreshToken: "ref", expiresAt }),
      "utf-8",
    );

    const { loadPersistedTokens } = await import("../services/codex-oauth.js");
    const result = loadPersistedTokens();

    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("acc");
    expect(result?.refreshToken).toBe("ref");

    const oauthCalls = fetchSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);
  });

  it("loadPersistedTokens (D1) returns the record even when the token is expired", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tokenFile = path.join(stateDir, "codex-oauth.json");
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
    fs.writeFileSync(
      tokenFile,
      JSON.stringify({ accessToken: "acc-exp", refreshToken: "ref-exp", expiresAt }),
      "utf-8",
    );

    const { loadPersistedTokens } = await import("../services/codex-oauth.js");
    const result = loadPersistedTokens();

    // D1: must return the record, not null
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe("acc-exp");

    const oauthCalls = fetchSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);
  });

  it("clearTokens resets llmAuthMode to platform and removes the token file", async () => {
    const { setLlmAuthMode } = await import("../env.js");
    const tokenFile = path.join(stateDir, "codex-oauth.json");
    fs.writeFileSync(tokenFile, JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: "2099-01-01T00:00:00.000Z" }), "utf-8");

    const { clearTokens } = await import("../services/codex-oauth.js");
    clearTokens();

    expect(setLlmAuthMode).toHaveBeenCalledWith("platform");
    expect(fs.existsSync(tokenFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing: withCodexOAuthTransition serialization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// New: SQLite auth_profile_store — writeAuthProfiles
// ---------------------------------------------------------------------------

describe("SQLite auth_profile_store — writeAuthProfiles", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-write-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.doMock("../env.js", () => ({
      setCodexOAuthAccessToken: vi.fn(),
      setLlmAuthMode: vi.fn(),
    }));
    vi.doMock("../lib/state-dir.js", () => ({ STATE_DIR: stateDir }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("upserts openai:default with version:1 and flat camelCase OAuth fields", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    const before = Date.now();
    await writeAuthProfiles("access-token-1", "refresh-token-1", 3600);

    const store = await queryAuthStore(sqlitePath);
    expect(store).not.toBeNull();
    expect(store!.version).toBe(1);
    const profile = store!.profiles["openai:default"] as Record<string, unknown>;
    expect(profile.type).toBe("oauth");
    expect(profile.access).toBe("access-token-1");
    expect(profile.refresh).toBe("refresh-token-1");
    expect(typeof profile.expires).toBe("number");
    expect(profile.expires as number).toBeGreaterThanOrEqual(before + 3600_000);
  });

  it("preserves sibling profiles when upserting openai:default", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");

    // Seed a sibling profile directly
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { raw: seedRaw } = await openNodeSqliteAuthStoreDb(sqlitePath);
    seedRaw.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const siblingStore = JSON.stringify({ version: 1, profiles: { "anthropic:default": { type: "api_key", key: "ant-key" } } });
    seedRaw.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", siblingStore, Date.now());
    seedRaw.close();

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    await writeAuthProfiles("access-2", "refresh-2", 7200);

    const store = await queryAuthStore(sqlitePath);
    expect(store!.profiles["openai:default"]).toBeDefined();
    expect((store!.profiles["openai:default"] as Record<string, unknown>).type).toBe("oauth");
    // Sibling preserved
    expect(store!.profiles["anthropic:default"]).toBeDefined();
    expect((store!.profiles["anthropic:default"] as Record<string, unknown>).key).toBe("ant-key");
  });

  it("overwrites a stale openai:default credential (OQ#3 overwrite-always)", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");

    // Seed stale credential
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { raw: seedRaw } = await openNodeSqliteAuthStoreDb(sqlitePath);
    seedRaw.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const stale = JSON.stringify({ version: 1, profiles: { "openai:default": { type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 1 } } });
    seedRaw.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", stale, Date.now());
    seedRaw.close();

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    await writeAuthProfiles("fresh-access", "fresh-refresh", 3600);

    const store = await queryAuthStore(sqlitePath);
    const profile = store!.profiles["openai:default"] as Record<string, unknown>;
    expect(profile.access).toBe("fresh-access");
    expect(profile.refresh).toBe("fresh-refresh");
  });

  it("logs a warning when expiresIn is <= 300 (sub-5-min headroom)", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await writeAuthProfiles("acc", "ref", 60);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Low expiresIn=60s"));
  });

  it("auto-creates the table when the DB is absent (no pre-existing file)", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    // No pre-creation of directory or DB file
    await writeAuthProfiles("acc", "ref", 3600);

    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    expect(store).not.toBeNull();
    expect(store!.profiles["openai:default"]).toBeDefined();
  });

  it("activation never calls auth.openai.com (no autonomous refresh)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    await writeAuthProfiles("acc", "ref", 3600);

    const oauthCalls = fetchSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("auth.openai.com"),
    );
    expect(oauthCalls).toHaveLength(0);
  });

  it("SQLITE_BUSY triggers retry without crashing", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    let openCount = 0;
    codexAuthStoreInternals.openAuthStoreDb = async (dbPath) => {
      openCount++;
      const raw = new mod.DatabaseSync(dbPath);
      const isBusy = openCount === 1;
      return {
        exec: (sql) => raw.exec(sql),
        get: (sql, ...params) => raw.prepare(sql).get(...params),
        run: (sql, ...params) => {
          if (isBusy) {
            raw.close();
            throw new Error("SQLITE_BUSY: database is locked");
          }
          raw.prepare(sql).run(...params);
        },
        close: () => { try { raw.close(); } catch {} },
      };
    };

    await writeAuthProfiles("access-retry", "refresh-retry", 3600);

    expect(openCount).toBe(2); // retry happened
    const store = await queryAuthStore(sqlitePath);
    expect(store!.profiles["openai:default"]).toBeDefined();
    expect((store!.profiles["openai:default"] as Record<string, unknown>).access).toBe("access-retry");
  });

  it("OQ#4 bare-upsert safety net: auth_profile_state is untouched", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    // Seed both tables in the DB before calling writeAuthProfiles
    const { raw: seedRaw } = await openNodeSqliteAuthStoreDb(sqlitePath);
    seedRaw.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    seedRaw.exec("CREATE TABLE IF NOT EXISTS auth_profile_state (store_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const initialStore = JSON.stringify({
      version: 1,
      profiles: {
        "openai:default": { type: "oauth", access: "old", refresh: "old", expires: 1 },
        "openai:other": { type: "api_key", key: "other-key" },
      },
    });
    seedRaw.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", initialStore, 0);
    const stateJson = JSON.stringify({ version: 1, order: { openai: ["openai:default"] } });
    seedRaw.prepare("INSERT INTO auth_profile_state VALUES (?, ?, ?)").run("primary", stateJson, 0);
    seedRaw.close();

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    await writeAuthProfiles("new-access", "new-refresh", 3600);

    // auth_profile_store updated
    const store = await queryAuthStore(sqlitePath);
    expect((store!.profiles["openai:default"] as Record<string, unknown>).access).toBe("new-access");
    // sibling preserved
    expect(store!.profiles["openai:other"]).toBeDefined();

    // auth_profile_state NOT touched — same row, same state_json
    const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
    const assertRaw = new mod.DatabaseSync(sqlitePath);
    const stateRow = assertRaw
      .prepare("SELECT state_json FROM auth_profile_state WHERE store_key = ?")
      .get("primary");
    assertRaw.close();
    expect(stateRow).toBeDefined();
    expect((stateRow as { state_json: string }).state_json).toBe(stateJson);
  });
});

// ---------------------------------------------------------------------------
// New: SQLite auth_profile_store — clearAuthProfiles
// ---------------------------------------------------------------------------

describe("SQLite auth_profile_store — clearAuthProfiles", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-store-clear-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.doMock("../env.js", () => ({
      setCodexOAuthAccessToken: vi.fn(),
      setLlmAuthMode: vi.fn(),
    }));
    vi.doMock("../lib/state-dir.js", () => ({ STATE_DIR: stateDir }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function seedStore(sqlitePath: string, profiles: Record<string, unknown>): Promise<void> {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { raw } = await openNodeSqliteAuthStoreDb(sqlitePath);
    raw.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    raw.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run(
      "primary",
      JSON.stringify({ version: 1, profiles }),
      Date.now(),
    );
    raw.close();
  }

  it("removes OAuth openai:default and legacy openai-codex:* profiles", async () => {
    const { clearAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    await seedStore(sqlitePath, {
      "openai:default": { type: "oauth", access: "a", refresh: "r", expires: 1 },
      "openai-codex:default": { type: "oauth", access: "b", refresh: "s", expires: 2 },
      "anthropic:default": { type: "api_key", key: "ant" },
    });

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    await clearAuthProfiles();

    const store = await queryAuthStore(sqlitePath);
    expect(store!.profiles["openai:default"]).toBeUndefined();
    expect(store!.profiles["openai-codex:default"]).toBeUndefined();
    // Unrelated profile preserved
    expect(store!.profiles["anthropic:default"]).toBeDefined();
  });

  it("preserves a BYOK api_key openai:default profile", async () => {
    const { clearAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    await seedStore(sqlitePath, {
      "openai:default": { type: "api_key", key: "byok-key" },
    });

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    await clearAuthProfiles();

    const store = await queryAuthStore(sqlitePath);
    // BYOK profile survives — only OAuth type is cleared
    expect(store!.profiles["openai:default"]).toBeDefined();
    expect((store!.profiles["openai:default"] as Record<string, unknown>).type).toBe("api_key");
  });

  it("does NOT delete the DB file when store_json is corrupt", async () => {
    const { clearAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    // Seed corrupt JSON row
    const { raw } = await openNodeSqliteAuthStoreDb(sqlitePath);
    raw.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    raw.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", "CORRUPT_JSON", Date.now());
    raw.close();

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    await clearAuthProfiles();

    // DB file must still exist (not deleted)
    expect(fs.existsSync(sqlitePath)).toBe(true);
    // Corrupt row is unchanged (parseStoreJson returned empty profiles, nothing modified)
    const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
    const raw2 = new mod.DatabaseSync(sqlitePath);
    const row = raw2.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary");
    raw2.close();
    expect((row as { store_json: string }).store_json).toBe("CORRUPT_JSON");
  });

  it("is a no-op when the DB file does not exist", async () => {
    const { clearAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    // No DB file created
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    // Should not throw
    await expect(clearAuthProfiles()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// New: activateCodexOAuth service function (OQ#1)
// ---------------------------------------------------------------------------

describe("activateCodexOAuth service function", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "activate-svc-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.doMock("../env.js", () => ({
      setCodexOAuthAccessToken: vi.fn(),
      setLlmAuthMode: vi.fn(),
    }));
    vi.doMock("../lib/state-dir.js", () => ({ STATE_DIR: stateDir }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes SQLite, calls relay, flips auth mode on success", async () => {
    const { activateCodexOAuth, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const { setLlmAuthMode } = await import("../env.js");

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    const relay = vi.fn().mockResolvedValue(undefined);

    const result = await activateCodexOAuth(
      { accessToken: "access-ok", refreshToken: "refresh-ok", expiresIn: 3600 },
      { relayConfigPatch: relay },
    );

    expect(result).toEqual({ ok: true });
    expect(relay).toHaveBeenCalledOnce();
    expect(relay).toHaveBeenCalledWith(expect.stringContaining("openai/gpt-5.4"));
    expect(setLlmAuthMode).toHaveBeenCalledWith("codex_oauth");

    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    expect(store!.profiles["openai:default"]).toBeDefined();
  });

  it("rollback: relay failure removes SQLite row and clears liveness (OQ#1)", async () => {
    const { activateCodexOAuth, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    const { setLlmAuthMode } = await import("../env.js");

    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;
    const relay = vi.fn().mockRejectedValue(new Error("gateway down"));

    const result = await activateCodexOAuth(
      { accessToken: "access-fail", refreshToken: "refresh-fail", expiresIn: 3600 },
      { relayConfigPatch: relay },
    );

    expect(result).toEqual({ error: "gateway down" });
    // Auth mode must NOT have been set to codex_oauth
    expect(setLlmAuthMode).not.toHaveBeenCalledWith("codex_oauth");
    // Liveness token cleared (clearTokens deleted the file)
    expect(fs.existsSync(path.join(stateDir, "codex-oauth.json"))).toBe(false);
    // SQLite row rolled back — openai:default must be absent from profiles
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    // After rollback clearAuthProfiles, store has empty profiles (row exists but oauth profile gone)
    if (store) {
      expect(store.profiles["openai:default"]).toBeUndefined();
    }
  });

  it("OQ#5 writeAuthProfiles also upserts SQLite openai:default (token-only path)", async () => {
    const { writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    // Simulate the token-only endpoint calling storeTokens + writeAuthProfiles
    await writeAuthProfiles("token-only-access", "token-only-refresh", 7200);

    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    expect(store).not.toBeNull();
    expect((store!.profiles["openai:default"] as Record<string, unknown>).access).toBe("token-only-access");
  });
});

// ---------------------------------------------------------------------------
// New: deactivateCodexOAuth service function
// ---------------------------------------------------------------------------

describe("deactivateCodexOAuth service function", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "deactivate-svc-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.doMock("../env.js", () => ({
      setCodexOAuthAccessToken: vi.fn(),
      setLlmAuthMode: vi.fn(),
    }));
    vi.doMock("../lib/state-dir.js", () => ({ STATE_DIR: stateDir }));
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("OQ#5 clearAuthProfiles clears SQLite OAuth openai:default (token-delete path)", async () => {
    const { clearAuthProfiles, writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    // First write a credential, then clear (simulating DELETE /admin/codex-oauth-tokens)
    await writeAuthProfiles("tok-access", "tok-refresh", 3600);
    await clearAuthProfiles();

    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    // Row still exists but openai:default OAuth is gone
    expect(store!.profiles["openai:default"]).toBeUndefined();
  });

  it("patch failure leaves credentials intact so deactivation is retryable", async () => {
    const { deactivateCodexOAuth, writeAuthProfiles, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    // Seed a credential
    await writeAuthProfiles("acc", "ref", 3600);

    const relay = vi.fn().mockRejectedValue(new Error("patch failed"));
    const result = await deactivateCodexOAuth({}, { relayConfigPatch: relay });

    expect(result).toEqual({ error: "patch failed" });

    // Credential must still be in SQLite (not cleared on patch failure)
    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    expect(store!.profiles["openai:default"]).toBeDefined();
  });

  it("clears auth store and liveness on successful deactivation", async () => {
    const { deactivateCodexOAuth, writeAuthProfiles, storeTokens, codexAuthStoreInternals } = await import("../services/codex-oauth.js");
    codexAuthStoreInternals.openAuthStoreDb = async (p) => (await openNodeSqliteAuthStoreDb(p)).db;

    // Seed credential and liveness
    await writeAuthProfiles("acc", "ref", 3600);
    storeTokens("acc", "ref", 3600);

    const relay = vi.fn().mockResolvedValue(undefined);
    const result = await deactivateCodexOAuth({}, { relayConfigPatch: relay });

    expect(result).toEqual({ ok: true });

    const sqlitePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    const store = await queryAuthStore(sqlitePath);
    expect(store!.profiles["openai:default"]).toBeUndefined();

    // Liveness token removed
    expect(fs.existsSync(path.join(stateDir, "codex-oauth.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OQ#5 handler wiring: POST/DELETE /admin/codex-oauth-tokens (Hono app.request)
// ---------------------------------------------------------------------------
// The non-fatal try/catch in each handler means a missing or broken call to
// writeAuthProfiles / clearAuthProfiles returns HTTP 200 and is silently missed
// without an explicit handler-level assertion. These tests spy at the module
// level so the call is detectable regardless of the surrounding error handling.

describe("OQ#5 handler wiring — POST/DELETE /admin/codex-oauth-tokens (Hono)", () => {
  beforeEach(() => {
    vi.resetModules();
    // Stub every admin.ts dependency except codex-oauth (set per-test so each
    // test can capture its own spy reference before importing the router).
    vi.doMock("../lib/state-dir.js", () => ({ STATE_DIR: "/tmp/handler-wiring-test" }));
    vi.doMock("../env.js", () => ({
      setLlmCredentials: vi.fn(),
      setLlmAuthMode: vi.fn(),
      setLlmProvider: vi.fn(),
      seedKeyring: vi.fn(),
      hasKeyringEntry: vi.fn().mockReturnValue(true),
      getCodexOAuthStatus: vi.fn().mockReturnValue({}),
      getKeyringSize: vi.fn().mockReturnValue(0),
      isActiveProviderKeyed: vi.fn().mockReturnValue(false),
      getLlmProvider: vi.fn().mockReturnValue("openai"),
    }));
    vi.doMock("../services/backup.js", () => ({
      createBackupTarball: vi.fn(),
      uploadBackup: vi.fn(),
      downloadBackup: vi.fn(),
      restoreFromTarball: vi.fn(),
      cleanupTempFile: vi.fn(),
    }));
    vi.doMock("../services/quota.js", () => ({
      syncQuota: vi.fn(),
      getQuotaStatus: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock("../services/gateway-rpc.js", () => ({
      relayConfigPatch: vi.fn(),
      installSkillFromClawHub: vi.fn(),
      removeSkillFromWorkspace: vi.fn(),
      getSkillsStatus: vi.fn(),
      updateSkill: vi.fn(),
      installSkillDependencyWithFallback: vi.fn(),
    }));
    vi.doMock("../services/workspace-files.js", () => ({
      listWorkspaceFiles: vi.fn(),
      readWorkspaceFile: vi.fn(),
      writeWorkspaceFile: vi.fn(),
      readSkillFile: vi.fn(),
      writeSkillFile: vi.fn(),
      restartGateway: vi.fn(),
      readOpenclawConfig: vi.fn(),
      writeOpenclawConfig: vi.fn(),
      getGatewayStatus: vi.fn(),
    }));
    vi.doMock("../services/bird-skill.js", () => ({
      setupBirdSkill: vi.fn(),
      redactBirdSecrets: vi.fn(),
    }));
    vi.doMock("../services/gog-skill.js", () => ({
      setupGog: vi.fn(),
      gogOauthStart: vi.fn(),
      gogOauthComplete: vi.fn(),
      gogStatus: vi.fn(),
      gogDisconnect: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST /admin/codex-oauth-tokens calls writeAuthProfiles with correct args", async () => {
    const writeAuthProfilesSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../services/codex-oauth.js", () => ({
      storeTokens: vi.fn(),
      clearTokens: vi.fn(),
      writeAuthProfiles: writeAuthProfilesSpy,
      clearAuthProfiles: vi.fn().mockResolvedValue(undefined),
      withCodexOAuthTransition: vi.fn(),
      activateCodexOAuth: vi.fn().mockResolvedValue({ ok: true }),
      deactivateCodexOAuth: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const { adminRouter } = await import("../routes/admin.js");
    const res = await adminRouter.request("/admin/codex-oauth-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: "acc-h", refreshToken: "ref-h", expiresIn: 7200 }),
    });

    expect(res.status).toBe(200);
    expect(writeAuthProfilesSpy).toHaveBeenCalledWith("acc-h", "ref-h", 7200);
  });

  it("DELETE /admin/codex-oauth-tokens calls clearAuthProfiles", async () => {
    const clearAuthProfilesSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../services/codex-oauth.js", () => ({
      storeTokens: vi.fn(),
      clearTokens: vi.fn(),
      writeAuthProfiles: vi.fn().mockResolvedValue(undefined),
      clearAuthProfiles: clearAuthProfilesSpy,
      withCodexOAuthTransition: vi.fn(),
      activateCodexOAuth: vi.fn().mockResolvedValue({ ok: true }),
      deactivateCodexOAuth: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const { adminRouter } = await import("../routes/admin.js");
    const res = await adminRouter.request("/admin/codex-oauth-tokens", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(clearAuthProfilesSpy).toHaveBeenCalled();
  });
});
