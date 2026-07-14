# SAGA / GPU Arbiter — Environment Variables (canonical registry)

The single authoritative list of every environment variable this work introduces or reuses.
If a variable is not in this file, SAGA/arbiter code does not read it. Every entry names its exact
consumer (file), its default, and when a change takes effect. The three **new** variables are set in
`ecosystem.config.js` (committed — not "add it yourself" instructions).

## New variables (introduced by SAGA + GPU arbiter)

| Variable | Default (if unset) | Consumer | Purpose | Change takes effect |
|---|---|---|---|---|
| `SAGA_ROOT` | `/mnt/nvme_tugrrstorage2/Dina/SAGA` | `src/modules/saga/core/storagePaths.ts` (constructor) | Absolute root of all SAGA storage (models, tenants, tmp, engine, backups). Must be an absolute path or `StoragePaths` throws at init. | pm2 reload |
| `DINA_GPU_ARBITER` | `off` | `src/modules/llm/manager.ts` (`arbiterEnabled()`, read per call), `src/api/routes/index.ts` (debug route) | Master enforcement switch. `off` = dark launch: arbiter registered, zero request-path change (byte-identical behaviour). `on` = every Ollama call takes a shared lease; SAGA renders take exclusive leases. **This is also the rollback lever** — flip to `off` + reload reverts instantly. | pm2 reload |
| `DINA_GPU_RESERVE_MB` | `512` | `src/core/orchestrator/index.ts` (arbiter `configure()` at startup) | Headroom the arbiter always keeps free inside the VRAM budget so a grant never rides the edge of the card. | pm2 **restart** (read once at startup) |

## Existing variables reused by the new code (unchanged semantics)

| Variable | Default | Reused by | Why |
|---|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | `src/modules/gpu/engines/ollamaEngine.ts` | where drain/restore talks to Ollama (same daemon the LLM stack uses) |
| `DINA_CHAT_MODEL` | `qwen2.5:3b` | `ollamaEngine.ts` | which model to re-warm after an exclusive render releases |
| `DINA_KEEP_ALIVE` | `24h` | `ollamaEngine.ts` | keep_alive used for the post-render re-warm (matches llmConfig) |
| `DINA_VRAM_BUDGET_MB` | `22000` | via `getLlmConfig()` → arbiter `configure()` in the orchestrator | one budget number shared by the LLM guardrail and the arbiter — they can never disagree |

Everything else (`DB_*`, `REDIS_URL`, `DINA_PORT`, TLS paths, `DINA_NUM_CTX`, …) is pre-existing and
untouched. Phase-0 host-level variables (`OLLAMA_KEEP_ALIVE`, `OLLAMA_MAX_LOADED_MODELS`,
`OLLAMA_NUM_PARALLEL`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_GPU_OVERHEAD`) live
in the **Ollama systemd unit** (`ops/ollama.service.d-override.conf`), not in pm2 — different
process, deliberately separate.

## Where they are set

`ecosystem.config.js` → `apps[0].env` (committed on this branch):

```js
SAGA_ROOT: '/mnt/nvme_tugrrstorage2/Dina/SAGA',
DINA_GPU_ARBITER: 'off',      // dark launch; flip to 'on' at runbook step W
DINA_GPU_RESERVE_MB: '512',
```

Precedence note: pm2's `env` block wins over `.env`/dotenv for the pm2-managed process. For ad-hoc
shells (`npm run migrate`, manual scripts) export the variable or rely on the defaults above — the
defaults are chosen so that **unset ≡ the committed values** (safe either way).

## Storage permissions (SAGA_ROOT) — dina user read/write

The SAGA tree must be writable by BOTH the pm2-managed server processes and the human `dina` user
doing ops (uploads, model downloads, backups). One-off `chown dina:dina` breaks the moment another
service or user writes a file. The durable pattern is group + setgid:

```bash
sudo groupadd -f saga
sudo usermod -aG saga dina            # re-login (or `newgrp saga`) for it to take effect
# add any other operating users the same way

sudo chown -R dina:saga /mnt/nvme_tugrrstorage2/Dina/SAGA
sudo find /mnt/nvme_tugrrstorage2/Dina/SAGA -type d -exec chmod 2775 {} +   # rwx owner+group, setgid dirs
sudo find /mnt/nvme_tugrrstorage2/Dina/SAGA -type f -exec chmod 0664 {} +   # rw owner+group
```

The setgid bit (`2` in `2775`) makes every **new** file/dir inherit the `saga` group automatically,
so permissions stay correct forever without re-chowning.

**Verify (as the dina user):**
```bash
id | grep saga                                             # membership active
touch /mnt/nvme_tugrrstorage2/Dina/SAGA/tmp/.w && rm $_    # write OK
ls -ld /mnt/nvme_tugrrstorage2/Dina/SAGA                   # drwxrwsr-x dina saga
```

If the pm2 processes run as root (current `sudo pm2` setup), root writes regardless; the group setup
is what guarantees the `dina` user's access — and it is already correct for the day the services are
de-privileged to a service account (add that account to `saga` and nothing else changes).

## Process rule going forward

Any change that reads a new `process.env.*` MUST, in the same commit: (1) add the variable here with
consumer + default + effect timing, and (2) set it in `ecosystem.config.js` if it should be
explicitly configured. A grep gate makes this auditable:

```bash
grep -rn "process\.env\." src/modules/saga src/modules/gpu | grep -v tests | grep -v docs
# every hit must appear in the tables above
```
