import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { installSkillFromClawHub, updateSkill } from "./gateway-rpc.js";
import { STATE_DIR as _MODULE_STATE_DIR } from "../lib/state-dir.js";

// Local types — sidecar is a git submodule and MUST NOT import from @iclawagent/shared.
// Keep in sync with packages/shared/src/types.ts BirdSkillSetupRequest/Response manually.
export interface BirdSetupRequest {
  slug: "bird";
  enabled?: boolean;
  authMode: "cookies";
  authToken: string;
  ct0: string;
  timeoutMs?: number;
}

export interface BirdSetupResponse {
  ok: boolean;
  installedSkill: boolean;
  installedDependency: boolean;
  enabled: boolean;
  verification: {
    command: string;
    ok: boolean;
    message: string;
  };
}

const execFileAsync = promisify(execFile);

// ─── Path Getters ─────────────────────────────────────────────────────────────
//
// The absolute-path guard runs at module load time via the lib/state-dir.ts import
// (consistent with workspace-files, gateway-rpc, backup, and codex-oauth).
//
// The getter functions still read OPENCLAW_STATE_DIR at call time so that tests
// can override the env var with vi.stubEnv without re-importing the module.
// The /data fallback matches the module-load-time default in lib/state-dir.ts.

export const BIRD_CLAWHUB_SLUG = "bird-twitter";

function getStateDir(): string {
  const val = process.env.OPENCLAW_STATE_DIR;
  if (val && !val.startsWith("/")) {
    throw new Error(
      `OPENCLAW_STATE_DIR must be an absolute path, got: "${val}"`,
    );
  }
  return val ?? "/data";
}

/** Returns the Bird install prefix derived from OPENCLAW_STATE_DIR. */
export function getBirdInstallPrefix(): string {
  return `${getStateDir()}/.iclaw`;
}

/** Returns the absolute path to the Bird binary derived from OPENCLAW_STATE_DIR. */
export function getBirdBinPath(): string {
  return `${getBirdInstallPrefix()}/bin/bird`;
}

/** Returns the absolute path to Bird credentials file derived from OPENCLAW_STATE_DIR. */
export function getBirdCredentialsPath(): string {
  return `${getBirdInstallPrefix()}/skills/bird/credentials.json`;
}

/** Returns the absolute path to the Bird skill SKILL.md derived from OPENCLAW_STATE_DIR. */
export function getBirdSkillMdPath(): string {
  return `${getStateDir()}/skills/${BIRD_CLAWHUB_SLUG}/SKILL.md`;
}

// ─── Secret Redaction ──────────────────────────────────────────────────────

/**
 * Recursively redact bird secrets (authToken, ct0) from any object.
 * Used before logging or returning responses.
 * Phase 1: only cookies mode (authToken, ct0). Sweetistics added later.
 */
export function redactBirdSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactBirdSecrets(item));
  }

  if (typeof obj === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (
        key === "authToken" ||
        key === "ct0" ||
        key === "sweetisticsApiKey"
      ) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactBirdSecrets(value);
      }
    }
    return redacted;
  }

  return obj;
}

// ─── Credential File Management ────────────────────────────────────────────

/**
 * Write bird credentials to the per-instance credential file.
 * File: $OPENCLAW_STATE_DIR/.iclaw/skills/bird/credentials.json (mode 0600)
 * Parent dir: $OPENCLAW_STATE_DIR/.iclaw/skills/bird/ (mode 0700)
 *
 * Uses atomic write: temp file + rename.
 * Throws if the state dir is not writable or not mounted.
 */
export async function writeBirdCredentials(creds: {
  authMode: "cookies";
  authToken: string;
  ct0: string;
}): Promise<void> {
  const credentialsPath = getBirdCredentialsPath();
  try {
    // Ensure parent directory exists with 0700
    const credDir = path.dirname(credentialsPath);
    try {
      await fs.mkdir(credDir, { mode: 0o700, recursive: true });
    } catch (err) {
      if ((err as any).code === "EACCES") {
        throw new Error("bird_persistent_path_unavailable");
      }
      throw err;
    }

    // Write atomically: temp + rename
    const tmpPath = `${credentialsPath}.tmp`;
    const content = JSON.stringify(creds);
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
    await fs.rename(tmpPath, credentialsPath);
  } catch (err) {
    if (err instanceof Error && err.message === "bird_persistent_path_unavailable") {
      throw err;
    }
    throw new Error(
      `Failed to write bird credentials: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

/**
 * Read bird credentials from the credential file.
 * Returns null if file does not exist.
 */
export async function readBirdCredentials(): Promise<{
  authMode: string;
  authToken?: string;
  ct0?: string;
} | null> {
  const credentialsPath = getBirdCredentialsPath();
  try {
    const content = await fs.readFile(credentialsPath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    if ((err as any).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Failed to read bird credentials: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

async function verifyBirdSkillContent(): Promise<void> {
  try {
    const stat = await fs.stat(getBirdSkillMdPath());
    if (!stat.isFile()) {
      throw new Error("bird_skill_content_missing");
    }
  } catch {
    throw new Error("bird_skill_content_missing");
  }
}

// ─── Runtime Verification ─────────────────────────────────────────────────

/**
 * Verify bird binary exists and is executable.
 * Checks: $OPENCLAW_STATE_DIR/.iclaw/bin/bird --version
 */
export async function verifyBirdRuntime(): Promise<{
  installed: boolean;
  version?: string;
}> {
  const binPath = getBirdBinPath();
  try {
    const { stdout } = await execFileAsync(binPath, ["--version"], {
      timeout: 5_000,
    });
    // Version output is typically "bird <version>" or similar
    const version = stdout.trim();
    return { installed: true, version };
  } catch (err) {
    // Binary does not exist or failed to run
    return { installed: false };
  }
}

async function ensureBirdOnSystemPath(): Promise<void> {
  const binPath = getBirdBinPath();
  try {
    await fs.unlink("/usr/local/bin/bird").catch(() => {});
    await fs.symlink(binPath, "/usr/local/bin/bird");
  } catch (err) {
    throw new Error(
      `Failed to expose bird on PATH: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

// ─── Dependency Installation ──────────────────────────────────────────────

/**
 * Install the @steipete/bird npm package into $OPENCLAW_STATE_DIR/.iclaw.
 * Then write a wrapper script at $OPENCLAW_STATE_DIR/.iclaw/bin/bird.
 *
 * Throws bird_persistent_path_unavailable if the state dir is not writable.
 * Uses execFileAsync (never sh -c).
 */
export async function installBirdDependency(): Promise<void> {
  const installPrefix = getBirdInstallPrefix();
  const binPath = getBirdBinPath();
  try {
    // Install @steipete/bird into $OPENCLAW_STATE_DIR/.iclaw
    await execFileAsync("npm", [
      "install",
      "--prefix",
      installPrefix,
      "@steipete/bird",
    ], {
      timeout: 120_000,
    });

    // Ensure $installPrefix/bin exists before writing the wrapper
    try {
      await fs.mkdir(`${installPrefix}/bin`, { mode: 0o755, recursive: true });
    } catch (err) {
      if ((err as any).code === "EACCES") {
        throw new Error("bird_persistent_path_unavailable");
      }
      throw err;
    }

    // Write a wrapper shell script (not a symlink) so the binary is always
    // callable via absolute path regardless of PATH env propagation in the
    // skill runner (PATH propagation via skills.update is non-guaranteed in Phase 1).
    const realBin = `${installPrefix}/node_modules/.bin/bird`;
    const wrapperContent = `#!/bin/sh\nexec ${realBin} "$@"\n`;
    const tmpPath = `${binPath}.tmp`;
    try {
      await fs.writeFile(tmpPath, wrapperContent, { mode: 0o755 });
      await fs.rename(tmpPath, binPath);
    } catch (err) {
      if ((err as any).code === "EACCES") {
        throw new Error("bird_persistent_path_unavailable");
      }
      throw err;
    }

    // Guaranteed-PATH symlink: fail hard on error. Production containers run as root
    // so /usr/local/bin is always writable. This ensures `bird` resolves for the
    // skill runner without relying on skills.update PATH propagation (non-guaranteed).
    await ensureBirdOnSystemPath();
  } catch (err) {
    if (err instanceof Error && err.message === "bird_persistent_path_unavailable") {
      throw err;
    }
    throw new Error(
      `Failed to install bird dependency: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

// ─── Bird Skill Setup Orchestration ───────────────────────────────────────

/**
 * Full bird skill setup orchestration.
 * Phases:
 *   1. Validate request (cookies mode: both authToken + ct0 required)
 *   2. Install skill content if missing
 *   3. Check/install bird binary
 *   4. Write credentials
 *   5. Enable skill
 *   6. Verify runtime (bird whoami)
 *   7. Return redacted response
 */
export async function setupBirdSkill(
  req: BirdSetupRequest,
): Promise<BirdSetupResponse> {
  const redacted = redactBirdSecrets(req);
  console.log("[sidecar] Bird setup request received", redacted);

  try {
    // 1. Validate request
    if (req.authMode !== "cookies") {
      throw new Error("Unsupported auth mode");
    }
    if (!req.authToken || !req.ct0) {
      throw new Error("Both authToken and ct0 are required for cookies mode");
    }

    // 2. Install skill content. This is mandatory: without SKILL.md, OpenClaw
    // cannot list or use the skill even if the binary and credentials work.
    console.log("[sidecar] Installing bird skill content...");
    await installSkillFromClawHub(BIRD_CLAWHUB_SLUG);
    await verifyBirdSkillContent();
    const installedSkill = true;

    // 3. Check if bird binary exists; install dependency if missing
    let installedDependency = false;
    const runtimeCheck = await verifyBirdRuntime();
    if (!runtimeCheck.installed) {
      console.log("[sidecar] Installing bird dependency...");
      await installBirdDependency();
      installedDependency = true;
    }
    await ensureBirdOnSystemPath();

    // 4. Write credentials to file
    console.log("[sidecar] Writing bird credentials...");
    await writeBirdCredentials({
      authMode: "cookies",
      authToken: req.authToken,
      ct0: req.ct0,
    });

    // 5. Enable skill via gateway and propagate PATH so OpenClaw skill runner
    //    can resolve the bird binary at the same deterministic path the sidecar uses.
    //    PATH is derived from the Bird binary path, not hardcoded.
    const binPath = getBirdBinPath();
    const binDir = path.dirname(binPath);
    console.log("[sidecar] Enabling bird skill...");
    await updateSkill({
      skillKey: BIRD_CLAWHUB_SLUG,
      enabled: true,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
        AUTH_TOKEN: req.authToken,
        CT0: req.ct0,
      },
    });

    // 6. Verify bird runtime with credentials
    console.log("[sidecar] Verifying bird runtime...");
    let verifyOk = false;
    let verifyMessage = "";
    try {
      const envWithAuth = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        AUTH_TOKEN: req.authToken,
        CT0: req.ct0,
      };
      const { stdout } = await execFileAsync(binPath, [
        "whoami",
        "--plain",
      ], {
        env: envWithAuth,
        timeout: 10_000,
      });
      verifyOk = true;
      verifyMessage = stdout.trim() ? "Bird authentication verified" : "Bird authentication verified";
    } catch {
      // Do not include raw error output — it may contain credential details from the subprocess.
      verifyMessage = "bird_verification_failed";
    }

    // 7. Build response (credentials NEVER included)
    const response: BirdSetupResponse = {
      ok: verifyOk,
      installedSkill,
      installedDependency,
      enabled: true,
      verification: {
        command: "bird whoami --plain",
        ok: verifyOk,
        message: verifyMessage,
      },
    };

    console.log(
      "[sidecar] Bird setup completed",
      redactBirdSecrets(response),
    );
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      "[sidecar] Bird setup failed:",
      redactBirdSecrets({ error: message }),
    );
    throw err;
  }
}
