import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import type {
  WorkspaceFileInfo,
  WorkspaceFileCategory,
  WorkspaceFileListResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileWriteResponse,
  WorkspaceGatewayRestartResponse,
  OpenclawConfigContentResponse,
  OpenclawConfigWriteResponse,
  GatewayStatusResponse,
} from "../contracts.js";
import { STATE_DIR } from "../lib/state-dir.js";
// CONFIG_PATH: prefer explicit env (belt), fall back to state-dir derivation (suspenders)
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH ?? `${STATE_DIR}/openclaw.json`;
const MAX_DISPLAY_BYTES = 512 * 1024; // 512 KB
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MiB

const CATEGORY_MAP: Record<string, WorkspaceFileCategory> = {
  "AGENTS.md": "core",
  "SOUL.md": "core",
  "USER.md": "core",
  "IDENTITY.md": "core",
  "TOOLS.md": "tools",
  "HEARTBEAT.md": "tools",
  "BOOT.md": "tools",
  "MEMORY.md": "memory",
  "BOOTSTRAP.md": "boot",
};

const NEEDS_RELOAD = new Set([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
]);

const SKILLS_DIR = path.join(STATE_DIR, "skills");

export function resolveWorkspaceDir(): string {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    const custom: string | undefined = cfg?.agent?.workspace;
    if (custom) {
      return path.isAbsolute(custom)
        ? custom
        : path.join(STATE_DIR, custom);
    }
  } catch {
    // fall through to default
  }
  return path.join(STATE_DIR, "workspace");
}

function validateFilename(filename: string): void {
  if (!filename || !filename.endsWith(".md")) {
    throw new Error("invalid_filename: must end with .md");
  }
  if (filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    throw new Error("invalid_filename: path separators not allowed");
  }
}

function assertWithinDir(resolvedPath: string, dir: string): void {
  const normalizedDir = path.resolve(dir);
  if (!resolvedPath.startsWith(normalizedDir + "/") && resolvedPath !== normalizedDir) {
    throw new Error("path_traversal: resolved path is outside workspace");
  }
}

export async function listWorkspaceFiles(): Promise<WorkspaceFileListResponse> {
  const workspaceDir = resolveWorkspaceDir();
  const files: WorkspaceFileInfo[] = [];

  try {
    const entries = await fs.readdir(workspaceDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const fullPath = path.join(workspaceDir, entry);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;

      files.push({
        name: entry,
        path: entry,
        category: CATEGORY_MAP[entry] ?? "core",
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        needsReload: NEEDS_RELOAD.has(entry),
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  try {
    const skillEntries = await fs.readdir(SKILLS_DIR);
    for (const slug of skillEntries) {
      const skillDir = path.join(SKILLS_DIR, slug);
      const skillMd = path.join(skillDir, "SKILL.md");
      try {
        const dirStat = await fs.stat(skillDir);
        if (!dirStat.isDirectory()) continue;
        const fileStat = await fs.stat(skillMd);
        if (!fileStat.isFile()) continue;
        files.push({
          name: `${slug}/SKILL.md`,
          path: `skills/${slug}/SKILL.md`,
          category: "skill",
          sizeBytes: fileStat.size,
          modifiedAt: fileStat.mtime.toISOString(),
          needsReload: false,
        });
      } catch {
        // skill dir without SKILL.md — skip
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  files.sort((a, b) => {
    const order: WorkspaceFileCategory[] = ["core", "tools", "memory", "skill", "boot"];
    const diff = order.indexOf(a.category) - order.indexOf(b.category);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  return { files, workspaceDir };
}

export async function readWorkspaceFile(
  filename: string,
): Promise<WorkspaceFileContentResponse> {
  validateFilename(filename);
  const workspaceDir = resolveWorkspaceDir();
  const filePath = path.resolve(workspaceDir, filename);
  assertWithinDir(filePath, workspaceDir);

  const stat = await fs.stat(filePath);

  if (stat.size > MAX_DISPLAY_BYTES) {
    return {
      name: filename,
      content: null,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      tooLarge: true,
      needsReload: NEEDS_RELOAD.has(filename),
    };
  }

  const content = await fs.readFile(filePath, "utf-8");
  return {
    name: filename,
    content,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    tooLarge: false,
    needsReload: NEEDS_RELOAD.has(filename),
  };
}

export async function writeWorkspaceFile(
  filename: string,
  content: string,
): Promise<WorkspaceFileWriteResponse> {
  validateFilename(filename);

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`file_too_large: ${bytes} bytes exceeds 2 MiB limit`);
  }

  const workspaceDir = resolveWorkspaceDir();
  const filePath = path.resolve(workspaceDir, filename);
  assertWithinDir(filePath, workspaceDir);

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");

  return {
    ok: true,
    needsReload: NEEDS_RELOAD.has(filename),
  };
}

function validateSlug(slug: string): void {
  if (!slug || slug.includes("/") || slug.includes("\\") || slug === "." || slug === "..") {
    throw new Error("invalid_slug: skill slug must be a simple directory name");
  }
}

export async function readSkillFile(
  slug: string,
): Promise<WorkspaceFileContentResponse> {
  validateSlug(slug);
  const filePath = path.resolve(SKILLS_DIR, slug, "SKILL.md");
  assertWithinDir(filePath, SKILLS_DIR);

  const stat = await fs.stat(filePath);

  if (stat.size > MAX_DISPLAY_BYTES) {
    return {
      name: `${slug}/SKILL.md`,
      content: null,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      tooLarge: true,
      needsReload: false,
    };
  }

  const content = await fs.readFile(filePath, "utf-8");
  return {
    name: `${slug}/SKILL.md`,
    content,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    tooLarge: false,
    needsReload: false,
  };
}

export async function writeSkillFile(
  slug: string,
  content: string,
): Promise<WorkspaceFileWriteResponse> {
  validateSlug(slug);

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`file_too_large: ${bytes} bytes exceeds 2 MiB limit`);
  }

  const filePath = path.resolve(SKILLS_DIR, slug, "SKILL.md");
  assertWithinDir(filePath, SKILLS_DIR);

  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");

  return { ok: true, needsReload: false };
}

export async function restartGateway(): Promise<WorkspaceGatewayRestartResponse> {
  const pids = findGatewayPids();
  if (pids.length === 0) {
    throw new Error("gateway_not_found: no gateway process running");
  }

  for (const pid of pids) {
    process.kill(pid, "SIGUSR1");
  }

  return { ok: true, method: "sigusr1" };
}

// ---------------------------------------------------------------------------
// OpenClaw Config (openclaw.json) CRUD
// ---------------------------------------------------------------------------

export async function readOpenclawConfig(): Promise<OpenclawConfigContentResponse> {
  const stat = await fs.stat(CONFIG_PATH);

  if (stat.size > MAX_DISPLAY_BYTES) {
    return {
      content: null,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      tooLarge: true,
    };
  }

  const content = await fs.readFile(CONFIG_PATH, "utf-8");
  return {
    content,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    tooLarge: false,
  };
}

export async function writeOpenclawConfig(
  content: string,
): Promise<OpenclawConfigWriteResponse> {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`file_too_large: ${bytes} bytes exceeds 2 MiB limit`);
  }

  await fs.writeFile(CONFIG_PATH, content, "utf-8");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gateway Process Status
// ---------------------------------------------------------------------------

// Process names (comm, capped at 15 chars by the kernel) the OpenClaw gateway
// worker may run under. Current images report `openclaw`; older images reported
// `openclaw-gateway`, truncated to `openclaw-gatewa`. Matching both keeps
// detection correct across an OpenClaw upgrade instead of silently reporting the
// gateway as stopped when only the process name changed.
const GATEWAY_PROCESS_NAMES = ["openclaw", "openclaw-gatewa"];

/**
 * Resolve the PIDs of the running OpenClaw gateway worker(s) by exact process
 * name across every name the gateway is known to use. Returns an empty array
 * when none are running. Shared by getGatewayStatus() (report) and
 * restartGateway() (SIGUSR1) so both survive a process-name change identically.
 */
function findGatewayPids(): number[] {
  const pids = new Set<number>();
  for (const name of GATEWAY_PROCESS_NAMES) {
    try {
      const raw = execFileSync("pgrep", ["-x", name], {
        encoding: "utf-8",
      }).trim();
      for (const line of raw.split("\n").filter(Boolean)) {
        const pid = parseInt(line, 10);
        if (!Number.isNaN(pid)) pids.add(pid);
      }
    } catch {
      // pgrep exits non-zero when no process matches — try the next name.
    }
  }
  return [...pids];
}

export function getGatewayStatus(): GatewayStatusResponse {
  const pids = findGatewayPids();
  return { running: pids.length > 0, pids };
}
