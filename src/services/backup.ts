import { unlink, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { BACKUP_DEFAULTS } from "../backup-contract.js";
import { restartGateway } from "./workspace-files.js";

const DATA_DIR = process.env.OPENCLAW_STATE_DIR ?? "/data";

function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "https:") throw new Error("url_must_be_https");
  const host = parsed.hostname;
  if (
    // IPv4 loopback + private ranges
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("169.254.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // IPv6 loopback, mapped, link-local, and unique-local
    host === "::1" ||
    /^::ffff:/i.test(host) ||               // IPv4-mapped (e.g. ::ffff:127.0.0.1)
    /^fe[89ab][0-9a-f]/i.test(host) ||      // link-local fe80::/10
    /^f[cd][0-9a-f]{2}:/i.test(host)        // unique local fc00::/7
  ) {
    throw new Error("url_not_allowed: private/loopback address");
  }
}

async function runCommand(cmd: string[], timeoutMs = 60_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  
  // Read streams concurrently to avoid blocking the pipe
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

export async function createBackupTarball(backupId: string): Promise<{
  path: string;
  sizeBytes: number;
  checksumSha256: string;
  fileCount: number;
}> {
  const tarPath = `${DATA_DIR}/.backup-${backupId}.tar.gz`;
  const excludeArgs = [
    ...BACKUP_DEFAULTS.excludeDirs.map((d) => `--exclude=${d}`),
    "--exclude=*.sock",
    "--exclude=.backup-*.tar.gz",
  ];

  const { exitCode, stderr } = await runCommand(
    ["nice", "-n", "19", "tar", "-czf", tarPath, ...excludeArgs, "-C", DATA_DIR, "."],
    120_000,
  );
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(`tar create failed with exit code ${exitCode}: ${stderr}`);
  }

  const file = Bun.file(tarPath);
  const sizeBytes = file.size;

  if (sizeBytes > BACKUP_DEFAULTS.maxBackupSizeBytes) {
    await cleanupTempFile(tarPath);
    throw new Error(`backup_too_large: ${sizeBytes} bytes exceeds ${BACKUP_DEFAULTS.maxBackupSizeBytes} limit`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  const reader = file.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  const checksumSha256 = hasher.digest("hex") as string;

  const { stdout: listOut } = await runCommand(["tar", "-tzf", tarPath]);
  const fileCount = listOut.split("\n").filter(Boolean).length;

  return { path: tarPath, sizeBytes, checksumSha256, fileCount };
}

export async function uploadBackup(filePath: string, uploadUrl: string): Promise<void> {
  assertSafeUrl(uploadUrl);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    body: Bun.file(filePath),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload_failed: ${res.status} ${text}`);
  }
}

export async function downloadBackup(downloadUrl: string, backupId: string): Promise<string> {
  assertSafeUrl(downloadUrl);
  const filePath = `${DATA_DIR}/.restore-${backupId}.tar.gz`;
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`download_failed: ${res.status}`);
  }
  await Bun.write(filePath, res);
  return filePath;
}

export async function restoreFromTarball(backupId: string): Promise<void> {
  const envPath = `${DATA_DIR}/.env`;
  const envBackupPath = `${DATA_DIR}/.env.bak`;
  const restorePath = `${DATA_DIR}/.restore-${backupId}.tar.gz`;

  const envExists = await Bun.file(envPath).exists();
  if (envExists) {
    const envContent = await Bun.file(envPath).arrayBuffer();
    await Bun.write(envBackupPath, envContent);
  }

  const entries = await readdir(DATA_DIR);
  for (const entry of entries) {
    if (entry.startsWith(".restore-") || entry === ".env.bak") continue;
    await rm(path.join(DATA_DIR, entry), { recursive: true, force: true });
  }

  const { exitCode: tarCode, stderr: tarStderr } = await runCommand(
    ["nice", "-n", "19", "tar", "-xzf", restorePath, "-C", DATA_DIR],
    120_000,
  );
  if (tarCode !== 0) {
    throw new Error(`tar extract failed with exit code ${tarCode}: ${tarStderr}`);
  }

  if (envExists) {
    const backedUp = await Bun.file(envBackupPath).exists();
    if (backedUp) {
      const envContent = await Bun.file(envBackupPath).arrayBuffer();
      await Bun.write(envPath, envContent);
      await cleanupTempFile(envBackupPath);
    }
  }

  const { exitCode: chownCode } = await runCommand(["chown", "-R", "node:node", DATA_DIR]);
  if (chownCode !== 0) {
    console.warn("[backup] chown failed (non-fatal), exit code:", chownCode);
  }

  await cleanupTempFile(restorePath);

  // After restoring files, we need to restart the gateway process to pick up the new files.
  // We send SIGUSR1 which is the standard way to restart the gateway.
  try {
    await restartGateway();
  } catch (err) {
    console.warn("[backup] Failed to restart gateway after restore:", err);
  }
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    /* file may not exist */
  }
}
