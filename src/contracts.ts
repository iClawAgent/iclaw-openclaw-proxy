/**
 * Sidecar-local type contracts — deliberately inlined to keep this package
 * self-contained with zero external monorepo dependencies.
 */

// ---------------------------------------------------------------------------
// Plan / Quota
// ---------------------------------------------------------------------------

export type MemberPlan = "free_trial" | "plus" | "pro";

export interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  plan: MemberPlan;
  trialExpired?: boolean;
  resetAt?: string;
}

export interface OrchestratorQuotaSyncRequest {
  plan: MemberPlan;
  dailyLimit: number;
  sidecarDailyLimit: number;
  trialExpiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Skills — Install / Remove / Status / Dep-Install
// ---------------------------------------------------------------------------

export interface SkillContentInstallResponse {
  ok: boolean;
  message: string;
  method: "cli_install";
}

export interface SkillContentRemoveResponse {
  ok: boolean;
  message: string;
}

export interface SkillStatusEntry {
  name: string;
  description: string;
  eligible: boolean;
  enabled: boolean | null;
  source: string;
  missing?: {
    bins?: string[];
    env?: string[];
    config?: string[];
  };
  install?: {
    id: string;
    label: string;
    kind: string;
  }[];
}

export interface SkillStatusResponse {
  workspaceDir: string;
  skills: SkillStatusEntry[];
}

export interface SkillDepInstallResponse {
  ok: boolean;
  message: string;
  method: "gateway_rpc" | "fallback_parser";
  warnings?: string[];
  fallbackDetail?: {
    source: "metadata" | "installation_section";
    parsedCommands: string[];
    warnings: string[];
    executionResults: { cmd: string; status: "ok" | "fail"; error?: string }[];
  };
}

// ---------------------------------------------------------------------------
// Workspace Files
// ---------------------------------------------------------------------------

export type WorkspaceFileCategory = "core" | "tools" | "memory" | "skill" | "boot";

export interface WorkspaceFileInfo {
  name: string;
  path: string;
  category: WorkspaceFileCategory;
  sizeBytes: number;
  modifiedAt: string;
  needsReload: boolean;
}

export interface WorkspaceFileListResponse {
  files: WorkspaceFileInfo[];
  workspaceDir: string;
}

export interface WorkspaceFileContentResponse {
  name: string;
  content: string | null;
  sizeBytes: number;
  modifiedAt: string;
  tooLarge: boolean;
  needsReload: boolean;
}

export interface WorkspaceFileWriteResponse {
  ok: boolean;
  needsReload: boolean;
}

export interface WorkspaceGatewayRestartResponse {
  ok: boolean;
  method: string;
}

// ---------------------------------------------------------------------------
// OpenClaw Config + Gateway Status
// ---------------------------------------------------------------------------

export interface OpenclawConfigContentResponse {
  content: string | null;
  sizeBytes: number;
  modifiedAt: string;
  tooLarge: boolean;
}

export interface OpenclawConfigWriteResponse {
  ok: boolean;
}

export interface GatewayStatusResponse {
  running: boolean;
  pids: number[];
}
