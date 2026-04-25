import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { installSkillFromClawHub, updateSkill } from "./gateway-rpc.js";

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

// Bird binary and credential paths (Phase 1 — deterministic per-instance)
export const BIRD_BIN_PATH = "/data/.iclaw/bin/bird";
export const BIRD_INSTALL_PREFIX = "/data/.iclaw";
export const BIRD_CREDENTIALS_PATH = "/data/.iclaw/skills/bird/credentials.json";
export const BIRD_CLAWHUB_SLUG = "bird-twitter";
export const BIRD_SKILL_MD_PATH = `/data/skills/${BIRD_CLAWHUB_SLUG}/SKILL.md`;

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
 * File: /data/.iclaw/skills/bird/credentials.json (mode 0600)
 * Parent dir: /data/.iclaw/skills/bird/ (mode 0700)
 *
 * Uses atomic write: temp file + rename.
 * Throws if /data is not writable or not mounted.
 */
export async function writeBirdCredentials(creds: {
  authMode: "cookies";
  authToken: string;
  ct0: string;
}): Promise<void> {
  try {
    // Ensure parent directory exists with 0700
    const credDir = path.dirname(BIRD_CREDENTIALS_PATH);
    try {
      await fs.mkdir(credDir, { mode: 0o700, recursive: true });
    } catch (err) {
      if ((err as any).code === "EACCES") {
        throw new Error("bird_persistent_path_unavailable");
      }
      throw err;
    }

    // Write atomically: temp + rename
    const tmpPath = `${BIRD_CREDENTIALS_PATH}.tmp`;
    const content = JSON.stringify(creds);
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
    await fs.rename(tmpPath, BIRD_CREDENTIALS_PATH);
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
  try {
    const content = await fs.readFile(BIRD_CREDENTIALS_PATH, "utf-8");
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
    const stat = await fs.stat(BIRD_SKILL_MD_PATH);
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
 * Checks: /data/.iclaw/bin/bird --version
 */
export async function verifyBirdRuntime(): Promise<{
  installed: boolean;
  version?: string;
}> {
  try {
    const { stdout } = await execFileAsync(BIRD_BIN_PATH, ["--version"], {
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

// ─── Dependency Installation ──────────────────────────────────────────────

/**
 * Install the @steipete/bird npm package into /data/.iclaw.
 * Then symlink /data/.iclaw/bin/bird from /data/.iclaw/node_modules/.bin/bird.
 *
 * Throws bird_persistent_path_unavailable if /data is not writable.
 * Uses execFileAsync (never sh -c).
 */
export async function installBirdDependency(): Promise<void> {
  try {
    // Install @steipete/bird into /data/.iclaw
    await execFileAsync("npm", [
      "install",
      "--prefix",
      BIRD_INSTALL_PREFIX,
      "@steipete/bird",
    ], {
      timeout: 120_000,
    });

    // Ensure /data/.iclaw/bin exists before writing the wrapper
    try {
      await fs.mkdir(`${BIRD_INSTALL_PREFIX}/bin`, { mode: 0o755, recursive: true });
    } catch (err) {
      if ((err as any).code === "EACCES") {
        throw new Error("bird_persistent_path_unavailable");
      }
      throw err;
    }

    // Write a wrapper shell script (not a symlink) so BIRD_BIN_PATH is always
    // callable via absolute path regardless of PATH env propagation in the
    // skill runner (PATH propagation via skills.update is non-guaranteed in Phase 1).
    const realBin = `${BIRD_INSTALL_PREFIX}/node_modules/.bin/bird`;
    const wrapperContent = `#!/bin/sh\nexec ${realBin} "$@"\n`;
    const tmpPath = `${BIRD_BIN_PATH}.tmp`;
    try {
      await fs.writeFile(tmpPath, wrapperContent, { mode: 0o755 });
      await fs.rename(tmpPath, BIRD_BIN_PATH);
    } catch (err) {
      if ((err as any).code === "EACCES") {
        throw new Error("bird_persistent_path_unavailable");
      }
      throw err;
    }

    // Guaranteed-PATH symlink: fail hard on error. Production containers run as root
    // so /usr/local/bin is always writable. This ensures `bird` resolves for the
    // skill runner without relying on skills.update PATH propagation (non-guaranteed).
    await fs.unlink("/usr/local/bin/bird").catch(() => {});
    await fs.symlink(BIRD_BIN_PATH, "/usr/local/bin/bird");
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

    // 4. Write credentials to file
    console.log("[sidecar] Writing bird credentials...");
    await writeBirdCredentials({
      authMode: "cookies",
      authToken: req.authToken,
      ct0: req.ct0,
    });

    // 5. Enable skill via gateway and propagate PATH so OpenClaw skill runner
    //    can resolve the bird binary at the same deterministic path the sidecar uses.
    console.log("[sidecar] Enabling bird skill...");
    await updateSkill({
      skillKey: BIRD_CLAWHUB_SLUG,
      enabled: true,
      env: { PATH: `/data/.iclaw/bin:${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}` },
    });

    // 6. Verify bird runtime with credentials
    console.log("[sidecar] Verifying bird runtime...");
    let verifyOk = false;
    let verifyMessage = "";
    try {
      const envWithAuth = {
        ...process.env,
        PATH: `${BIRD_BIN_PATH.split("/").slice(0, -1).join("/")}:${process.env.PATH}`,
        AUTH_TOKEN: req.authToken,
        CT0: req.ct0,
      };
      const { stdout, stderr } = await execFileAsync(BIRD_BIN_PATH, [
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
