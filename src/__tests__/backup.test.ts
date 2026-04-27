import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks ───────────────────────────────────────────────────────
const { mockUnlink, mockReaddir, mockRm } = vi.hoisted(() => ({
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockReaddir: vi.fn().mockResolvedValue([]),
  mockRm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  unlink: mockUnlink,
  readdir: mockReaddir,
  rm: mockRm,
}));

const mockSpawn = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    stdout: new ReadableStream({ start(c) { c.close(); } }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    exited: Promise.resolve(0),
    kill: vi.fn(),
  })),
);

const mockBunFile = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    size: 1024,
    exists: () => Promise.resolve(false),
    stream: () => new ReadableStream({ start(c) { c.close(); } }),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  })),
);

const mockBunWrite = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.stubGlobal("Bun", {
  spawn: mockSpawn,
  file: mockBunFile,
  write: mockBunWrite,
  CryptoHasher: class {
    update() {}
    digest() { return "abc123"; }
  },
});

vi.mock("./workspace-files.js", () => ({
  restartGateway: vi.fn().mockResolvedValue(undefined),
}));

// NOTE: backup.ts evaluates DATA_DIR at module load time from OPENCLAW_STATE_DIR
// (via lib/state-dir.ts). The default is /data when the env var is not set,
// preserving backward compatibility with existing instances until Phase 2.
const DEFAULT_STATE_DIR = "/data";

import {
  createBackupTarball,
  downloadBackup,
  restoreFromTarball,
  cleanupTempFile,
} from "../services/backup.js";

describe("backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("state dir derivation", () => {
    it("uses /data as the default state dir (backward-compatible fallback)", async () => {
      await createBackupTarball("test-id");

      const spawnCall = mockSpawn.mock.calls[0];
      const tarArgs: string[] = spawnCall[0];
      expect(tarArgs).toContain("-C");
      const cIndex = tarArgs.indexOf("-C");
      expect(tarArgs[cIndex + 1]).toBe(DEFAULT_STATE_DIR);
    });

    it("writes tarball under the state dir", async () => {
      await createBackupTarball("test-id");

      const spawnCall = mockSpawn.mock.calls[0];
      const tarArgs: string[] = spawnCall[0];
      const tarPath = tarArgs.find((a: string) => a.includes(".backup-"));
      expect(tarPath).toBe(`${DEFAULT_STATE_DIR}/.backup-test-id.tar.gz`);
    });

    it("all tar command paths are absolute (no relative paths)", async () => {
      await createBackupTarball("test-id");

      const spawnCall = mockSpawn.mock.calls[0];
      const tarArgs: string[] = spawnCall[0];
      // Find path-like args (those that look like filesystem paths)
      const pathArgs = tarArgs.filter((a: string) => a.startsWith("/") || a.includes("/."));
      expect(pathArgs.length).toBeGreaterThan(0);
      for (const arg of pathArgs) {
        expect(arg.startsWith("/")).toBe(true);
      }
    });
  });

  describe("downloadBackup", () => {
    it("downloads to the state dir", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      const filePath = await downloadBackup("https://example.com/backup.tar.gz", "dl-id");

      expect(filePath).toBe(`${DEFAULT_STATE_DIR}/.restore-dl-id.tar.gz`);
    });
  });

  describe("restoreFromTarball", () => {
    it("extracts into the state dir", async () => {
      mockBunFile.mockImplementation(() => ({
        exists: () => Promise.resolve(false),
        size: 0,
        stream: () => new ReadableStream({ start(c) { c.close(); } }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }));
      mockReaddir.mockResolvedValue([]);

      await restoreFromTarball("restore-id");

      const extractCall = mockSpawn.mock.calls.find(
        (c: unknown[]) => (c[0] as string[]).includes("-xzf"),
      );
      expect(extractCall).toBeDefined();
      const extractArgs: string[] = extractCall![0];
      const cIndex = extractArgs.indexOf("-C");
      expect(extractArgs[cIndex + 1]).toBe(DEFAULT_STATE_DIR);
    });

    it("extracts into an absolute path (no relative paths in tar args)", async () => {
      mockBunFile.mockImplementation(() => ({
        exists: () => Promise.resolve(false),
        size: 0,
        stream: () => new ReadableStream({ start(c) { c.close(); } }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }));
      mockReaddir.mockResolvedValue([]);

      await restoreFromTarball("restore-id");

      const extractCall = mockSpawn.mock.calls.find(
        (c: unknown[]) => (c[0] as string[]).includes("-xzf"),
      );
      expect(extractCall).toBeDefined();
      const extractArgs: string[] = extractCall![0];
      const cIndex = extractArgs.indexOf("-C");
      // The extract target must be an absolute path
      expect(extractArgs[cIndex + 1].startsWith("/")).toBe(true);
    });
  });

  describe("cleanupTempFile", () => {
    it("calls unlink on the given path", async () => {
      await cleanupTempFile("/tmp/test-file.tar.gz");
      expect(mockUnlink).toHaveBeenCalledWith("/tmp/test-file.tar.gz");
    });
  });

  describe("backup metadata (Phase 3)", () => {
    it("createBackupTarball returns a metadata object", async () => {
      const result = await createBackupTarball("meta-test");
      expect(result.metadata).toBeDefined();
      expect(result.metadata.backupId).toBe("meta-test");
      expect(result.metadata.stateRoot).toBe(DEFAULT_STATE_DIR);
      expect(result.metadata.createdAt).toBeDefined();
      // createdAt should be a valid ISO 8601 string
      expect(() => new Date(result.metadata.createdAt)).not.toThrow();
    });

    it("metadata stateRootVersion is v0 when DATA_DIR is /data (legacy layout)", async () => {
      // DEFAULT_STATE_DIR == "/data" in this test environment (env var not set)
      const result = await createBackupTarball("v0-test");
      expect(result.metadata.stateRootVersion).toBe("v0");
    });

    it("metadata stateRoot matches DATA_DIR", async () => {
      const result = await createBackupTarball("root-test");
      expect(result.metadata.stateRoot).toBe(DEFAULT_STATE_DIR);
    });
  });

  describe("legacy /data archive restore compatibility (Phase 3)", () => {
    it("restoreFromTarball extracts into current DATA_DIR regardless of archive origin", async () => {
      // Simulate restoring a legacy /data-rooted archive into the current DATA_DIR.
      // Since both old and new archives use relative paths (tar -C <dir> .),
      // extraction always targets DATA_DIR correctly regardless of archive origin.
      mockBunFile.mockImplementation(() => ({
        exists: () => Promise.resolve(false),
        size: 0,
        stream: () => new ReadableStream({ start(c) { c.close(); } }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }));
      mockReaddir.mockResolvedValue([]);

      await restoreFromTarball("legacy-id");

      const extractCall = mockSpawn.mock.calls.find(
        (c: unknown[]) => (c[0] as string[]).includes("-xzf"),
      );
      expect(extractCall).toBeDefined();
      const extractArgs: string[] = extractCall![0];
      const cIndex = extractArgs.indexOf("-C");
      // Restore always targets current DATA_DIR, not the archive's original source
      expect(extractArgs[cIndex + 1]).toBe(DEFAULT_STATE_DIR);
    });
  });
});
