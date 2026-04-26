/**
 * Resolves OPENCLAW_STATE_DIR at module load time.
 *
 * Default: /data — kept as the backward-compatible fallback until Phase 2
 * explicitly sets OPENCLAW_STATE_DIR=/root/.openclaw in provisioning.
 *
 * Throws at startup if OPENCLAW_STATE_DIR is set but is not an absolute path.
 */

const _raw = process.env.OPENCLAW_STATE_DIR ?? "/data";

if (process.env.OPENCLAW_STATE_DIR && !process.env.OPENCLAW_STATE_DIR.startsWith("/")) {
  throw new Error(
    `OPENCLAW_STATE_DIR must be an absolute path, got: "${process.env.OPENCLAW_STATE_DIR}"`,
  );
}

export const STATE_DIR: string = _raw;
