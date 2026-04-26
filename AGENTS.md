# iclaw-openclaw-proxy Agent Guide

# iclaw-openclaw Image Build & Upgrade

## Image Architecture

The `iclaw-openclaw` image is a **two-layer composite** published to GitHub Container Registry:

1. **Base layer** - upstream OpenClaw from GHCR (`ghcr.io/openclaw/openclaw:<version>`)
2. **Sidecar layer** - Bun + pnpm + `@iclawagent/iclaw-openclaw-proxy` (sidecar)

Build file: `iclawagent-app/Dockerfile.openclaw-sidecar`
Registry: `ghcr.io/iclawagent/iclaw-openclaw`

## Tag Naming Convention

Format: `iclaw-openclaw:oc.MMDD.sidecar.MMDD`

- `oc.MMDD` - OpenClaw version mapped from upstream version number
  - `2026.3.24` -> `oc.0324` (month=03, day=24)
  - `2026.4.5` -> `oc.0405`
- `sidecar.MMDD` - sidecar build date (month+day when the composite image was built)
  - Built on March 29 -> `sidecar.0329`

Full example: `ghcr.io/iclawagent/iclaw-openclaw:oc.0324.sidecar.0329`

## Build Prerequisites

- Docker-compatible builder available locally
- GHCR authentication with a GitHub Username and PAT that has `write:packages` and `read:packages`

**AGENT INSTRUCTION:** Before attempting any `docker` operation that pushes to GHCR, ask the user to provide their GitHub Username and PAT.

## Verify OpenClaw Base Image

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:openclaw/openclaw:pull" \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
curl -sI -H "Authorization: Bearer $TOKEN" \
  "https://ghcr.io/v2/openclaw/openclaw/manifests/<VERSION>" | head -1
```

Expected: `HTTP/2 200`

## Build & Push to GHCR

```bash
echo "<GITHUB_PAT>" | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin

cd iclawagent-app
docker build --platform linux/amd64 -f Dockerfile.openclaw-sidecar \
  --build-arg OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:<VERSION> \
  -t ghcr.io/iclawagent/iclaw-openclaw:oc.<MMDD>.sidecar.<MMDD> \
  -t ghcr.io/iclawagent/iclaw-openclaw:latest \
  --push .
```

Key points:
- `--platform linux/amd64` - build for the Zeabur runtime target
- `--build-arg OPENCLAW_BASE_IMAGE=...` - override the base OpenClaw version
- `-t ghcr.io/iclawagent/iclaw-openclaw:oc.<MMDD>.sidecar.<MMDD>` - immutable release tag
- `-t ghcr.io/iclawagent/iclaw-openclaw:latest` - convenience tag for the newest image

## Verify Push

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:iclawagent/iclaw-openclaw:pull" \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://ghcr.io/v2/iclawagent/iclaw-openclaw/tags/list" | python3 -m json.tool
```

Confirm the new tag appears in the list.

## Upgrade an Instance

Use Backoffice UI for normal upgrades. The orchestrator also exposes `POST /instances/:id/upgrade` with body:

```json
{ "imageRef": "ghcr.io/iclawagent/iclaw-openclaw:oc.MMDD.sidecar.MMDD" }
```

## Updating the Default Base Image

When upgrading to a new OpenClaw version, update the default in `Dockerfile.openclaw-sidecar` line 1:

```dockerfile
ARG OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:<NEW_VERSION>
```

Also update the `OPENCLAW_IMAGE_REF` secret in orchestrator for new machine provisioning.

## Verification After Upgrade

Use the Backoffice Instances page to confirm the target image is applied and the upgrade reaches `DONE`.

If direct instance access is available, verify:
- OpenClaw version: `node openclaw.mjs --version`
- Skills install path works: installed skill appears under `$OPENCLAW_STATE_DIR/skills/<slug>/SKILL.md` (Phase 1 default: `/data/skills/`; Phase 2 target: `/root/.openclaw/skills/`). Verify `$HOME/.openclaw` is a real directory, not a symlink.
- Gateway health responds at `http://localhost:18789/health`

## Rollback

Use the same Backoffice UI or orchestrator upgrade flow with the previous GHCR image reference.

# OpenClaw Integration

## Config File

- Path on container: `$OPENCLAW_STATE_DIR/openclaw.json` (Phase 1 default: `/data/openclaw.json`; Phase 2 target: `/root/.openclaw/openclaw.json`)
- State dir env: `OPENCLAW_STATE_DIR=/data` (Phase 1 default; Phase 2 will change to `/root/.openclaw` when provisioning mounts the volume at native root)

## Key Config Gotchas

```jsonc
{
  "gateway": {
    "controlUi": {
      // Required when binding to non-loopback (LAN mode)
      "dangerouslyAllowHostHeaderOriginFallback": true
    },
    "auth": { "mode": "token", "token": "<OPENCLAW_GATEWAY_TOKEN>" }
  },
  "channels": {
    "telegram": {
      "webhookHost": "::",
      "webhookPort": 8787,
      "webhookPath": "/telegram-webhook"
    }
  }
}
```

## Model Registry
Model names change across OpenClaw versions. Always verify.
Use `openai-codex/` prefix for Codex OAuth models. Check available models before setting `agents.defaults.model`.

## WebSocket RPC

- Valid `client.id`: `cli`, `ui`, `webchat`, `backend`, `node`, `probe`, `test`
- Valid `client.mode`: same as `client.id`
- Full operator scopes require device identity + keypair signing (not just token auth)
