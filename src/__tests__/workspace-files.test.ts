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

// Set env before importing module under test
vi.stubEnv("OPENCLAW_STATE_DIR", "/data");
vi.stubEnv("OPENCLAW_CONFIG_PATH", "/data/openclaw.json");

import { listWorkspaceFiles } from "../services/workspace-files.js";

describe("workspace-files — SKILLS_DIR uses canonical /data/skills path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // resolveWorkspaceDir: config read fails -> default /data/workspace
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("reads skills from /data/skills (canonical path)", async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (dir === "/data/workspace") return Promise.resolve([]);
      if (dir === "/data/skills") return Promise.resolve(["my-skill"]);
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });

    mockStat.mockImplementation((p: string) => {
      if (p === "/data/skills/my-skill")
        return Promise.resolve({ isDirectory: () => true, isFile: () => false });
      if (p === "/data/skills/my-skill/SKILL.md")
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

  it("tolerates missing /data/skills dir without throwing", async () => {
    mockReaddir.mockImplementation(() => {
      return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });

    const result = await listWorkspaceFiles();
    expect(result.files).toHaveLength(0);
  });
});

describe("workspace-files — CONFIG_PATH respects OPENCLAW_CONFIG_PATH env", () => {
  it("CONFIG_PATH is /data/openclaw.json when env is set", () => {
    // The module sets CONFIG_PATH at module load from process.env.OPENCLAW_CONFIG_PATH.
    // Since we stubbed it to /data/openclaw.json, resolveWorkspaceDir will attempt
    // to read that path. We verify by confirming readFileSync is called with that path.
    let capturedPath: unknown;
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      capturedPath = filePath;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    // Trigger resolveWorkspaceDir through listWorkspaceFiles
    mockReaddir.mockResolvedValue([]);
    return listWorkspaceFiles().then(() => {
      expect(capturedPath).toBe("/data/openclaw.json");
    });
  });
});
