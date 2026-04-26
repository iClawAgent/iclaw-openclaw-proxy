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
// Tests verify the behavior of the module as loaded. The default state dir is /data,
// which is the backward-compatible fallback until Phase 2 sets OPENCLAW_STATE_DIR
// explicitly in provisioning.

import { listWorkspaceFiles } from "../services/workspace-files.js";

// The default STATE_DIR when OPENCLAW_STATE_DIR is not set
const DEFAULT_STATE_DIR = "/data";

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
