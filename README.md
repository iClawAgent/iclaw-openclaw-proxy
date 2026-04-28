[![DeepWiki](https://img.shields.io/badge/DeepWiki-iClawAgent%2Ficlaw--openclaw--proxy-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==)](https://deepwiki.com/iClawAgent/iclaw-openclaw-proxy)

# iclaw-openclaw-proxy

> **The per-instance runtime companion for [OpenClaw](https://github.com/openclaw/openclaw) AI agents on the [iClawAgent](https://github.com/iClawAgent) platform.**

`iclaw-openclaw-proxy` (internally called the *sidecar*) is a lightweight Bun HTTP server that runs co-located with an OpenClaw gateway process — either in the same  Docker container. It sits between the outside world and OpenClaw and handles three distinct responsibilities:

| Responsibility        | What it does                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM Reverse Proxy** | Intercepts `/v1/*` requests from OpenClaw, enforces per-member daily quotas, injects the LLM API key, and forwards to the configured upstream (OpenAI, Anthropic, or any compatible endpoint)            |
| **Webhook Relay**     | To serve when private network is IPv6-only; OpenClaw's webhook listener binds to IPv4 only. The sidecar (dual-stack via Bun) receives inbound Telegram traffic on IPv6 and relays it to `127.0.0.1:8787` |
| **Admin API**         | An internal `X-Admin-Token`-protected API used by the iClawAgent Orchestrator to rotate credentials, push quota updates, manage workspace files, install skills, and trigger backup/restore              |

---

## Architecture

The sidecar's core role is to be the LLM credential boundary for OpenClaw. OpenClaw is configured to send all LLM requests to the sidecar (`OPENCLAW_LLM_BASE_URL=http://localhost:8080/v1`); the sidecar holds the real API key in memory, enforces quota, and forwards to the upstream provider.

```
OpenClaw Gateway :8787 (IPv4 loopback)
    │  POST /v1/chat/completions
    │  (no auth header — OpenClaw never sees the real key)
    ▼
iclaw-openclaw-proxy :8080        ← this package
    │  quota check
    │  strip incoming auth headers
    │  inject real LLM_API_KEY from memory
    ▼
LLM upstream
    (OpenAI / Anthropic / Google / DeepSeek / Ollama / …)
```

Two secondary responsibilities run on the same port:

```
Orchestrator (IPv6)
    │  POST /admin/*  (X-Admin-Token required)
    ▼
iclaw-openclaw-proxy :8080
    │  rotate-key · quota-sync · config-patch
    │  skills · workspace · backup/restore
    ▼
OpenClaw Gateway (RPC :18789 or process signal)

Gatekeeper (public ingress, IPv6)
    │  Telegram webhook relay
    ▼
iclaw-openclaw-proxy :8080
    │  /* relay (IPv6 → IPv4 loopback bridge)
    ▼
OpenClaw Gateway :8787
```

In production each user gets a dedicated container running `iclaw-openclaw` — a composite Docker image that layers this proxy on top of the upstream OpenClaw image. Because both processes share the same machine's loopback interface, all internal communication stays on `127.0.0.1` and never crosses the network.

---

## Security Design

### 1. Admin API access control

All `/admin/*` routes require an `X-Admin-Token` header. The comparison is **timing-safe** (byte-level XOR — no early exit on mismatch) to prevent timing-oracle attacks:

```
src/middleware/admin-auth.ts
```

Only the iClawAgent Orchestrator service, running on the same private network, is permitted to call the admin API. The token is a high-entropy secret injected at machine start via the `SIDECAR_ADMIN_TOKEN` environment variable — it is never stored on disk.

### 2. LLM API key isolation

LLM API keys (`LLM_API_KEY`) are held **only in process memory** and are never written to the OpenClaw config file (`openclaw.json`) or any other persistent store. This ensures:

- A compromised OpenClaw process cannot read back the key from disk.
- Key rotation (`POST /admin/rotate-key`) is an atomic in-memory swap — no window where a request sees a partial update.
- If the machine is restarted, the Orchestrator re-injects the key before marking the instance as ready.

### 3. Per-member quota enforcement

Quotas are enforced **at the proxy layer** before a request reaches OpenClaw or the LLM upstream. The Orchestrator pushes authoritative daily limits and trial expiry dates via `POST /admin/quota-sync`. Between restarts, a configurable `SIDECAR_FALLBACK_DAILY_LIMIT` (default: unlimited) covers the cold-start window.

The quota store is purely in-memory — one entry per member ID, one process per user, so there is no shared state or race condition.

### 4. SSRF prevention (backup/restore)

Backup upload and download URLs — supplied by the Orchestrator — are validated by `assertSafeUrl()` before any outbound request is made:

- Protocol must be `https`
- IPv4 loopback (`127.x.x.x`), link-local (`169.254.x.x`), and all RFC-1918 ranges (`10/8`, `172.16/12`, `192.168/16`) are blocked
- IPv6 loopback (`::1`), IPv4-mapped (`::ffff:`), link-local (`fe80::/10`), and unique-local (`fc00::/7`) are blocked

### 5. Path traversal prevention

All workspace file and skill CRUD endpoints validate filenames and slugs before resolving paths:

- Filenames must end in `.md` and must not contain `/`, `\`, `.`, or `..`
- Skill slugs must match `^[a-zA-Z0-9][a-zA-Z0-9_-]+$`
- Every resolved path is asserted to be within its allowed directory (`assertWithinDir`)

### 6. Skill dependency installer — no shell

The fallback skill dependency installer parses `## Installation` code fences from `SKILL.md` and executes commands via `execFileAsync(bin, args)` — **never via `/bin/sh -c`**. Shell metacharacters (`|`, `&`, `;`, `$()`) become literal arguments to the binary and are never interpreted. An explicit allowlist (`apt-get`, `npm`, `curl`, `pip`, etc.) further restricts which binaries may be invoked.

---

## Requirements

- **Runtime:** [Bun](https://bun.sh) ≥ 1.0
- **OS:** Linux (uses `pgrep`, `tar`, `nice`, `chown`)
- **Co-located process:** OpenClaw gateway on `127.0.0.1:8787` (webhook) and `127.0.0.1:18789` (RPC)

---

## Environment Variables

### Required

| Variable              | Description                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| `MEMBER_ID`           | Unique identifier for the member who owns this instance                               |
| `SIDECAR_ADMIN_TOKEN` | Secret token for `X-Admin-Token` admin API authentication                             |
| `LLM_API_KEY`         | API key forwarded to the LLM upstream (not required when `LLM_AUTH_MODE=codex_oauth`) |

### Optional

| Variable                       | Default                  | Description                                                                                  |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| `PORT`                         | `8080`                   | Port the sidecar HTTP server binds to                                                        |
| `LLM_BASE_URL`                 | `https://api.openai.com` | LLM upstream base URL                                                                        |
| `LLM_PROVIDER`                 | `openai`                 | Provider name; use `anthropic` to send `x-api-key` header instead of `Authorization: Bearer` |
| `LLM_AUTH_MODE`                | `platform`               | Auth mode: `platform` (API key) or `codex_oauth` (OpenAI Codex OAuth)                        |
| `OPENCLAW_STATE_DIR`           | `/root/.openclaw`        | Path to OpenClaw's persistent state directory                                                |
| `OPENCLAW_CONFIG_PATH`         | `$OPENCLAW_STATE_DIR/openclaw.json` | Explicit path to the OpenClaw config file; overrides the state-dir-derived default |
| `OPENCLAW_WEBHOOK_PORT`        | `8787`                   | Port of the OpenClaw gateway webhook listener                                                |
| `GATEWAY_PORT`                 | `18789`                  | Port of the OpenClaw gateway RPC listener                                                    |
| `OPENCLAW_GATEWAY_TOKEN`       | —                        | Gateway RPC auth token (read from `openclaw.json` first; env var is the fallback)            |
| `SIDECAR_FALLBACK_DAILY_LIMIT` | `-1`                     | Quota limit before Orchestrator pushes an authoritative sync (`-1` = unlimited)              |

### State Root Invariant

At runtime, `$HOME/.openclaw` (`/root/.openclaw` for the current root-runtime image) is the persistent volume mount point — a real directory, not a symlink. The volume is mounted directly at the native OpenClaw state root since Phase 2 of the state root migration. The legacy `$HOME/.openclaw -> /data` symlink approach was removed because OpenClaw's exec-approvals guard refuses to traverse symlinked parent directories. Both `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` are passed explicitly on every CLI `execFile` call.

---

## Running Locally

### Option A — docker-compose (OpenClaw + Proxy together)

The proxy and OpenClaw must share the same loopback interface. The compose file below uses `network_mode: "service:openclaw"` so the proxy container joins OpenClaw's network namespace, making `127.0.0.1` point to the same loopback.

```bash
cp .env.example .env   # fill in your values
docker compose up
```

See [docker-compose.yml](./docker-compose.yml) and [.env.example](./.env.example) for details.

The proxy will be reachable at `http://localhost:8080`. Send a test request:

```bash
# Health check
curl http://localhost:8080/health

# LLM proxy (forwarded to your configured upstream)
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

### Option B — standalone (Bun)

```bash
bun install
MEMBER_ID=local SIDECAR_ADMIN_TOKEN=dev LLM_API_KEY=sk-... bun run dev
```

---

## Building the Composite Image

In production, the proxy is layered on top of an OpenClaw base image:

```bash
docker build \
  --build-arg OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:<VERSION> \
  -t ghcr.io/iclawagent/iclaw-openclaw:oc.<MMDD>.proxy.<MMDD> \
  -f Dockerfile .
```

---

## API Reference

### Public endpoints

| Method | Path                   | Description                                               |
| ------ | ---------------------- | --------------------------------------------------------- |
| `GET`  | `/health`              | Health check — returns `{ status: "healthy", timestamp }` |
| `POST` | `/v1/chat/completions` | Quota-gated LLM proxy                                     |
| `ALL`  | `/v1/*`                | Pass-through LLM proxy (no quota)                         |
| `ALL`  | `/*`                   | Webhook relay to OpenClaw gateway                         |

### Admin endpoints (`X-Admin-Token` required)

**Credentials & configuration**

| Method | Path                   | Description                                               |
| ------ | ---------------------- | --------------------------------------------------------- |
| `POST` | `/admin/rotate-key`    | Hot-swap LLM API key and optional upstream URL            |
| `POST` | `/admin/set-provider`  | Switch LLM provider and upstream URL                      |
| `POST` | `/admin/set-auth-mode` | Switch between `platform` and `codex_oauth` auth modes    |
| `POST` | `/admin/config-patch`  | Relay a JSON config patch to the OpenClaw gateway via RPC |
| `GET`  | `/admin/config`        | Read raw `openclaw.json`                                  |
| `PUT`  | `/admin/config`        | Write raw `openclaw.json`                                 |

**Quota**

| Method | Path                  | Description                                |
| ------ | --------------------- | ------------------------------------------ |
| `POST` | `/admin/quota-sync`   | Push authoritative quota from Orchestrator |
| `GET`  | `/admin/quota-status` | Return current in-memory quota state       |

**Codex OAuth**

| Method   | Path                            | Description                                                   |
| -------- | ------------------------------- | ------------------------------------------------------------- |
| `POST`   | `/admin/activate-codex-oauth`   | Store tokens + write `auth-profiles.json` + set default model |
| `POST`   | `/admin/deactivate-codex-oauth` | Clear tokens + restore previous model                         |
| `POST`   | `/admin/codex-oauth-tokens`     | Store OAuth tokens in memory and on disk                      |
| `DELETE` | `/admin/codex-oauth-tokens`     | Clear OAuth tokens                                            |
| `GET`    | `/admin/codex-oauth-status`     | Return OAuth connection state                                 |

**Skills**

| Method   | Path                        | Description                                           |
| -------- | --------------------------- | ----------------------------------------------------- |
| `POST`   | `/admin/skills/install`     | Install a skill from ClawHub by slug                  |
| `DELETE` | `/admin/skills/uninstall`   | Remove a skill from the workspace                     |
| `GET`    | `/admin/skills/status`      | Query skill status via gateway RPC                    |
| `PATCH`  | `/admin/skills/update`      | Update skill config via gateway RPC                   |
| `POST`   | `/admin/skills/dep-install` | Install skill dependencies (RPC with fallback parser) |

**Workspace files**

| Method | Path                               | Description                   |
| ------ | ---------------------------------- | ----------------------------- |
| `GET`  | `/admin/workspace/files`           | List workspace Markdown files |
| `GET`  | `/admin/workspace/files/:filename` | Read a workspace file         |
| `PUT`  | `/admin/workspace/files/:filename` | Write a workspace file        |
| `GET`  | `/admin/workspace/skills/:slug`    | Read a skill's `SKILL.md`     |
| `PUT`  | `/admin/workspace/skills/:slug`    | Write a skill's `SKILL.md`    |

**Gateway process**

| Method | Path                     | Description                                    |
| ------ | ------------------------ | ---------------------------------------------- |
| `POST` | `/admin/gateway/restart` | Send `SIGUSR1` to the OpenClaw gateway process |
| `GET`  | `/admin/gateway/status`  | Check whether the gateway process is running   |

**Backup & restore**

| Method | Path             | Description                                                                             |
| ------ | ---------------- | --------------------------------------------------------------------------------------- |
| `POST` | `/admin/backup`  | Create a gzip tarball of `OPENCLAW_STATE_DIR` and upload to a signed URL                |
| `POST` | `/admin/restore` | Download a tarball from a signed URL, verify checksum, extract, and restart the gateway |

---

## License

MIT — see [LICENSE](./LICENSE).
