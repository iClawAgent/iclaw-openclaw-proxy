import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (hoisted) ────────────────────────────────────────────
const { mockExecFileAsync, mockFsRealpath, mockFsStat, mockFsMkdir, mockFsCp, mockFsRm, mockReadFileSync } =
  vi.hoisted(() => ({
    mockExecFileAsync: vi.fn(),
    mockFsRealpath: vi.fn(),
    mockFsStat: vi.fn(),
    mockFsMkdir: vi.fn(),
    mockFsCp: vi.fn(),
    mockFsRm: vi.fn(),
    mockReadFileSync: vi.fn(),
  }));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    realpath: mockFsRealpath,
    stat: mockFsStat,
    mkdir: mockFsMkdir,
    cp: mockFsCp,
    rm: mockFsRm,
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(""),
    access: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

// Set env before importing module under test
vi.stubEnv("OPENCLAW_STATE_DIR", "/data");
vi.stubEnv("OPENCLAW_CONFIG_PATH", "/data/openclaw.json");
vi.stubEnv("HOME", "/root");

import {
  installSkillFromClawHub,
  removeSkillFromWorkspace,
} from "../services/gateway-rpc.js";

describe("openclawExecEnv — every CLI call receives both env vars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: symlink is valid
    mockFsRealpath.mockResolvedValue("/data");
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  it("installSkillFromClawHub passes OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH to execFileAsync", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "installed", stderr: "" });
    // Symlink resolves to /data
    mockFsRealpath
      .mockResolvedValueOnce("/data")   // realpath of $HOME/.openclaw for symlink check
      .mockResolvedValueOnce("/data/workspace/skills"); // realpath of homeSrc parent

    await installSkillFromClawHub("my-skill");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "openclaw",
      ["skills", "install", "--", "my-skill"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: "/data",
          OPENCLAW_CONFIG_PATH: "/data/openclaw.json",
        }),
      }),
    );
  });
});

describe("installSkillFromClawHub — symlink safety check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  it("throws symlink_missing when $HOME/.openclaw does not exist", async () => {
    mockFsRealpath.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(installSkillFromClawHub("my-skill")).rejects.toThrow("symlink_missing:");
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("throws symlink_missing when $HOME/.openclaw resolves to a different path", async () => {
    mockFsRealpath.mockResolvedValue("/root/.openclaw-stale");

    await expect(installSkillFromClawHub("my-skill")).rejects.toThrow("symlink_missing:");
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("proceeds with install when symlink resolves to STATE_DIR", async () => {
    mockFsRealpath
      .mockResolvedValueOnce("/data")   // symlink check
      .mockResolvedValueOnce("/data/workspace/skills"); // homeSrc parent

    mockExecFileAsync.mockResolvedValue({ stdout: "installed", stderr: "" });

    const result = await installSkillFromClawHub("my-skill");
    expect(result.ok).toBe(true);
    expect(mockExecFileAsync).toHaveBeenCalledOnce();
  });
});

describe("installSkillFromClawHub — does not delete through symlink into canonical tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  it("skips copy+remove when homeSrc and canonicalDst resolve to the same real path", async () => {
    // With symlink active, $HOME/.openclaw/workspace/skills resolves to /data/workspace/skills
    // and /data/skills resolves to /data/skills — different, so copy happens.
    // When they are the same (e.g. canonical changed to /data/workspace/skills), skip.
    mockFsRealpath
      .mockResolvedValueOnce("/data")          // symlink check (HOME/.openclaw -> /data)
      .mockResolvedValueOnce("/data/skills");   // homeSrc parent = same as canonicalDst parent

    mockExecFileAsync.mockResolvedValue({ stdout: "installed", stderr: "" });

    await installSkillFromClawHub("my-skill");

    // fs.cp and fs.rm should NOT be called when paths resolve to the same location
    expect(mockFsCp).not.toHaveBeenCalled();
    expect(mockFsRm).not.toHaveBeenCalled();
  });
});

describe("removeSkillFromWorkspace — does not double-delete through symlink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips home-dir rm when it resolves to the same canonical path", async () => {
    // homeParentReal = /data/skills (same as canonical /data/skills)
    mockFsRealpath.mockResolvedValue("/data/skills");
    mockFsRm.mockResolvedValue(undefined);

    await removeSkillFromWorkspace("my-skill");

    // Should only rm the canonical path once
    expect(mockFsRm).toHaveBeenCalledOnce();
    expect(mockFsRm).toHaveBeenCalledWith(
      expect.stringContaining("/data/skills/my-skill"),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("removes home-dir separately when it resolves to a different real path", async () => {
    // homeParentReal differs from canonicalDst parent — old behaviour, no symlink
    mockFsRealpath.mockResolvedValue("/root/.openclaw/workspace/skills");
    mockFsRm.mockResolvedValue(undefined);

    await removeSkillFromWorkspace("my-skill");

    expect(mockFsRm).toHaveBeenCalledTimes(2);
  });
});
