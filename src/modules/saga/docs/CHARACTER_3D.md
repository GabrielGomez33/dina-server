# Little One in 3D — the consistency/pose proxy pipeline

> **Status:** decided 2026-09-23. The durable fix for character consistency + real action poses
> (reach/jump/run/crouch). **The 3D model is a PROXY that drives diffusion — not the final render.**
> Its outputs are (a) a perfect multi-pose dataset for a rock-solid v3 LoRA, and (b) depth/lineart
> pose-control for ControlNet. The brand look stays native diffusion; the 3D guarantees build + pose.

## Why this, and why a proxy (not full 3D animation)
Diffusion LoRA cannot hold a tight build across dramatic lighting/poses, and a stub-limbed blob cannot
be posed into reach/jump/run/crouch in diffusion without drifting to a lanky human. A single rigged 3D
model is the same character in every pose, forever. But rendering final frames in 3D would fight our
hand-drawn/charcoal aesthetic — so we render the posed model **neutral** and feed it as **ControlNet
depth+lineart + the character LoRA** into ComfyUI/FramePack, which paint the on-brand look identically
every time. 3D = build + pose truth; diffusion = the look.

## The stack (self-hosted, RTX PRO 4500 Blackwell 32 GB, torch 2.8+cu128)
- **Image→3D: TRELLIS (Microsoft, MIT) — PRIMARY for us.** The research default was Hunyuan3D-2.1 (best
  PBR texture), but we use the mesh as a **pose proxy (depth/lineart), not for its texture**, so
  texture quality is nearly irrelevant — **topology + buildability win**, and TRELLIS has the cleanest
  topology, fewest exotic CUDA deps (the Blackwell build-hell risk), and a fully-commercial MIT license
  with no attribution string. **Hunyuan3D-2.1 = backup** if we ever want its texture. Both run multi-view
  diffusion internally, so a single clean hero is enough (optionally add one back view to stop
  front-features smearing onto the back).
- **Remesh:** Blender headless (voxel/Quadriflow or Instant Meshes) — feed-forward meshes are triangle
  soup; **remesh before rigging or it tears at the stub joints.**
- **Rig:** the blob is nearly limbless, so NOT Rigify/Mixamo (humanoid). Two routes:
  - **Route A (best result):** a tiny hand-built armature (~6–9 bones: body w/ squash-stretch scale,
    head, tuft, 2 stub-arms, 2 stub-legs) + a couple squash/stretch shape keys. ~30–60 min ONE-TIME in
    a GUI Blender session. Everything after is scriptable.
  - **Route B (headless, no GUI):** **UniRig** (VAST-AI, MIT, 8 GB, handles non-humanoid, outputs
    FBX skeleton+skinning, scriptable) — keeps the whole pipeline on the headless pod; may over-rig, so
    verify with test renders. Use this if a GUI Blender session isn't available.
- **Pose + render:** headless `blender -b rig.blend -P pose_and_render.py`. Poses are Python dicts
  (reach/jump/run/crouch + in-betweens); loop poses × camera angles × light → color + **depth + normal
  + lineart** passes. Fully automated.
- **Render style:** render neutral/clean (Eevee Next, GPU/EGL) — it's a control signal, not the final
  frame. The look comes from diffusion (LoRA + ControlNet) or, for previz only, a toon shader + our
  ffmpeg `soft-heavy` grade.

## Downstream priority
1. **(b) LoRA dataset FIRST** — batch-render the rigged model in many poses/angles/lights → a perfectly
   consistent, condition-varied set → train **v3 LoRA**. Then diffusion alone finally stays on-model.
2. **(a) 3D-driven ControlNet keyframes → FramePack** — feed posed depth+lineart + v3 LoRA to synthesize
   on-brand keyframes in exact poses, then FramePack for motion. 
3. **(c) full 3D animation — skip** (most work, least on-brand).

## End-to-end
hero.png → [TRELLIS] mesh.glb → [Blender remesh] → [rig once: Route A or UniRig] little_one_rigged.blend
→ [bpy pose library + batch render] color+depth+lineart → { train v3 LoRA · ControlNet pose keyframes }
→ existing ComfyUI/FramePack/assemble pipeline.

## Realities & gotchas (budget for these)
- **Blackwell sm_120 build hell is the #1 time sink.** spconv / flash-attn / torch_scatter / nvdiffrast /
  custom CUDA rasterizers often have no prebuilt sm_120 wheels → compile from source or fall back to
  SDPA/xformers. TRELLIS chosen partly to minimize this; if it still won't build, TripoSR (MIT, trivial
  deps, lower quality) is a fast proof-of-concept fallback for the mesh.
- **Never rig the raw mesh** — remesh first (triangle soup tears/shades badly).
- **The one GUI step:** Route A needs a single interactive Blender session (local machine or a desktop
  pod) for rig + weight-paint + any back-texture fix. Route B (UniRig) avoids it but needs verification.
  Everything else is headless `-b -P`.
- **Headless GPU render:** Eevee/Cycles must be told to use the GPU (OPTIX/EGL) in the bpy script.

## Sources (accessed 2026-09-23)
TRELLIS (MIT): github.com/microsoft/TRELLIS · trellis2.app/blog/trellis-2-comfyui. Hunyuan3D-2.1:
github.com/Tencent-Hunyuan/Hunyuan3D-2.1 · docs.comfy.org/tutorials/3d/hunyuan3D-2. SF3D / TripoSR:
github.com/Stability-AI/stable-fast-3d · huggingface.co/stabilityai/TripoSR. UniRig (MIT, non-humanoid):
github.com/VAST-AI-Research/UniRig · arxiv.org/html/2504.12451v1. Blender headless bpy:
docs.blender.org/api/current/bpy.types.Pose.html. Eevee/Cycles toon: blendernpr.org/eevee-toon-shaders/.
