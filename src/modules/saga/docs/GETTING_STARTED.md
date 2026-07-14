# SAGA — Getting Started: A–Z Implementation Runbook

The complete, ordered path from "nothing done locally" to a live, verified SAGA foundation.
Machine: tugrr-portal · repo: `/var/www/dina-server` · every step ends with a **verify** — do not
proceed past a failed verify. Steps A–F are risk-free (no live change). The first live change is S.

**Pre-verified on this branch before this guide was written:** full `npm run build` with complete
dependencies ✅ · arbiter proofs 43/43 ✅ · saga foundation 97/97 ✅ · render systems 29/29 ✅ ·
migration 003 discovered by the runner ✅.

---

## PART I — Get the code and prove it (no risk, no live changes)

### A. Fetch the branch
```bash
cd /var/www/dina-server
git fetch origin claude/dina-server-analysis-9wjtkc
git checkout claude/dina-server-analysis-9wjtkc
git log --oneline -3        # newest commit should mention "real tree"
```
**Verify:** `ls src/modules/saga src/modules/gpu` shows both modules.

### B. Install dependencies
```bash
npm install
```
**Verify:** exits clean. (`npm ci` if you prefer exact lockfile installs.)

### C. Run every proof harness
```bash
npm run test:gpu           # expect: RESULTS: 43 passed, 0 failed
npm run test:saga          # expect: RESULTS: 97 passed, 0 failed
npm run test:saga:render   # expect: RESULTS: 29 passed, 0 failed
```
**Verify:** all three green. These are hermetic (no DB/GPU/network) — a failure here means a broken
checkout, nothing else.

### D. Type-check and build
```bash
npm run type-check && npm run build
```
**Verify:** zero errors; `ls dist/modules/saga dist/modules/gpu` shows compiled output.

### E. Read the two integration contracts (10 minutes, saves hours)
`src/modules/gpu/docs/INTEGRATION.md` and `src/modules/saga/docs/INTEGRATION.md` — you will execute
them at steps T–V. Also skim `src/modules/saga/docs/PHASES.md` (the phase ladder this runbook walks).

### F. Confirm the migration is discovered but NOT applied
```bash
npm run migrate:status
```
**Verify:** `003 saga_core` shows **⏳ pending** (001/002 applied). Nothing has touched the DB yet.

---

## PART II — Phase 0: host environment (no dina-server changes)

> **Define your storage root once, privately.** Pick the SAGA root on your 4TB SSD and export it in
> your shell for the commands below; the same value goes into `.env` at step H. The path is
> deployment configuration — it never appears in committed files.
> ```bash
> export SAGA_ROOT=/absolute/path/on/your/4tb/ssd    # e.g. under your NVMe mount
> ```

### G. Create the SAGA storage tree on the 4TB NVMe (group-based permissions)
```bash
sudo mkdir -p "$SAGA_ROOT"/{models/{checkpoints,vae,clip,upscale,interpolation,lipsync,audio,loras},tenants,tmp,engine,backups}
# Durable access model: dedicated group + setgid, so the dina user AND the
# pm2-managed processes can read/write, and NEW files inherit the group forever.
sudo groupadd -f saga
sudo usermod -aG saga dina        # re-login (or `newgrp saga`) to activate
sudo chown -R dina:saga "$SAGA_ROOT"
sudo find "$SAGA_ROOT" -type d -exec chmod 2775 {} +
```
**Verify:** `df -h "$SAGA_ROOT"` shows the 4TB volume; `id | grep saga` shows membership;
`touch "$SAGA_ROOT"/tmp/.w && rm $_` succeeds as the dina user;
`ls -ld "$SAGA_ROOT"` shows `drwxrwsr-x ... dina saga` (note the `s`).
Full permission model + rationale: `docs/ENVIRONMENT.md`.

### H. Set the environment variables in .env (untracked — like DB credentials)
Infrastructure values live only in the untracked `.env` (dotenv loads it in `src/index.ts`, same as
`DB_PASSWORD`). Template: `.env.example`; registry: `docs/ENVIRONMENT.md`.
```bash
{
  echo "SAGA_ROOT=$SAGA_ROOT"
  echo "DINA_GPU_ARBITER=off"
  echo "DINA_GPU_RESERVE_MB=512"
} >> /var/www/dina-server/.env
```
**Verify:** `grep -c "SAGA_ROOT\|DINA_GPU" .env` → 3, and `git check-ignore .env` confirms it can
never be committed. Without `SAGA_ROOT`, the saga module degrades at startup with a clear error
(isolated — the rest of Dina is unaffected).

### I. GPU hygiene (prevents the documented outage class)
```bash
bash ops/verify-gpu.sh                       # must be healthy, models 100% GPU
sudo bash ops/pin-nvidia-driver.sh           # freeze driver against apt skew
sudo systemctl enable --now nvidia-persistenced && sudo nvidia-smi -pm 1
sudo nvidia-smi -pl 380                      # sustained-render power limit (~-4% perf, big thermal win)
```
**Verify:** `nvidia-smi` shows persistence ON, power cap 380W, no errors.

### J. Confirm the Ollama service override is active
```bash
systemctl cat ollama | grep -E "OLLAMA_(KEEP_ALIVE|MAX_LOADED_MODELS|NUM_PARALLEL|FLASH_ATTENTION|KV_CACHE_TYPE)"
```
**Verify:** all five present (from `ops/ollama.service.d-override.conf`). If missing, install per that
file's header, `systemctl daemon-reload && systemctl restart ollama`, then re-run `ops/verify-gpu.sh`.

### K. Install ComfyUI — pinned, venv'd, localhost-only
```bash
cd "$SAGA_ROOT"/engine
git clone https://github.com/comfyanonymous/ComfyUI && cd ComfyUI
git tag --sort=-creatordate | head -3        # pick the newest release tag
git checkout <that-tag>                      # PIN it — write the tag down
python3 -m venv venv && source venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
pip freeze > /var/www/dina-server/ops/comfyui-requirements.lock
deactivate
```
**Verify:** the lock file exists and is committed later (step Y). No custom nodes in Phase 0.

### L. Point ComfyUI at SAGA's model tree
Create `extra_model_paths.yaml` in the ComfyUI directory:
```yaml
saga:
  base_path: "$SAGA_ROOT"/models
  checkpoints: checkpoints
  vae: vae
  clip: clip
  loras: loras
  upscale_models: upscale
```

### M. Run ComfyUI under PM2, bound to localhost
```bash
cd "$SAGA_ROOT"/engine/ComfyUI
pm2 start "venv/bin/python main.py --listen 127.0.0.1 --port 8188" --name saga-comfyui
pm2 save
```
**Verify (two things):**
```bash
curl -s http://127.0.0.1:8188/system_stats | python3 -m json.tool | head -20   # GPU listed
ss -tlnp | grep 8188                                                            # bound to 127.0.0.1 ONLY
```

### N. Download the starter models (~20 GB, license-clean)
Into `SAGA/models/`: FLUX.1 **schnell** fp8 (Apache 2.0) → `checkpoints/`; one anime-SDXL workhorse
(check its license page) → `checkpoints/`; RealESRGAN-anime or 4x-UltraSharp → `upscale/`; RIFE →
`interpolation/`. For **every** file:
```bash
sha256sum <file> >> "$SAGA_ROOT"/models/MANIFEST.txt
echo "  source: <url>  license: <license>" >> "$SAGA_ROOT"/models/MANIFEST.txt
```
**Deliberately deferred:** FLUX dev (non-commercial license), Wan/Hunyuan (Phase 3), TTS (Phase 4).
**Verify:** MANIFEST.txt has hash+source+license for every model on disk.

### O. First manual image — the engine smoke test
Open ComfyUI (`ssh -L 8188:127.0.0.1:8188 dina@tugrr-portal`, then http://localhost:8188), load the
default workflow, select the anime checkpoint, generate one 1024×1024 image.
**Verify:** an image renders; note the wall-clock seconds — your first calibration datapoint.

### P. The coexistence check (Phase 0's most important observation)
```bash
ollama ps            # BEFORE: warm set, all 100% GPU
# ...run one more ComfyUI generation...
ollama ps            # AFTER: did any model drop to CPU or split?
nvidia-smi           # total VRAM picture with both stacks
```
Record what you see. If Ollama got split/evicted, you have witnessed the exact failure the arbiter
(step T) exists to prevent — with SDXL-class models it usually coexists; with anything bigger it
won't, by design.

### Q. Phase 0 exit checklist
- [ ] SAGA tree on the 4TB NVMe with `saga` group + setgid perms (dina user verified read/write); env vars confirmed via step H (committed in ecosystem.config.js, registry in docs/ENVIRONMENT.md)
- [ ] GPU: verify-gpu healthy, driver pinned, persistence on, power cap set
- [ ] ComfyUI: pinned tag, locked venv, PM2-managed, localhost-only, sees the 3090 Ti
- [ ] Models hashed + licensed in MANIFEST.txt
- [ ] One anime image generated; timing + coexistence behaviour recorded

---

## PART III — Phase 1: wire SAGA into the live server (first live changes)

> Do R–X in one maintenance window with `pm2 logs dina-server` open in a second terminal.
> Every step here has an explicit rollback.

### R. Back up the database FIRST (enterprise rule: no schema change without a restore path)
```bash
mysqldump -u dina_user -p --single-transaction --routines dina \
  > "$SAGA_ROOT"/backups/dina-pre-saga-$(date +%Y%m%d-%H%M).sql
```
**Verify:** file exists and is non-trivially sized. *Rollback for step S is this file.*

### S. Apply migration 003
```bash
npm run migrate -- --dry-run     # shows 003 pending, applies nothing
npm run migrate                  # applies 003 (idempotent — safe to re-run)
npm run migrate:status           # 003 ✅ applied
mysql -u dina_user -p dina -e "SHOW TABLES LIKE 'saga_%';"
```
**Verify:** 7 tables: saga_tenants, saga_memberships, saga_projects, saga_manifests,
saga_audio_tracks, saga_generations, saga_jobs. **Rollback:** `npm run migrate:down` (drops them,
FK-ordered — safe now, before any data).

### T + U. Deploy the wiring (ALREADY IMPLEMENTED on this branch — no manual edits)
The arbiter registration, SAGA Phase-5 init (with StubJobQueue), orchestrator `case 'saga'`, route
mounting, and the flag-gated call wrapping are all committed code. Your step is only:
```bash
git pull && npm install && npm run build
npm run test:gpu && npm run test:saga && npm run test:saga:render   # green before deploy
npm run deploy                                                       # zero-downtime pm2 reload
```
**Verify in `pm2 logs dina-server`:**
- `🛡️ GPU Arbiter registered (enforcement: off — dark launch)`
- `🎬 Phase 5/5 — SAGA Module` → `✅ SAGA ready (execution engine: Phase 2)`
- @Dina chat behaves exactly as before (flag is off — byte-identical path).
**Rollback:** `git revert` the wiring commit, redeploy. (The wiring is additive + flag-gated, so the
practical rollback for behaviour is the flag itself — see W.)

### V. Smoke-test the SAGA surface (positive AND negative)
```bash
# status (authenticated request via your normal token flow)
curl -s https://theundergroundrailroad.world/dina/saga/status -H "Authorization: Bearer <token>"
# create your tenant → returns tenantId; caller becomes owner
curl -s -X POST .../dina/saga/tenants -d '{"name":"Gabriel","slug":"gabriel","plan":"admin"}' ...
# create the first project → returns projectId + storageRoot under "$SAGA_ROOT"/tenants/...
curl -s -X POST .../dina/saga/<tenantId>/projects -d '{"slug":"the-story"}' ...
```
**Negative smokes (must fail correctly):** unauthenticated → 401 · a second user on your tenant →
403 FORBIDDEN · malformed body → 400 INVALID_REQUEST · traversal slug → rejected.
**Verify in DB:** rows in saga_tenants / saga_memberships (role=owner) / saga_projects.

### W. Turn the arbiter ON (the load-balancing go-live — one env flip)
The call wrapping is already committed (flag-gated). Go-live is only:
`ecosystem.config.js` → `DINA_GPU_ARBITER: 'on'` → `npm run deploy`.
**Verify:** @Dina chat latency unchanged (shared leases admit instantly on an idle card);
diagnostics `gpuArbiter` block shows `enforcement: 'on'` and `totals.granted` climbing with each
chat. **Rollback:** flip back to `'off'`, `npm run deploy` — behavior byte-identical to before.

### X. The arbitration drill (prove the whole thesis on real hardware)
In `node` REPL against the built dist (or a temporary admin route):
take `gpuArbiter.acquire({label:'drill', engine:'comfyui', estVramMb:22000, mode:'exclusive',
priority:'background'})` → watch `ollama ps` empty out (drained) → send an @Dina message → it queues
→ `release()` → chat completes, chat model re-warms.
**Verify:** that sequence, plus `gpuMonitor` never reporting cpu/split during it. This is Goal #1,
proven end-to-end on your card.

### Y. Commit the ops artifacts + backup cron
```bash
# nightly: DB + irreplaceable set (raw refs, audio source, loras, exports) to backups/
crontab -e   # 03:30 nightly: mysqldump + rsync per docs/READINESS.md GAP 1
git add ops/comfyui-requirements.lock && git commit -m "ops: pin ComfyUI environment" && git push
```
**Verify:** run the backup script once by hand; confirm the dump restores into a scratch DB.

### Z. Declare Phase 1 complete → open Phase 2
You now have: proofs green on your box, Phase 0 checklist done, schema live, arbiter live and
drilled, SAGA API answering with tenancy enforced, backups running. **Phase 2 build order** (from
`docs/READINESS.md`): calibration runner → generation worker (exclusive lease around
`comfyClient.executeWorkflow`, batch-grouped, gpu_seconds recorded) → model registry → first image
through the API with the live progress bar. That code lands in `src/modules/saga/` with its proof
harness, same as everything before it.
