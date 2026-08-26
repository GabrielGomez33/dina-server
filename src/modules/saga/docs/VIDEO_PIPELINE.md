# SAGA video pipeline — the proven end-to-end runbook

> **Status:** ✅ **Proven end-to-end** (2026-08-25) with **Video 3 — "You're Not Complicated. You're
> Uncharted."** — the first fully self-hosted Mirror post: trained character → animation → post →
> captions → narration → music → assembly, one 1080×1920 mp4, zero per-item cost, nothing proprietary.
> This is the repeatable recipe. Every stage is one reusable script; the per-video specifics are data.

## The stack (each stage = one concern, one script)

```
IMAGE      saga-flux.sh        Flux.1-dev fp8 + little_one_v2 LoRA → on-model keyframes (in-scene)
VIDEO      saga-framepack.sh   FramePack (HunyuanVideo i2v) animates each keyframe
POST       ffmpeg (soft-heavy) lanczos upscale to 1920-tall + the soft-heavy grade, one pass
CAPTIONS   saga-assemble.sh    wrapped + fading, "||" = sequential in-shot phrase reveals
END-CARD   saga-endcard.sh     brand art → flickering old-film clip (calm gate drift + breath + grain)
CONTINUITY saga-assemble.sh    --xfade dissolves → one continuous film (no hard cuts = the calm brand)
AUDIO      saga-vo.py          Kokoro af_heart @0.9 narration, beat-placed on the timeline
MUSIC      (assemble mux)      backing track ducked ~-18 dB under the VO, 1 s fade-out
ASSEMBLE   saga-assemble.sh    scenes + VO + music + captions + end-card → 1080×1920 mp4
```

Compute plane: a RunPod GPU (proven on **RTX PRO 4500 Blackwell, 32 GB** — needs torch cu128 for `sm_120`).
Everything talks to a local ComfyUI over HTTP; ffmpeg/TTS run on the box. `source saga-env.sh` first.

## Video 3 — the exact recipe (copy this shape per video)

- **Beats / durations:** 4 shots at **4 / 5 / 6 / 3 s** + **2.5 s** end-card. With **0.7 s** xfade dissolves
  the scene starts land at **0 / 3.3 / 7.6 / 12.9 / 15.2 s**; final length **17.7 s**.
- **Image:** `saga-flux.sh --lora little_one_v2.safetensors --lora-strength 0.9 --guidance 3.5 --steps 28`,
  character generated **directly in-scene** (v2 holds identity — see LITTLE_ONE.md). Add `front view`.
- **Video:** `saga-framepack.sh -a shotN.png -d <sec> -W 640 -H 1120 --gpu-keep 8 --no-teacache` with a
  motion prompt describing Little One's *real* morphology (glides/leans/reaches with a stub — never
  "walks/steps", which summons a human). `--no-teacache` = max motion (teacache suppresses it).
  Free VRAM first: `curl -X POST $COMFY/free -d '{"unload_models":true,"free_memory":true}'`.
- **Post (upscale+grade, one ffmpeg pass):** `scale=-2:1920:flags=lanczos` (soft, preserves the dreamy
  look) then the **soft-heavy** grade (soft Orton bloom + matte warm haze + heavy grain + vignette;
  `saga-grade.sh --preset soft-heavy`, or inline).
- **Captions:** wrapped to fit, fading in/out; shot 3 uses `||` — "Not a problem to solve. || A place to
  explore." reveals in two beats. Burned crisp (added after grade), centered, bottom-anchored.
- **End-card:** the designed brand still (`endcard_src.png`, the `M I Я Я O R` wordmark on aged texture)
  → `saga-endcard.sh --image endcard_src.png` → flickering old-film **calm** motion (slow sub-Hz gate
  drift + gentle brightness breath + light live grain — alive, not strobing).
- **Continuity:** `--xfade 0.7` dissolves (storyboard: "no hard cuts, calm is the brand").
- **Narration:** **Kokoro `af_heart` @ speed 0.9** (the warm brand narrator), five lines beat-placed at
  **0.3 / 3.5 / 8.0 / 13.1 / 15.5 s** (incl. the end-card line "Explore you."). Beat-placement (silence
  pad + sum at each offset) keeps VO synced to the shots/captions.
- **Music:** user-provided backing track, ducked **−18 dB** under the VO with a **1 s** fade-out.

## Voice: Kokoro is the narrator; Chatterbox clone is parked

- **Chosen:** Kokoro `af_heart @0.9` — warm, calm, Apache-2.0, tiny, reliable. The brand narrator.
- **Explored & parked:** a **Chatterbox** (MIT, commercial-safe) zero-shot clone of the founder's voice
  (`saga-clone.py`, isolated `venv-chatter`, torch 2.8+cu128 for Blackwell). Best zero-shot settings were
  `exaggeration 0.3 / cfg 0.5`, but it captured cadence/tone without nailing timbre/accent — the ceiling
  of one-shot cloning. Path stays installed + committed; a short **fine-tune** on a few minutes of voice
  is the route to a true match if we revisit. (See COMPETITIVE_RESEARCH.md for the TTS landscape; Voxtral
  TTS was assessed and rejected — non-commercial license + no cloning in the open weights.)

## Hard-won gotchas (don't relearn)

- **FramePack OOM is resolution, not duration** (windowed sampling). 768×1344 blew 24 GB; **640×1120 +
  `--gpu-keep 8`** fits. Upscale at the end, not by rendering bigger.
- **Blackwell (`sm_120`) needs torch cu128.** A fresh `pip install` of a TTS pkg may drag in torch 2.6/
  cu124 (no Blackwell kernels) — reinstall `torch==2.8.0 torchaudio==2.8.0 --index-url .../cu128` **with
  deps** (so the cu12.8 CUDA runtime libs come too, or you get `undefined symbol` from a cu12.4 libcudart).
- **Repo ≠ pod.** The pod runs whatever toolset was placed on it; the repo is the versioned record. Where
  the pod lacks a new feature, run the self-contained ffmpeg inline instead of syncing.
- **`source saga-env.sh` activates the ComfyUI venv** — don't source it inside `venv-chatter` (it switches
  you back). Set `HF_HOME` on the volume to keep model downloads off the container disk.

## Reproduce / make the next video — the one-command driver

`saga-video.sh` reads one manifest (`videos/*.video` — parallel bash arrays) and runs the mechanical
downstream **animate → post → end-card → audio → assemble** with review gates. VO offsets are
auto-computed from the durations + xfade. Keyframe curation stays manual (the taste checkpoint).

1. Author `videos/vidN.video` from the storyboard (copy `vid3.video`): per shot a duration, motion
   prompt, caption (use `||` for a two-phrase reveal), VO line. Set grade/xfade/music/voice up top.
2. Curate keyframes: generate on-model shots (saga-flux + the LoRA), pick the best, place as
   `<workdir>/shots/shot1..N.png`. Drop `endcard_src.png` + the music track in `<workdir>`.
3. Dry-run then run:
   ```
   saga-video.sh -c videos/vidN.video --plan      # prints the whole plan, runs nothing
   saga-video.sh -c videos/vidN.video             # runs with review gates
   saga-video.sh -c videos/vidN.video --from audio --yes   # resume a stage, unattended
   ```
   Output: `<workdir>/final.mp4`. Same scripts, new data — `vid3.video` is the proven reference.
