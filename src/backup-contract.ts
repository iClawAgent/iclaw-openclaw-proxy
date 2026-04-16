/**
 * Sidecar backup/restore contract types and defaults.
 */
export const BACKUP_DEFAULTS = {
  maxBackupSizeBytes: 200 * 1024 * 1024, // 200 MB
  excludeDirs: ["cache", "completions", "debug-proxy"],
} as const;

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
