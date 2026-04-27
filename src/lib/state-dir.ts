/**
 * Resolves OPENCLAW_STATE_DIR at module load time.
 *
 * Default: /root/.openclaw — the native OpenClaw state root for the current
 * root-runtime composite image. Phase 4: /data fallback removed.
 *
 * Throws at startup if OPENCLAW_STATE_DIR is set but is not an absolute path.
 */

const _raw = process.env.OPENCLAW_STATE_DIR ?? "/root/.openclaw";

if (process.env.OPENCLAW_STATE_DIR && !process.env.OPENCLAW_STATE_DIR.startsWith("/")) {
  throw new Error(
    `OPENCLAW_STATE_DIR must be an absolute path, got: "${process.env.OPENCLAW_STATE_DIR}"`,
  );
}

export const STATE_DIR: string = _raw;
