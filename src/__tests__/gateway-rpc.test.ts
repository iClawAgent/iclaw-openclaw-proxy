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

// NOTE: gateway-rpc.ts evaluates STATE_DIR at module load time (via lib/state-dir.ts).
// vi.stubEnv is NOT applied before ESM module evaluation in vitest (imports are hoisted).
// Tests use the effective module-load-time default: STATE_DIR=/root/.openclaw
// (Phase 4: /data fallback removed).
// The HOME stub is still useful for constructing expected $HOME paths.
vi.stubEnv("HOME", "/root");

import {
  installSkillFromClawHub,
  removeSkillFromWorkspace,
} from "../services/gateway-rpc.js";

// The default STATE_DIR when OPENCLAW_STATE_DIR is not set in test env (Phase 4: native root).
const STATE_DIR = "/root/.openclaw";
const CONFIG_PATH = `${STATE_DIR}/openclaw.json`;

describe("openclawExecEnv — every CLI call receives both env vars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: symlink is valid — $HOME/.openclaw resolves to STATE_DIR
    mockFsRealpath.mockResolvedValue(STATE_DIR);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  it("installSkillFromClawHub passes OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH to execFileAsync", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "installed", stderr: "" });
    // Symlink resolves to STATE_DIR
    mockFsRealpath
      .mockResolvedValueOnce(STATE_DIR)   // realpath of $HOME/.openclaw for symlink check
      .mockResolvedValueOnce(`${STATE_DIR}/workspace/skills`); // realpath of homeSrc parent

    await installSkillFromClawHub("my-skill");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "openclaw",
      ["skills", "install", "--", "my-skill"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_CONFIG_PATH: CONFIG_PATH,
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
      .mockResolvedValueOnce(STATE_DIR)   // symlink check
      .mockResolvedValueOnce(`${STATE_DIR}/workspace/skills`); // homeSrc parent

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
    // With symlink active, $HOME/.openclaw/workspace/skills resolves to STATE_DIR/workspace/skills
    // and STATE_DIR/skills is the canonical target — different dirs so normally copy happens.
    // When homeSrc parent resolves to canonical skills dir, skip copy.
    mockFsRealpath
      .mockResolvedValueOnce(STATE_DIR)              // symlink check (HOME/.openclaw -> STATE_DIR)
      .mockResolvedValueOnce(`${STATE_DIR}/skills`); // homeSrc parent = same as canonicalDst parent

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
    // homeParentReal = STATE_DIR/skills (same as canonical STATE_DIR/skills)
    mockFsRealpath.mockResolvedValue(`${STATE_DIR}/skills`);
    mockFsRm.mockResolvedValue(undefined);

    await removeSkillFromWorkspace("my-skill");

    // Should only rm the canonical path once
    expect(mockFsRm).toHaveBeenCalledOnce();
    expect(mockFsRm).toHaveBeenCalledWith(
      expect.stringContaining(`${STATE_DIR}/skills/my-skill`),
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
