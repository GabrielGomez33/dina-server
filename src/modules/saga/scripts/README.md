# SAGA box scripts

Operational scripts that drive the ComfyUI engine on the box over its HTTP API.
They carry **no secrets** — every path/model is an env var or a public model
filename; the engine is localhost-only. Deploy: `scp` to `$SAGA_ROOT/` (or run
from anywhere with `SAGA_ROOT` set) and `chmod +x`.

| Script | Does | Key args (shared: `-o -s -W -H -p -n`) |
|---|---|---|
| `saga-keyframe.sh` | Pose ONE keyframe still: Animagine + IP-Adapter identity + ControlNet Union Promax pose-forcing | `-r ref` `-c control` `--control-pre dwpose\|openpose\|none` `--control-strength` `--ip-weight` |
| `saga-flf.sh` | Render ONE first-last-frame clip (Wan 2.2 FLF2V-A14B lightning) | `-a first` `-b last` `-d durationS`\|`-L frames` `--fps` `--shift` |
| `saga-jutsu-flf.sh` | The 20s jutsu driver: 8 keyframes → 7 FLF transitions + 3 holds = 320f @ 16fps, concat → polish | env: `REF`, `SEAL1..5`, `SEED`, `FLF_T5` |

## Prereqs on the box
- `saga-comfyui` up (localhost:8188), `jq` + `ffmpeg` installed.
- Model filenames default to the audited set (2026-07-18). Override via env if
  yours differ — **`FLF_T5` must be set to your umt5 text-encoder filename**
  (find it: `curl -sf http://127.0.0.1:8188/object_info/CLIPLoader | jq -r '.CLIPLoader.input.required.clip_name[0][]'`).

## Verify-live notes (per project discipline: template in repo → verify live → fix)
- **ControlNet Union Promax** may need a `SetUnionControlNetType` node on some
  builds — see the NOTE at node 23 in `saga-keyframe.sh` for the two-line fix.
- Shake out both risky links cheaply first: one `saga-keyframe.sh` (a single
  seal), then one `saga-flf.sh` between two stills, before the full driver.
