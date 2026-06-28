import { Hono } from "hono";
import type {
  SidecarBackupRequest,
  SidecarRestoreRequest,
} from "../backup-contract.js";
import {
  setLlmCredentials,
  setLlmAuthMode,
  setLlmProvider,
  seedKeyring,
  hasKeyringEntry,
  getCodexOAuthStatus,
  getKeyringSize,
  isActiveProviderKeyed,
  getLlmProvider,
} from "../env.js";
import {
  createBackupTarball,
  uploadBackup,
  downloadBackup,
  restoreFromTarball,
  cleanupTempFile,
} from "../services/backup.js";
import { syncQuota, getQuotaStatus } from "../services/quota.js";
import {
  storeTokens,
  clearTokens,
  writeAuthProfiles,
  clearAuthProfiles,
  withCodexOAuthTransition,
  activateCodexOAuth,
  deactivateCodexOAuth,
} from "../services/codex-oauth.js";
import {
  relayConfigPatch,
  installSkillFromClawHub,
  removeSkillFromWorkspace,
  getSkillsStatus,
  updateSkill,
  installSkillDependencyWithFallback,
} from "../services/gateway-rpc.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  readSkillFile,
  writeSkillFile,
  restartGateway,
  readOpenclawConfig,
  writeOpenclawConfig,
  getGatewayStatus,
} from "../services/workspace-files.js";
import { setupBirdSkill, redactBirdSecrets, type BirdSetupRequest, type BirdSetupResponse } from "../services/bird-skill.js";
import {
  setupGog,
  gogOauthStart,
  gogOauthComplete,
  gogStatus,
  gogDisconnect,
  type GogSetupRequest,
  type GogOauthCompleteRequest,
  type GogDisconnectRequest,
} from "../services/gog-skill.js";

export const adminRouter = new Hono();

adminRouter.post("/admin/rotate-key", async (c) => {
  const body = await c.req.json<{
    apiKey: string;
    upstreamUrl?: string;
    provider?: string;
    apiStyle?: "openai" | "anthropic" | "google-generative-ai";
    requiredAuth?: Record<string, string>;
  }>();
  if (!body.apiKey) {
    return c.json({ error: "apiKey is required" }, 400);
  }
  if (body.provider) {
    setLlmCredentials(body.provider, body.apiKey, body.upstreamUrl, body.apiStyle, body.requiredAuth);
  } else {
    // Legacy path: update active provider's credentials
    setLlmCredentials(body.apiKey, body.upstreamUrl);
  }
  return c.json({ ok: true });
});

const LLM_KEYRING_MAX_ENTRIES = 32;

adminRouter.post("/admin/llm-keyring", async (c) => {
  const body = await c.req.json<{
    entries: Array<{ provider: string; apiKey: string; baseUrl?: string; apiStyle?: "openai" | "anthropic" | "google-generative-ai" }>;
    activeProvider?: string;
  }>();
  if (!Array.isArray(body.entries)) {
    return c.json({ error: "entries must be an array" }, 400);
  }
  if (body.entries.length > LLM_KEYRING_MAX_ENTRIES) {
    return c.json({ error: "too_many_entries", max: LLM_KEYRING_MAX_ENTRIES }, 400);
  }
  seedKeyring(body.entries, body.activeProvider);
  return c.json({ ok: true });
});

/**
 * GET /admin/llm-keyring/status
 * Returns keyring state WITHOUT key material. Safe to call on every health tick.
 * Response: { entryCount, activeProvider, activeHasKey }
 */
adminRouter.get("/admin/llm-keyring/status", (c) => {
  return c.json({
    entryCount: getKeyringSize(),
    activeProvider: getLlmProvider(),
    activeHasKey: isActiveProviderKeyed(),
  });
});

adminRouter.post("/admin/quota-sync", async (c) => {
  const payload = await c.req.json();
  await syncQuota(payload);
  return c.json({ ok: true });
});

adminRouter.get("/admin/quota-status", async (c) => {
  const status = await getQuotaStatus();
  return c.json(status);
});

adminRouter.post("/admin/set-auth-mode", async (c) => {
  const { authMode } = await c.req.json<{ authMode: string }>();
  if (!authMode) {
    return c.json({ error: "authMode is required" }, 400);
  }
  // Carries no token payload — flipping to codex_oauth is only meaningful once
  // SQLite auth_profile_store holds a live openai:default OAuth credential.
  // Use /admin/activate-codex-oauth for the full activation flow instead.
  setLlmAuthMode(authMode);
  return c.json({ ok: true });
});

adminRouter.post("/admin/set-provider", async (c) => {
  const { provider, upstreamUrl, apiStyle } = await c.req.json<{
    provider: string;
    upstreamUrl?: string;
    apiStyle?: "openai" | "anthropic" | "google-generative-ai";
  }>();
  if (!provider) {
    return c.json({ error: "provider is required" }, 400);
  }
  // Reject switch if the target provider has no cached key and none is being supplied
  if (!hasKeyringEntry(provider)) {
    return c.json({ error: "missing_key_for_provider", provider }, 409);
  }
  setLlmProvider(provider, upstreamUrl, apiStyle);
  return c.json({ ok: true });
});

adminRouter.post("/admin/codex-oauth-tokens", async (c) => {
  const { accessToken, refreshToken, expiresIn } = await c.req.json<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>();
  if (!accessToken || !refreshToken) {
    return c.json({ error: "accessToken and refreshToken are required" }, 400);
  }
  // OQ#5: also write SQLite so the Redis pending-token replay path (instances.ts:693)
  // does not leave auth_profile_store stale and re-introduce INC-2026-06-28.
  storeTokens(accessToken, refreshToken, expiresIn);
  try {
    await writeAuthProfiles(accessToken, refreshToken, expiresIn);
  } catch (err) {
    // Non-fatal: liveness token is stored; next full activation will overwrite.
    console.error("[sidecar] codex-oauth-tokens SQLite write failed:", err instanceof Error ? err.message : err);
  }
  return c.json({ ok: true });
});

adminRouter.delete("/admin/codex-oauth-tokens", async (c) => {
  // OQ#5: also clear SQLite so a later token-replay cannot re-activate stale creds.
  clearTokens();
  try {
    await clearAuthProfiles();
  } catch (err) {
    console.error("[sidecar] codex-oauth-tokens SQLite clear failed:", err instanceof Error ? err.message : err);
  }
  return c.json({ ok: true });
});

adminRouter.get("/admin/codex-oauth-status", async (c) => {
  const status = getCodexOAuthStatus();
  return c.json(status);
});

adminRouter.post("/admin/config-patch", async (c) => {
  const { raw, gatewayToken } = await c.req.json<{
    raw: string;
    gatewayToken?: string;
  }>();
  if (!raw) {
    return c.json({ error: "raw is required" }, 400);
  }
  try {
    const result = await relayConfigPatch(raw, gatewayToken);
    return c.json({ ok: true, result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "config_patch_relay_failed";
    console.error("[sidecar] config-patch relay failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Skills — Content Install from ClawHub
// ---------------------------------------------------------------------------

adminRouter.post("/admin/skills/install", async (c) => {
  const { slug } = await c.req.json<{ slug: string }>();
  if (!slug) {
    return c.json({ error: "slug is required" }, 400);
  }
  if (!SKILL_SLUG_RE.test(slug)) {
    return c.json({ error: "invalid_slug" }, 400);
  }
  try {
    const result = await installSkillFromClawHub(slug);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "skills_install_failed";
    console.error("[sidecar] skills install failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Skills — Content Remove
// ---------------------------------------------------------------------------

adminRouter.delete("/admin/skills/uninstall", async (c) => {
  const { slug } = await c.req.json<{ slug: string }>();
  if (!slug) {
    return c.json({ error: "slug is required" }, 400);
  }
  if (!SKILL_SLUG_RE.test(slug)) {
    return c.json({ error: "invalid_slug" }, 400);
  }
  try {
    const result = await removeSkillFromWorkspace(slug);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "skills_remove_failed";
    console.error("[sidecar] skills remove failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Skills — Status Query via Gateway RPC
// ---------------------------------------------------------------------------

adminRouter.get("/admin/skills/status", async (c) => {
  try {
    const result = await getSkillsStatus();
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "skills_status_failed";
    console.error("[sidecar] skills status failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Skills — Config Update via Gateway RPC
// ---------------------------------------------------------------------------

adminRouter.patch("/admin/skills/update", async (c) => {
  const params = await c.req.json<{
    skillKey: string;
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
  }>();
  if (!params.skillKey) {
    return c.json({ error: "skillKey is required" }, 400);
  }
  try {
    const result = await updateSkill(params);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "skills_update_failed";
    console.error("[sidecar] skills update failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Skills — Dependency Install (Gateway RPC + fallback parser)
// ---------------------------------------------------------------------------

adminRouter.post("/admin/skills/dep-install", async (c) => {
  const { name, installId, timeoutMs } = await c.req.json<{
    name: string;
    installId: string;
    timeoutMs?: number;
  }>();
  if (!name || !installId) {
    return c.json({ error: "name and installId are required" }, 400);
  }
  try {
    const result = await installSkillDependencyWithFallback({ name, installId, timeoutMs });
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "dep_install_failed";
    console.error("[sidecar] skills dep-install failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Composite Codex OAuth activation / deactivation
// ---------------------------------------------------------------------------

/**
 * Activate Codex OAuth: write SQLite auth_profile_store -> gateway config-patch
 * -> flip auth mode. Compound logic lives in activateCodexOAuth() (codex-oauth.ts)
 * so it is unit-testable without spinning up the Hono app (OQ#1).
 * On patch failure the service rolls back the just-written credential and clears
 * liveness, then returns an error that maps here to 502.
 */
adminRouter.post("/admin/activate-codex-oauth", async (c) => {
  const { accessToken, refreshToken, expiresIn } = await c.req.json<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>();
  if (!accessToken || !refreshToken) {
    return c.json({ error: "accessToken and refreshToken are required" }, 400);
  }
  return withCodexOAuthTransition(async () => {
    const result = await activateCodexOAuth(
      { accessToken, refreshToken, expiresIn },
      { relayConfigPatch },
    );
    if ("error" in result) {
      console.error("[sidecar] activate-codex-oauth failed:", result.error);
      return c.json({ error: result.error }, 502);
    }
    console.log("[sidecar] Codex OAuth activated");
    return c.json({ ok: true });
  });
});

/**
 * Deactivate Codex OAuth: gateway config-patch restore model -> clear SQLite
 * auth_profile_store + liveness token. Compound logic lives in
 * deactivateCodexOAuth() (codex-oauth.ts) for unit-testability (OQ#1).
 */
adminRouter.post("/admin/deactivate-codex-oauth", async (c) => {
  const body = await c
    .req.json<{ restoreModel?: string }>()
    .catch(() => ({} as { restoreModel?: string }));
  return withCodexOAuthTransition(async () => {
    const result = await deactivateCodexOAuth(
      { restoreModel: body.restoreModel },
      { relayConfigPatch },
    );
    if ("error" in result) {
      console.error("[sidecar] deactivate-codex-oauth failed:", result.error);
      return c.json({ error: result.error }, 502);
    }
    console.log("[sidecar] Codex OAuth deactivated");
    return c.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Workspace Files — CRUD for workspace Markdown files
// ---------------------------------------------------------------------------

adminRouter.get("/admin/workspace/files", async (c) => {
  try {
    const result = await listWorkspaceFiles();
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "workspace_list_failed";
    console.error("[sidecar] workspace list failed:", message);
    return c.json({ error: message }, 502);
  }
});

adminRouter.get("/admin/workspace/files/:filename", async (c) => {
  const filename = c.req.param("filename");
  try {
    const result = await readWorkspaceFile(filename);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "workspace_read_failed";
    if (message.includes("ENOENT")) {
      return c.json({ error: "file_not_found" }, 404);
    }
    if (message.startsWith("invalid_filename") || message.startsWith("path_traversal")) {
      return c.json({ error: message }, 400);
    }
    console.error("[sidecar] workspace read failed:", message);
    return c.json({ error: message }, 502);
  }
});

adminRouter.put("/admin/workspace/files/:filename", async (c) => {
  const filename = c.req.param("filename");
  const { content } = await c.req.json<{ content: string }>();
  if (content === undefined || content === null) {
    return c.json({ error: "content is required" }, 400);
  }
  try {
    const result = await writeWorkspaceFile(filename, content);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "workspace_write_failed";
    if (message.startsWith("invalid_filename") || message.startsWith("path_traversal") || message.startsWith("file_too_large")) {
      return c.json({ error: message }, 400);
    }
    console.error("[sidecar] workspace write failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Workspace Skills — Read/Write skill SKILL.md files
// ---------------------------------------------------------------------------

adminRouter.get("/admin/workspace/skills/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    const result = await readSkillFile(slug);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "skill_read_failed";
    if (message.includes("ENOENT")) {
      return c.json({ error: "file_not_found" }, 404);
    }
    if (message.startsWith("invalid_slug") || message.startsWith("path_traversal")) {
      return c.json({ error: message }, 400);
    }
    console.error("[sidecar] skill read failed:", message);
    return c.json({ error: message }, 502);
  }
});

adminRouter.put("/admin/workspace/skills/:slug", async (c) => {
  const slug = c.req.param("slug");
  const { content } = await c.req.json<{ content: string }>();
  if (content === undefined || content === null) {
    return c.json({ error: "content is required" }, 400);
  }
  try {
    const result = await writeSkillFile(slug, content);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "skill_write_failed";
    if (message.startsWith("invalid_slug") || message.startsWith("path_traversal") || message.startsWith("file_too_large")) {
      return c.json({ error: message }, 400);
    }
    console.error("[sidecar] skill write failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Gateway Restart — SIGUSR1 in-process restart
// ---------------------------------------------------------------------------

adminRouter.post("/admin/gateway/restart", async (c) => {
  try {
    const result = await restartGateway();
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "gateway_restart_failed";
    console.error("[sidecar] gateway restart failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Gateway Status — check if gateway process is running
// ---------------------------------------------------------------------------

adminRouter.get("/admin/gateway/status", (c) => {
  const result = getGatewayStatus();
  return c.json(result);
});

// ---------------------------------------------------------------------------
// OpenClaw Config (openclaw.json) — Raw Read / Write
// ---------------------------------------------------------------------------

adminRouter.get("/admin/config", async (c) => {
  try {
    const result = await readOpenclawConfig();
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "config_read_failed";
    if (message.includes("ENOENT")) {
      return c.json({ content: "{}\n", sizeBytes: 3, modifiedAt: new Date().toISOString(), tooLarge: false });
    }
    console.error("[sidecar] config read failed:", message);
    return c.json({ error: message }, 502);
  }
});

adminRouter.put("/admin/config", async (c) => {
  const { content } = await c.req.json<{ content: string }>();
  if (content === undefined || content === null) {
    return c.json({ error: "content is required" }, 400);
  }
  try {
    const result = await writeOpenclawConfig(content);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "config_write_failed";
    if (message.startsWith("file_too_large")) {
      return c.json({ error: message }, 400);
    }
    console.error("[sidecar] config write failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Backup & Restore
// ---------------------------------------------------------------------------

const BACKUP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SKILL_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

adminRouter.post("/admin/backup", async (c) => {
  const body = await c.req.json<SidecarBackupRequest>();
  if (!body.uploadUrl || !body.backupId) {
    return c.json({ error: "uploadUrl and backupId are required" }, 400);
  }
  if (!BACKUP_ID_RE.test(body.backupId)) {
    return c.json({ error: "invalid_backup_id" }, 400);
  }
  const startTime = Date.now();
  try {
    const tarResult = await createBackupTarball(body.backupId);
    try {
      await uploadBackup(tarResult.path, body.uploadUrl);
    } finally {
      await cleanupTempFile(tarResult.path);
    }
    return c.json({
      ok: true,
      sizeBytes: tarResult.sizeBytes,
      checksumSha256: tarResult.checksumSha256,
      fileCount: tarResult.fileCount,
      durationMs: Date.now() - startTime,
      metadata: tarResult.metadata,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "backup_failed";
    console.error("[sidecar] backup failed:", message);
    return c.json({ error: message }, 502);
  }
});

adminRouter.post("/admin/restore", async (c) => {
  const body = await c.req.json<SidecarRestoreRequest>();
  if (!body.downloadUrl || !body.backupId) {
    return c.json({ error: "downloadUrl and backupId are required" }, 400);
  }
  if (!BACKUP_ID_RE.test(body.backupId)) {
    return c.json({ error: "invalid_backup_id" }, 400);
  }
  const startTime = Date.now();
  try {
    const filePath = await downloadBackup(body.downloadUrl, body.backupId);
    if (body.expectedChecksum) {
      const hasher = new Bun.CryptoHasher("sha256");
      const file = Bun.file(filePath);
      const reader = file.stream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
      const actual = hasher.digest("hex") as string;
      if (actual !== body.expectedChecksum) {
        await cleanupTempFile(filePath);
        throw new Error(`checksum_mismatch: expected ${body.expectedChecksum}, got ${actual}`);
      }
    }
    await restoreFromTarball(body.backupId);
    return c.json({
      ok: true,
      restoredAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "restore_failed";
    console.error("[sidecar] restore failed:", message);
    return c.json({ error: message }, 502);
  }
});

// ─── POST /admin/skills/gog/setup ────────────────────────────────────────────

adminRouter.post("/admin/skills/gog/setup", async (c) => {
  const body = await c.req.json<GogSetupRequest>();
  if (!body.accountEmail || !body.authMode || !Array.isArray(body.services) || body.services.length === 0) {
    return c.json({ error: "accountEmail, authMode, and services are required" }, 400);
  }
  try {
    const result = await setupGog(body);
    return c.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_setup_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog setup failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── GET /admin/skills/gog/status ─────────────────────────────────────────────

adminRouter.get("/admin/skills/gog/status", async (c) => {
  try {
    const result = await gogStatus();
    return c.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_status_failed";
    console.error("[sidecar] gog status failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── DELETE /admin/skills/gog/disconnect ──────────────────────────────────────

adminRouter.delete("/admin/skills/gog/disconnect", async (c) => {
  const body = await c.req.json<GogDisconnectRequest>();
  if (!body.accountEmail) {
    return c.json({ error: "accountEmail is required" }, 400);
  }
  try {
    const result = await gogDisconnect(body.accountEmail);
    return c.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_disconnect_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog disconnect failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── POST /admin/skills/gog/oauth/start ───────────────────────────────────────

adminRouter.post("/admin/skills/gog/oauth/start", async (c) => {
  const body = await c.req.json<{ accountEmail: string }>();
  if (!body.accountEmail) {
    return c.json({ error: "accountEmail is required" }, 400);
  }
  try {
    const result = await gogOauthStart(body.accountEmail);
    return c.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_oauth_start_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog oauth/start failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── POST /admin/skills/gog/oauth/complete ────────────────────────────────────

adminRouter.post("/admin/skills/gog/oauth/complete", async (c) => {
  const body = await c.req.json<GogOauthCompleteRequest>();
  if (!body.accountEmail || !body.redirectUrl) {
    return c.json({ error: "accountEmail and redirectUrl are required" }, 400);
  }
  try {
    const result = await gogOauthComplete(body);
    return c.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "gog_oauth_complete_failed";
    if (code === "gog_setup_in_progress") return c.json({ error: code }, 409);
    console.error("[sidecar] gog oauth/complete failed:", code);
    return c.json({ error: code }, 502);
  }
});

// ─── POST /admin/skills/bird/setup — Setup bird skill ──────────────────────

adminRouter.post("/admin/skills/bird/setup", async (c) => {
  const body = await c.req.json<BirdSetupRequest>();
  if (!body.authMode || !body.authToken || !body.ct0) {
    return c.json(
      { error: "authMode, authToken, and ct0 are required" },
      400,
    );
  }
  if (body.authMode !== "cookies") {
    return c.json({ error: "unsupported_auth_mode" }, 400);
  }

  try {
    const result = await setupBirdSkill(body);
    const redacted = redactBirdSecrets(result) as BirdSetupResponse;
    return c.json(redacted);
  } catch (err) {
    // Log with redaction; return structured error code, never raw message.
    console.error("[sidecar] bird setup failed:", redactBirdSecrets({ error: err instanceof Error ? err.message : "unknown" }));
    return c.json({ error: "bird_setup_failed" }, 502);
  }
});
