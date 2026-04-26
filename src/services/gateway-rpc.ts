import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  SkillContentInstallResponse,
  SkillContentRemoveResponse,
  SkillStatusResponse,
  SkillDepInstallResponse,
} from "../contracts.js";
import { STATE_DIR } from "../lib/state-dir.js";

const execFileAsync = promisify(execFile);

const OPENCLAW_BIN = "openclaw";
const CMD_TIMEOUT_MS = 35_000;
const GATEWAY_PORT = process.env.GATEWAY_PORT ?? "18789";
// CONFIG_PATH: prefer explicit env (belt), fall back to state-dir derivation (suspenders)
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH ?? `${STATE_DIR}/openclaw.json`;

/**
 * Build the env object for every OpenClaw CLI execFileAsync call.
 * Passes both OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH so the CLI
 * sees the correct state root even if $HOME drifts (belt-and-suspenders).
 */
function openclawExecEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_CONFIG_PATH: CONFIG_PATH,
  };
}

/**
 * Read the gateway auth token from the openclaw config file.
 * This is the authoritative source because `openclaw onboard` may generate
 * a token that differs from the OPENCLAW_GATEWAY_TOKEN env var.
 */
function readGatewayTokenFromConfig(): string | undefined {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.gateway?.auth?.token ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Relay a config.patch call to the local OpenClaw gateway via the openclaw CLI.
 *
 * Architecture (IPv6→IPv4 bridge):
 *   Orchestrator ──(IPv6)──► Sidecar:8080 ──(localhost/IPv4)──► Gateway:18789
 *
 * The gateway only binds to IPv4 (0.0.0.0) while IPv6 is used.
 * The sidecar bridges this gap by invoking the openclaw CLI locally,
 * which handles the full WS RPC v3 protocol, device-identity auth,
 * and baseHash management.
 *
 * Token resolution order (first non-empty wins):
 *   1. Config file gateway.auth.token (authoritative after onboard)
 *   2. OPENCLAW_GATEWAY_TOKEN env var
 *   3. Explicit gatewayToken parameter
 */
export async function relayConfigPatch(
  raw: string,
  gatewayToken?: string,
): Promise<unknown> {
  const wsUrl = `ws://127.0.0.1:${GATEWAY_PORT}`;
  const token =
    readGatewayTokenFromConfig() ||
    process.env.OPENCLAW_GATEWAY_TOKEN ||
    gatewayToken;
  if (!token) {
    throw new Error("No gateway token: config file, OPENCLAW_GATEWAY_TOKEN env, and gatewayToken param all empty");
  }

  const baseArgs = ["--url", wsUrl, "--token", token, "--json", "--timeout", String(CMD_TIMEOUT_MS)];

  const getResult = await execFileAsync(
    OPENCLAW_BIN,
    ["gateway", "call", "config.get", ...baseArgs],
    { timeout: CMD_TIMEOUT_MS + 5_000, env: openclawExecEnv() },
  );

  const configData = JSON.parse(getResult.stdout);
  const baseHash: string | undefined = configData.hash;
  if (!baseHash) {
    throw new Error(
      `config.get returned no hash: ${configData.issues?.map((i: { message: string }) => i.message).join("; ") ?? "unknown"}`,
    );
  }

  const params = JSON.stringify({ raw, baseHash });
  const patchResult = await execFileAsync(
    OPENCLAW_BIN,
    ["gateway", "call", "config.patch", "--params", params, ...baseArgs],
    { timeout: CMD_TIMEOUT_MS + 5_000, env: openclawExecEnv() },
  );

  return JSON.parse(patchResult.stdout);
}

// ---------------------------------------------------------------------------
// Skills — Content Install via CLI (Path B)
// ---------------------------------------------------------------------------

const SKILL_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Install a skill from ClawHub by invoking `openclaw skills install <slug>`.
 *
 * The CLI does not support --json; exit code determines success/failure and
 * stdout contains human-readable output assembled into a structured response.
 */
export async function installSkillFromClawHub(
  slug: string,
): Promise<SkillContentInstallResponse> {
  // Identity check: $HOME/.openclaw must resolve (via realpath) to STATE_DIR before
  // invoking the CLI. This confirms the real filesystem path matches the canonical
  // state root — either they are the same directory or a legacy symlink points there.
  // If they diverge (e.g. stale symlink after migration), the CLI may write to the
  // wrong location. Fail fast instead of silently misrouting data.
  const homeOpenClaw = path.join(process.env.HOME ?? "/root", ".openclaw");
  try {
    const real = await fs.realpath(homeOpenClaw);
    if (path.resolve(real) !== path.resolve(STATE_DIR)) {
      throw new Error(
        `symlink_missing: $HOME/.openclaw resolves to ${real}, expected ${STATE_DIR}`,
      );
    }
  } catch (checkErr: unknown) {
    const msg = (checkErr as Error).message ?? String(checkErr);
    if (msg.startsWith("symlink_missing:")) throw checkErr as Error;
    // Path does not exist at all — bootstrap omission; treat same as missing
    throw new Error(`symlink_missing: ${homeOpenClaw} does not exist or is unreachable: ${msg}`);
  }

  try {
    const result = await execFileAsync(
      OPENCLAW_BIN,
      ["skills", "install", "--", slug],
      { timeout: SKILL_INSTALL_TIMEOUT_MS, env: openclawExecEnv() },
    );

    // Canonical skill path is STATE_DIR/skills/<slug>. With STATE_DIR at the
    // native state root ($HOME/.openclaw), $HOME/.openclaw/... writes resolve
    // directly into STATE_DIR. We guard against double-deleting through any
    // residual symlink by checking realpath equality before removal.
    const homeSrc = path.join(
      process.env.HOME ?? "/root",
      ".openclaw",
      "workspace",
      "skills",
      slug,
    );
    const canonicalDst = path.join(STATE_DIR, "skills", slug);

    // Only perform copy+remove if the paths are distinct in the real filesystem
    const homeSrcReal = await fs.realpath(path.dirname(homeSrc)).catch(() => null);
    const canonicalDstReal = path.resolve(canonicalDst);
    const homeSrcResolved = homeSrcReal ? path.join(homeSrcReal, slug) : null;

    if (homeSrcResolved && homeSrcResolved !== canonicalDstReal) {
      try {
        await fs.stat(homeSrc);
        await fs.mkdir(path.dirname(canonicalDst), { recursive: true });
        await fs.cp(homeSrc, canonicalDst, { recursive: true, force: true });
        await fs.rm(homeSrc, { recursive: true, force: true });
      } catch {
        // best-effort; if the CLI wrote directly to STATE_DIR, this is a no-op
      }
    }

    return {
      ok: true,
      message: result.stdout.trim() || "Skill installed",
      method: "cli_install",
    };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? "";
    if (msg.startsWith("symlink_missing:")) throw err as Error;
    const stderr = (err as { stderr?: string }).stderr?.trim() ?? "";
    throw new Error(stderr || "skills_install_failed");
  }
}

// ---------------------------------------------------------------------------
// Skills — Content Remove (Path B)
// ---------------------------------------------------------------------------

export async function removeSkillFromWorkspace(
  slug: string,
): Promise<SkillContentRemoveResponse> {
  const stateDir = STATE_DIR;

  // Remove from canonical skill dir (STATE_DIR/skills/<slug>)
  const canonicalDir = path.join(stateDir, "skills", slug);
  const resolvedCanonical = path.resolve(canonicalDir);
  const allowedSkills = path.resolve(stateDir, "skills");
  if (!resolvedCanonical.startsWith(allowedSkills + "/")) {
    throw new Error("invalid_skill_path: path traversal detected");
  }
  await fs.rm(resolvedCanonical, { recursive: true, force: true });

  // Only remove the $HOME/.openclaw path if it resolves to a different real
  // location (i.e. a legacy symlink is absent or points elsewhere). When
  // STATE_DIR is the native state root, both paths resolve to the same tree
  // and a second rm would be a harmless no-op — but we guard explicitly to
  // avoid double-deleting through any residual symlink configuration.
  const homeDir = path.join(
    process.env.HOME ?? "/root",
    ".openclaw",
    "workspace",
    "skills",
    slug,
  );
  const homeParentReal = await fs.realpath(path.dirname(homeDir)).catch(() => null);
  const homeResolved = homeParentReal ? path.join(homeParentReal, slug) : null;

  if (homeResolved && homeResolved !== resolvedCanonical) {
    await fs.rm(homeDir, { recursive: true, force: true });
  }

  return { ok: true, message: `Skill "${slug}" removed` };
}

// ---------------------------------------------------------------------------
// Skills — Gateway RPC helpers (Path C)
// ---------------------------------------------------------------------------

function buildGatewayBaseArgs(timeoutMs: number): string[] {
  const wsUrl = `ws://127.0.0.1:${GATEWAY_PORT}`;
  const token =
    readGatewayTokenFromConfig() || process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error("No gateway token available");
  return [
    "--url",
    wsUrl,
    "--token",
    token,
    "--json",
    "--timeout",
    String(timeoutMs),
  ];
}

const gatewayEnv = openclawExecEnv;

export async function getSkillsStatus(): Promise<SkillStatusResponse> {
  const timeout = CMD_TIMEOUT_MS;
  const baseArgs = buildGatewayBaseArgs(timeout);
  const result = await execFileAsync(
    OPENCLAW_BIN,
    ["gateway", "call", "skills.status", ...baseArgs],
    { timeout: timeout + 5_000, env: gatewayEnv() },
  );
  const raw = JSON.parse(result.stdout) as SkillStatusResponse;
  return augmentSkillsStatus(raw);
}

// ---------------------------------------------------------------------------
// Skills — Augment gateway status with multi-namespace metadata parsing
// ---------------------------------------------------------------------------
//
// The OpenClaw gateway only parses the "openclaw" metadata namespace and the
// "bins" key.  ClawHub community skills may use alternative namespaces (e.g.
// "clawdbot") and alternative keys (e.g. "commands").  This augmentation
// layer mirrors the PoC logic (skill-dep-fallback-parser.mjs Layer 1) so the
// portal can show the correct Deps button and missing-bin badges.
// ---------------------------------------------------------------------------

const METADATA_LINE_RE = /^metadata:\s*(.+)$/m;
const BIN_REQUIRE_KEYS = ["bins", "commands", "tools", "binaries", "executables"];

function extractBinsFromAllNamespaces(metadataStr: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(metadataStr);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const bins = new Set<string>();
  for (const ns of Object.values(parsed)) {
    if (!ns || typeof ns !== "object") continue;
    const req = (ns as Record<string, unknown>).requires;
    if (!req || typeof req !== "object") continue;
    for (const key of BIN_REQUIRE_KEYS) {
      const arr = (req as Record<string, unknown>)[key];
      if (Array.isArray(arr)) {
        for (const b of arr) {
          if (typeof b === "string" && b.trim()) bins.add(b.trim());
        }
      }
    }
  }
  return [...bins];
}

async function isBinInPath(bin: string): Promise<boolean> {
  try {
    await execFileAsync("which", [bin], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function augmentSkillsStatus(
  response: SkillStatusResponse,
): Promise<SkillStatusResponse> {
  const skills = await Promise.all(
    response.skills.map(async (skill) => {
      const hasBins =
        (skill.missing?.bins && skill.missing.bins.length > 0) ||
        (skill.install && skill.install.length > 0);
      if (hasBins) return skill;

      const filePath = (skill as unknown as Record<string, unknown>)
        .filePath as string | undefined;
      if (!filePath) return skill;

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        return skill;
      }

      const fmMatch = content.match(FRONTMATTER_RE);
      if (!fmMatch) return skill;

      const metaLine = fmMatch[1].match(METADATA_LINE_RE);
      if (!metaLine) return skill;

      const requiredBins = extractBinsFromAllNamespaces(metaLine[1].trim());
      if (requiredBins.length === 0) return skill;

      const missingBins: string[] = [];
      for (const bin of requiredBins) {
        if (!(await isBinInPath(bin))) missingBins.push(bin);
      }

      if (missingBins.length > 0) {
        if (!skill.missing) skill.missing = {};
        skill.missing.bins = [
          ...(skill.missing.bins ?? []),
          ...missingBins,
        ];
      }

      if (INSTALL_SECTION_RE.test(content)) {
        if (!skill.install) skill.install = [];
        skill.install.push({
          id: `fallback:${skill.name}`,
          label: "Install dependencies (via SKILL.md)",
          kind: "fallback",
        });
      }

      return skill;
    }),
  );

  return { ...response, skills };
}

export async function updateSkill(params: {
  skillKey: string;
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
}): Promise<{ ok: boolean; skillKey: string }> {
  const timeout = CMD_TIMEOUT_MS;
  const baseArgs = buildGatewayBaseArgs(timeout);
  const result = await execFileAsync(
    OPENCLAW_BIN,
    [
      "gateway",
      "call",
      "skills.update",
      "--params",
      JSON.stringify(params),
      ...baseArgs,
    ],
    { timeout: timeout + 5_000, env: gatewayEnv() },
  );
  return JSON.parse(result.stdout);
}

export async function installSkillDependency(params: {
  name: string;
  installId: string;
  timeoutMs?: number;
}): Promise<SkillDepInstallResponse> {
  const timeout = params.timeoutMs ?? SKILL_INSTALL_TIMEOUT_MS;
  const baseArgs = buildGatewayBaseArgs(timeout);
  const result = await execFileAsync(
    OPENCLAW_BIN,
    [
      "gateway",
      "call",
      "skills.install",
      "--params",
      JSON.stringify(params),
      ...baseArgs,
    ],
    { timeout: timeout + 5_000, env: gatewayEnv() },
  );
  return { ...JSON.parse(result.stdout), method: "gateway_rpc" };
}

// ---------------------------------------------------------------------------
// Skills — Fallback Parser dependency install (Path D)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const FRONTMATTER_NAME_RE = /^name:\s*["']?(.+?)["']?\s*$/m;

function extractFrontmatterName(content: string): string | undefined {
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) return undefined;
  const nameMatch = fmMatch[1].match(FRONTMATTER_NAME_RE);
  return nameMatch?.[1]?.trim();
}

/**
 * Resolve the SKILL.md path for a given skill key.
 *
 * ClawHub-installed skills may use a slug (e.g. "agent-browser-clawdbot") as
 * the directory name while the SKILL.md frontmatter `name` is different
 * (e.g. "agent-browser").  The gateway status reports the frontmatter name,
 * so we need to handle the mismatch.
 *
 * Strategy:
 *   1. Fast path — check if a directory named exactly `skillKey` exists.
 *   2. Scan — iterate skill directories and match the frontmatter `name`.
 */
async function resolveSkillMdPath(skillKey: string): Promise<string> {
  const stateDir = STATE_DIR;

  const directPath = path.join(stateDir, "skills", skillKey, "SKILL.md");
  try {
    await fs.access(directPath);
    return directPath;
  } catch {
    // name ≠ directory slug — fall through to scan
  }

  const searchDirs = [
    path.join(stateDir, "skills"),
    "/app/skills",
  ];

  for (const dir of searchDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry, "SKILL.md");
      try {
        const head = await fs.readFile(candidate, "utf-8");
        if (extractFrontmatterName(head) === skillKey) return candidate;
      } catch {
        continue;
      }
    }
  }

  throw new Error(
    `SKILL.md not found for skill "${skillKey}" in ${stateDir}/skills or /app/skills`,
  );
}

const KNOWN_CMD_PREFIXES = [
  "apt-get",
  "apt",
  "brew",
  "npm",
  "npx",
  "go",
  "uv",
  "pip",
  "pip3",
  "curl",
  "wget",
];

const INSTALL_SECTION_RE =
  /^#{1,3}\s+install(?:ation)?\b/im;
const CODE_FENCE_RE = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/g;

/**
 * Split a shell command line into [binary, ...args] tokens without invoking a
 * shell.  Handles single- and double-quoted strings; does NOT support variable
 * expansion, pipes, redirects, or command substitution — those constructs are
 * intentionally unsupported to prevent injection.
 */
function parseCommandTokens(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseFallbackInstallCommands(content: string): {
  commands: string[];
  source: "metadata" | "installation_section";
} {
  const commands: string[] = [];

  const match = content.match(INSTALL_SECTION_RE);
  if (match && match.index !== undefined) {
    const sectionStart = match.index + match[0].length;
    const nextHeading = content.slice(sectionStart).search(/^#{1,3}\s/m);
    const section =
      nextHeading >= 0
        ? content.slice(sectionStart, sectionStart + nextHeading)
        : content.slice(sectionStart);

    let fenceMatch: RegExpExecArray | null;
    CODE_FENCE_RE.lastIndex = 0;
    while ((fenceMatch = CODE_FENCE_RE.exec(section)) !== null) {
      const block = fenceMatch[1].trim();
      for (const line of block.split("\n")) {
        const trimmed = line.replace(/^\$\s*/, "").trim();
        if (trimmed && !trimmed.startsWith("#")) {
          commands.push(trimmed);
        }
      }
    }
  }

  return {
    commands,
    source: "installation_section",
  };
}

function sortByExecutionPhase(commands: string[]): string[] {
  const apt: string[] = [];
  const pkgMgr: string[] = [];
  const postInstall: string[] = [];

  for (const cmd of commands) {
    if (cmd.startsWith("apt-get") || cmd.startsWith("apt")) {
      apt.push(cmd);
    } else if (
      KNOWN_CMD_PREFIXES.some(
        (p) => cmd.startsWith(p) && !cmd.startsWith("apt"),
      )
    ) {
      pkgMgr.push(cmd);
    } else {
      postInstall.push(cmd);
    }
  }

  return [...apt, ...pkgMgr, ...postInstall];
}

export async function installSkillDependencyFallback(
  skillKey: string,
): Promise<SkillDepInstallResponse> {
  const skillMdPath = await resolveSkillMdPath(skillKey);
  const content = await fs.readFile(skillMdPath, "utf-8");

  const { commands, source } = parseFallbackInstallCommands(content);
  if (commands.length === 0) {
    return {
      ok: false,
      message: "No install commands found in SKILL.md",
      method: "fallback_parser",
    };
  }

  const warnings: string[] = [];
  const executionResults: {
    cmd: string;
    status: "ok" | "fail";
    error?: string;
  }[] = [];

  const sorted = sortByExecutionPhase(commands);
  for (const cmd of sorted) {
    const tokens = parseCommandTokens(cmd);
    if (tokens.length === 0) {
      warnings.push(`Empty command (skipped): ${cmd}`);
      executionResults.push({ cmd, status: "fail", error: "empty_command" });
      continue;
    }
    const [bin, ...args] = tokens;
    // Check binary name against allowlist — path.basename handles /usr/bin/apt-get → apt-get.
    const binName = path.basename(bin);
    const isKnown = KNOWN_CMD_PREFIXES.includes(binName);
    if (!isKnown) {
      warnings.push(`Command not in whitelist (skipped): ${cmd}`);
      executionResults.push({ cmd, status: "fail", error: "command_not_whitelisted" });
      continue;
    }

    try {
      // Execute without a shell so metacharacters (|, &, $(), etc.) are never
      // interpreted — they become literal arguments to the binary.
      await execFileAsync(bin, args, { timeout: 300_000 });
      executionResults.push({ cmd, status: "ok" });
    } catch (err: unknown) {
      const error = (err as { stderr?: string }).stderr?.trim() ?? "";
      executionResults.push({ cmd, status: "fail", error });
    }
  }

  const allOk = executionResults.every((r) => r.status === "ok");
  return {
    ok: allOk,
    message: allOk
      ? "Dependencies installed via fallback"
      : "Some commands failed",
    method: "fallback_parser",
    warnings: warnings.length > 0 ? warnings : undefined,
    fallbackDetail: {
      source,
      parsedCommands: commands,
      warnings,
      executionResults,
    },
  };
}
