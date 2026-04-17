import { Hono } from "hono";
import type { SidecarBackupRequest, SidecarRestoreRequest } from "../backup-contract.js";

import {
  setLlmCredentials,
  setLlmAuthMode,
  setLlmProvider,
  getCodexOAuthStatus,
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
  CODEX_OAUTH_DEFAULT_MODEL,
} from "../services/codex-oauth.js";
import {
  relayConfigPatch,
  installSkillFromClawHub,
  removeSkillFromWorkspace,
  getSkillsStatus,
  updateSkill,
  installSkillDependency,
  installSkillDependencyFallback,
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

export const adminRouter = new Hono();

adminRouter.post("/admin/rotate-key", async (c) => {
  const body = await c.req.json<{ apiKey: string; upstreamUrl?: string }>();
  if (!body.apiKey) {
    return c.json({ error: "apiKey is required" }, 400);
  }
  setLlmCredentials(body.apiKey, body.upstreamUrl);
  return c.json({ ok: true });
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
  setLlmAuthMode(authMode);
  return c.json({ ok: true });
});

adminRouter.post("/admin/set-provider", async (c) => {
  const { provider, upstreamUrl } = await c.req.json<{
    provider: string;
    upstreamUrl?: string;
  }>();
  if (!provider) {
    return c.json({ error: "provider is required" }, 400);
  }
  setLlmProvider(provider, upstreamUrl);
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
  storeTokens(accessToken, refreshToken, expiresIn);
  return c.json({ ok: true });
});

adminRouter.delete("/admin/codex-oauth-tokens", async (c) => {
  clearTokens();
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
    const result = await installSkillDependency({ name, installId, timeoutMs });
    return c.json(result);
  } catch {
    try {
      const fallbackResult = await installSkillDependencyFallback(name);
      return c.json(fallbackResult);
    } catch (fbErr) {
      const message =
        fbErr instanceof Error ? fbErr.message : "dep_install_failed";
      console.error("[sidecar] skills dep-install fallback failed:", message);
      return c.json({ error: message }, 502);
    }
  }
});

// ---------------------------------------------------------------------------
// Composite Codex OAuth activation / deactivation
// ---------------------------------------------------------------------------

/**
 * Activate Codex OAuth: write auth-profiles.json for openai-codex provider,
 * set default model to openai-codex/gpt-5.4, then reload gateway config.
 * The openai provider stays on sidecar proxy (for API Key mode fallback).
 */
adminRouter.post("/admin/activate-codex-oauth", async (c) => {
  const { accessToken, refreshToken, expiresIn } = await c.req.json<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>();
  if (!accessToken || !refreshToken) {
    return c.json(
      { error: "accessToken and refreshToken are required" },
      400,
    );
  }

  storeTokens(accessToken, refreshToken, expiresIn);
  setLlmAuthMode("codex_oauth");

  writeAuthProfiles(accessToken, refreshToken, expiresIn);

  const modelPatch = JSON.stringify({
    agents: { defaults: { model: CODEX_OAUTH_DEFAULT_MODEL } },
  });
  try {
    await relayConfigPatch(modelPatch);
  } catch (err) {
    console.warn(
      "[sidecar] activate-codex-oauth config reload failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  console.log("[sidecar] Codex OAuth activated (openai-codex provider)");
  return c.json({ ok: true });
});

/**
 * Deactivate Codex OAuth: clear openai-codex auth profiles, restore default
 * model, then reload gateway config. The openai provider is untouched
 * (it was never modified — always on sidecar proxy).
 */
adminRouter.post("/admin/deactivate-codex-oauth", async (c) => {
  const body = await c.req.json<{ restoreModel?: string }>().catch(() => ({} as { restoreModel?: string }));

  clearAuthProfiles();
  clearTokens();

  const restoreModel = body.restoreModel ?? "openai/gpt-4o";
  const modelPatch = JSON.stringify({
    agents: { defaults: { model: restoreModel } },
  });
  try {
    await relayConfigPatch(modelPatch);
  } catch (err) {
    console.warn(
      "[sidecar] deactivate-codex-oauth config reload failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  console.log("[sidecar] Codex OAuth deactivated (openai-codex profiles cleared)");
  return c.json({ ok: true });
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
