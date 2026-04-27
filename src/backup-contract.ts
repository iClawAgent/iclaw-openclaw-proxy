/**
 * Sidecar backup/restore contract types and defaults.
 */
export const BACKUP_DEFAULTS = {
  maxBackupSizeBytes: 200 * 1024 * 1024, // 200 MB
  excludeDirs: ["cache", "completions", "debug-proxy"],
  /** Current layout version. v1 = native state root (/root/.openclaw). */
  currentStateRootVersion: "v1" as const,
  /**
   * @deprecated Historical: the legacy state root used before Phase 2.
   * Kept for restore compatibility when extracting old backup archives rooted at /data.
   * Do not use as a default or active state root path.
   */
  legacyStateRoot: "/data" as const,
} as const;

/**
 * Metadata written alongside a backup tarball as `.iclaw-backup-meta.json`.
 * Used by restore to detect archive layout (legacy /data vs native root).
 */
export interface BackupMetadata {
  /** The value of OPENCLAW_STATE_DIR at backup time. */
  stateRoot: string;
  /**
   * Layout version:
   *   "v0" — legacy /data layout (created before Phase 2)
   *   "v1" — native state root layout (/root/.openclaw or OPENCLAW_STATE_DIR)
   */
  stateRootVersion: "v0" | "v1";
  /** ISO 8601 timestamp when the backup was created. */
  createdAt: string;
  /** Backup ID passed by the caller. */
  backupId: string;
}

export interface SidecarBackupRequest {
  uploadUrl: string;
  backupId: string;
}

export interface SidecarBackupResponse {
  ok: boolean;
  sizeBytes: number;
  checksumSha256: string;
  fileCount: number;
  durationMs: number;
  metadata?: BackupMetadata;
}

export interface SidecarRestoreRequest {
  downloadUrl: string;
  backupId: string;
  expectedChecksum?: string;
}

export interface SidecarRestoreResponse {
  ok: boolean;
  restoredAt: string;
  durationMs: number;
}
