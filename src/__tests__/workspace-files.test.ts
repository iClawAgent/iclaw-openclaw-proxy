import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (hoisted so vi.mock factories can reference them) ─────
const { mockReaddir, mockStat, mockReadFile, mockMkdir, mockWriteFile, mockReadFileSync, mockExecFileSync } =
  vi.hoisted(() => ({
    mockReaddir: vi.fn(),
    mockStat: vi.fn(),
    mockReadFile: vi.fn(),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockReadFileSync: vi.fn(),
    mockExecFileSync: vi.fn().mockReturnValue(""),
  }));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: mockReaddir,
    stat: mockStat,
    readFile: mockReadFile,
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

// NOTE: workspace-files.ts evaluates STATE_DIR and CONFIG_PATH at module load time
// (via lib/state-dir.ts), so we cannot vary them per-test via vi.stubEnv after import.
// Tests verify the behavior of the module as loaded. The default state dir is
// /root/.openclaw (Phase 4: /data fallback removed).

import {
  listWorkspaceFiles,
  getGatewayStatus,
  restartGateway,
} from "../services/workspace-files.js";

// The default STATE_DIR when OPENCLAW_STATE_DIR is not set (Phase 4: native root)
const DEFAULT_STATE_DIR = "/root/.openclaw";

describe("workspace-files — SKILLS_DIR derives from OPENCLAW_STATE_DIR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // resolveWorkspaceDir: config read fails -> default ${STATE_DIR}/workspace
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("reads skills from STATE_DIR/skills (derived path)", async () => {
    const skillsDir = `${DEFAULT_STATE_DIR}/skills`;
    const workspaceDir = `${DEFAULT_STATE_DIR}/workspace`;

    mockReaddir.mockImplementation((dir: string) => {
      if (dir === workspaceDir) return Promise.resolve([]);
      if (dir === skillsDir) return Promise.resolve(["my-skill"]);
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });

    mockStat.mockImplementation((p: string) => {
      if (p === `${skillsDir}/my-skill`)
        return Promise.resolve({ isDirectory: () => true, isFile: () => false });
      if (p === `${skillsDir}/my-skill/SKILL.md`)
        return Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: 100,
          mtime: new Date("2026-01-01"),
        });
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });

    const result = await listWorkspaceFiles();
    const skill = result.files.find((f) => f.path.startsWith("skills/"));
    expect(skill).toBeDefined();
    expect(skill!.path).toBe("skills/my-skill/SKILL.md");
    expect(skill!.category).toBe("skill");
  });

  it("tolerates missing STATE_DIR/skills dir without throwing", async () => {
    mockReaddir.mockImplementation(() => {
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });

    const result = await listWorkspaceFiles();
    expect(result.files).toHaveLength(0);
  });

  it("workspaceDir returned uses STATE_DIR as root", async () => {
    mockReaddir.mockResolvedValue([]);
    const result = await listWorkspaceFiles();
    expect(result.workspaceDir).toBe(`${DEFAULT_STATE_DIR}/workspace`);
  });
});

describe("getGatewayStatus — detects the gateway worker across process-name changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports running with the current `openclaw` process name", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === "openclaw") return "63\n";
      throw Object.assign(new Error("no match"), { status: 1 });
    });

    expect(getGatewayStatus()).toEqual({ running: true, pids: [63] });
  });

  it("still matches the legacy truncated `openclaw-gatewa` name", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === "openclaw-gatewa") return "70\n";
      throw Object.assign(new Error("no match"), { status: 1 });
    });

    expect(getGatewayStatus()).toEqual({ running: true, pids: [70] });
  });

  it("dedupes pids when both names resolve to the same process", () => {
    mockExecFileSync.mockReturnValue("63\n");
    expect(getGatewayStatus()).toEqual({ running: true, pids: [63] });
  });

  it("reports not running when pgrep finds nothing", () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("no match"), { status: 1 });
    });

    expect(getGatewayStatus()).toEqual({ running: false, pids: [] });
  });
});

describe("restartGateway — signals the worker across process-name changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SIGUSR1s the gateway found under the current `openclaw` name", async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === "openclaw") return "63\n";
      throw Object.assign(new Error("no match"), { status: 1 });
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(restartGateway()).resolves.toEqual({
      ok: true,
      method: "sigusr1",
    });
    expect(killSpy).toHaveBeenCalledWith(63, "SIGUSR1");

    killSpy.mockRestore();
  });

  it("throws gateway_not_found when no gateway process exists", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("no match"), { status: 1 });
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(restartGateway()).rejects.toThrow("gateway_not_found");
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });
});

describe("workspace-files — CONFIG_PATH respects OPENCLAW_CONFIG_PATH env", () => {
  it("CONFIG_PATH defaults to STATE_DIR/openclaw.json when OPENCLAW_CONFIG_PATH is not set", () => {
    // The module sets CONFIG_PATH at module load from process.env.OPENCLAW_CONFIG_PATH.
    // Since OPENCLAW_CONFIG_PATH is not set in this test env, it falls back to
    // STATE_DIR/openclaw.json. We verify by confirming readFileSync is called with
    // the default-derived path.
    let capturedPath: unknown;
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      capturedPath = filePath;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    // Trigger resolveWorkspaceDir through listWorkspaceFiles
    mockReaddir.mockResolvedValue([]);
    return listWorkspaceFiles().then(() => {
      expect(capturedPath).toBe(`${DEFAULT_STATE_DIR}/openclaw.json`);
    });
  });
});
