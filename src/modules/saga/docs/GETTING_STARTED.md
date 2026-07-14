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

### G. Create the SAGA storage tree on the 4TB NVMe
```bash
sudo mkdir -p /mnt/nvme_tugrrstorage2/Dina/SAGA/{models/{checkpoints,vae,clip,upscale,interpolation,lipsync,audio,loras},tenants,tmp,engine,backups}
sudo chown -R dina:dina /mnt/nvme_tugrrstorage2/Dina/SAGA
```
**Verify:** `df -h /mnt/nvme_tugrrstorage2` shows the 4TB volume;
`touch /mnt/nvme_tugrrstorage2/Dina/SAGA/tmp/.w && rm $_` succeeds as the dina user.

### H. Stage the env var (takes effect at the Part III deploy)
In `ecosystem.config.js` → `env:` block, add:
```js
SAGA_ROOT: '/mnt/nvme_tugrrstorage2/Dina/SAGA',
DINA_GPU_ARBITER: 'off',        // arbiter ships dark; turned on at step W
```
**Verify:** `node -e "console.log(require('./ecosystem.config.js').apps[0].env)"` prints both.

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
cd /mnt/nvme_tugrrstorage2/Dina/SAGA/engine
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
  base_path: /mnt/nvme_tugrrstorage2/Dina/SAGA/models
  checkpoints: checkpoints
  vae: vae
  clip: clip
  loras: loras
  upscale_models: upscale
```

### M. Run ComfyUI under PM2, bound to localhost
```bash
cd /mnt/nvme_tugrrstorage2/Dina/SAGA/engine/ComfyUI
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
sha256sum <file> >> /mnt/nvme_tugrrstorage2/Dina/SAGA/models/MANIFEST.txt
echo "  source: <url>  license: <license>" >> /mnt/nvme_tugrrstorage2/Dina/SAGA/models/MANIFEST.txt
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
- [ ] SAGA tree on the 4TB NVMe, dina-owned; `SAGA_ROOT` + `DINA_GPU_ARBITER=off` staged in PM2 env
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
  > /mnt/nvme_tugrrstorage2/Dina/SAGA/backups/dina-pre-saga-$(date +%Y%m%d-%H%M).sql
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

### T. Wire the GPU arbiter — registration only, flag OFF
Follow `src/modules/gpu/docs/INTEGRATION.md` **Steps 1–2 only** (register `OllamaEngineAdapter` +
expose `gpuArbiter.snapshot()` in diagnostics). The flag is `off`, so no request path changes.
```bash
npm run build && npm run deploy    # zero-downtime pm2 reload
```
**Verify:** logs show normal startup; @Dina chat works exactly as before; diagnostics payload now
contains a `gpuArbiter` block with `queueDepth: 0`. **Rollback:** revert the two edits, redeploy.

### U. Wire the SAGA module — init + orchestrator case + routes
Follow `src/modules/saga/docs/INTEGRATION.md` Steps 2–4: `sagaModule.initialize({db: database,
jobs: <stub queue>})` as Phase 5 in `DinaCore.initialize()`, the additive `case 'saga'` in the
orchestrator switch, and `registerSagaRoutes(...)` next to `registerTruthStreamRoutes(...)`.
```bash
npm run build && npm run deploy
```
**Verify:** startup logs show `🎬 Saga Module v0.1.0 initialized`; all existing endpoints unaffected.
**Rollback:** comment out the three additive blocks, redeploy.

### V. Smoke-test the SAGA surface (positive AND negative)
```bash
# status (authenticated request via your normal token flow)
curl -s https://theundergroundrailroad.world/dina/saga/status -H "Authorization: Bearer <token>"
# create your tenant → returns tenantId; caller becomes owner
curl -s -X POST .../dina/saga/tenants -d '{"name":"Gabriel","slug":"gabriel","plan":"admin"}' ...
# create the first project → returns projectId + storageRoot under /mnt/nvme_tugrrstorage2/Dina/SAGA/tenants/...
curl -s -X POST .../dina/saga/<tenantId>/projects -d '{"slug":"the-story"}' ...
```
**Negative smokes (must fail correctly):** unauthenticated → 401 · a second user on your tenant →
403 FORBIDDEN · malformed body → 400 INVALID_REQUEST · traversal slug → rejected.
**Verify in DB:** rows in saga_tenants / saga_memberships (role=owner) / saga_projects.

### W. Turn the arbiter ON (the load-balancing go-live)
Apply `src/modules/gpu/docs/INTEGRATION.md` **Steps 3–4** (wrap the three `OllamaClient` methods +
the raw debug route), set `DINA_GPU_ARBITER: 'on'`, `npm run build && npm run deploy`.
**Verify:** @Dina chat latency unchanged (shared leases admit instantly on an idle card);
diagnostics `gpuArbiter.totals.granted` climbs with each chat. **Rollback:** flip the env to `off`,
`pm2 reload` — behavior byte-identical to before.

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
