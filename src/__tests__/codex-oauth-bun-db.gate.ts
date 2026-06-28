/**
 * Bun real-DB gate — incident INC-2026-06-28 verification step 9.2.
 *
 * MANDATORY BLOCKING gate before merge. Must be run in a Bun environment
 * (the production runtime). Exercises the REAL `openAuthStoreDbImpl` →
 * `bun:sqlite` path end-to-end. NOT a vitest file.
 *
 * Usage (from the sidecar package root or via pnpm):
 *   bun run src/__tests__/codex-oauth-bun-db.gate.ts
 *   pnpm --dir iclawagent-app vitest run   # must NOT pick this up
 *
 * The vitest include glob is src/__tests__/**\/*.test.ts which does not
 * match this .gate.ts file. Vitest is therefore safe.
 *
 * Environment: runs in a Linux Bun container. Uses /tmp directly so
 * OPENCLAW_STATE_DIR starts with "/" (required by lib/state-dir.ts).
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Disposable state dir — MUST be set before any dynamic import of codex-oauth
// ---------------------------------------------------------------------------

const TMP_STATE_DIR = `/tmp/codex-oauth-bun-gate-${process.pid}`;
fs.mkdirSync(TMP_STATE_DIR, { recursive: true });

// Set before module evaluation of lib/state-dir.ts (which reads this at load time).
process.env.OPENCLAW_STATE_DIR = TMP_STATE_DIR;

// ---------------------------------------------------------------------------
// Minimal assertion helper
// ---------------------------------------------------------------------------

let failed = false;

function pass(msg: string): void {
  console.log(`  PASS: ${msg}`);
}

function fail(msg: string): void {
  console.error(`  FAIL: ${msg}`);
  failed = true;
}

function assert(condition: boolean, msg: string): void {
  if (condition) pass(msg);
  else fail(msg);
}

// ---------------------------------------------------------------------------
// Inline bun:sqlite type (mirrors codex-oauth.ts BunSqliteModule — no top-level import)
// ---------------------------------------------------------------------------

type BunStatement = {
  get(...p: unknown[]): Record<string, unknown> | undefined;
  run(...p: unknown[]): void;
};

type BunDb = {
  prepare(sql: string): BunStatement;
  close(): void;
};

type BunSqliteMod = {
  Database: new (p: string, opts?: { readonly?: boolean }) => BunDb;
};

// ---------------------------------------------------------------------------
// Gate: write → read back via bun:sqlite directly
// ---------------------------------------------------------------------------

console.log("\n[bun-db-gate] Starting — exercises real bun:sqlite production path\n");

let exitCode = 0;

try {
  // Dynamic import so lib/state-dir.ts evaluates AFTER OPENCLAW_STATE_DIR is set.
  // Also defers env.ts load — validateEnv() is NOT called here (requires real env vars).
  const {
    writeAuthProfiles,
    clearAuthProfiles,
    codexAuthStoreInternals,
  } = await import("../services/codex-oauth.js");

  // Confirm no double was accidentally injected (real impl name check).
  const implFnName = codexAuthStoreInternals.openAuthStoreDb.name;
  assert(
    implFnName === "openAuthStoreDbImpl",
    `openAuthStoreDb is the production impl (name="${implFnName}")`,
  );

  const sqlitePath = path.join(TMP_STATE_DIR, "agents/main/agent/openclaw-agent.sqlite");

  // ---- Step 1: write with fresh tokens ----
  console.log("\n[step 1] writeAuthProfiles — fresh DB, no prior file");
  const beforeMs = Date.now();
  await writeAuthProfiles(
    "gate-access-placeholder",
    "gate-refresh-placeholder",
    7200,
  );

  assert(fs.existsSync(sqlitePath), "SQLite file created");

  // Read back using bun:sqlite directly.
  const bunMod = (await import("bun:sqlite")) as unknown as BunSqliteMod;
  const db1 = new bunMod.Database(sqlitePath, { readonly: true });
  const row1 = db1
    .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
    .get("primary") as { store_json: string } | undefined;
  db1.close();

  assert(row1 !== undefined, "auth_profile_store 'primary' row exists");

  if (row1) {
    const store1 = JSON.parse(row1.store_json) as {
      version: number;
      profiles: Record<string, Record<string, unknown>>;
    };
    assert(store1.version === 1, `store.version === 1 (got ${store1.version})`);

    const profile1 = store1.profiles["openai:default"];
    assert(profile1 !== undefined, "openai:default profile present");

    if (profile1) {
      assert(profile1.type === "oauth", `profile.type === 'oauth' (got ${String(profile1.type)})`);
      assert(
        typeof profile1.expires === "number",
        `profile.expires is a number (got ${typeof profile1.expires})`,
      );
      const expiresMs = profile1.expires as number;
      const minExpected = beforeMs + 5 * 60 * 1000;
      assert(
        expiresMs > minExpected,
        `expires ${expiresMs} > Date.now()+5min ${minExpected} (headroom=${expiresMs - beforeMs}ms)`,
      );
    }
  }

  // ---- Step 2: sibling profile preserved on second write ----
  console.log("\n[step 2] sibling profile preserved");

  // Inject a sibling directly via bun:sqlite.
  const bunMod2 = (await import("bun:sqlite")) as unknown as BunSqliteMod;
  const db2w = new bunMod2.Database(sqlitePath);
  const existingRow = db2w.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json: string };
  const existingStore = JSON.parse(existingRow.store_json) as { version: number; profiles: Record<string, unknown> };
  existingStore.profiles["anthropic:default"] = { type: "api_key", key: "sibling-key" };
  db2w.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?")
    .run(JSON.stringify(existingStore), Date.now(), "primary");
  db2w.close();

  await writeAuthProfiles(
    "gate-access-v2",
    "gate-refresh-v2",
    7200,
  );

  const db2r = new bunMod2.Database(sqlitePath, { readonly: true });
  const row2 = db2r.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json: string };
  db2r.close();
  const store2 = JSON.parse(row2.store_json) as { profiles: Record<string, Record<string, unknown>> };
  assert(
    store2.profiles["anthropic:default"] !== undefined,
    "sibling anthropic:default profile preserved",
  );
  assert(
    store2.profiles["openai:default"]?.access === "gate-access-v2",
    "openai:default overwritten on second write",
  );

  // ---- Step 3: clearAuthProfiles removes OAuth profile, preserves sibling ----
  console.log("\n[step 3] clearAuthProfiles — removes OAuth, preserves BYOK sibling");

  await clearAuthProfiles();

  const db3 = new bunMod2.Database(sqlitePath, { readonly: true });
  const row3 = db3.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json: string } | undefined;
  db3.close();

  assert(row3 !== undefined, "auth_profile_store row still exists after clear (DB not deleted)");

  if (row3) {
    const store3 = JSON.parse(row3.store_json) as { profiles: Record<string, unknown> };
    assert(
      store3.profiles["openai:default"] === undefined,
      "openai:default OAuth profile removed by clearAuthProfiles",
    );
    assert(
      store3.profiles["anthropic:default"] !== undefined,
      "sibling anthropic:default preserved by clearAuthProfiles",
    );
  }

} catch (err) {
  console.error("\n[bun-db-gate] EXCEPTION:", err);
  failed = true;
} finally {
  // Cleanup disposable state dir.
  try {
    fs.rmSync(TMP_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

if (failed) {
  console.error(
    "\n[bun-db-gate] FAILED — production bun:sqlite path has issues; do not merge\n",
  );
  exitCode = 1;
} else {
  console.log(
    "\n[bun-db-gate] PASSED — production bun:sqlite path verified (incident 9.2)\n",
  );
}

process.exit(exitCode);
