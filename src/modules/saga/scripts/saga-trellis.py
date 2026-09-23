#!/usr/bin/env python3
# ============================================================================
# saga-trellis.py — image → 3D MESH (geometry-only) via Microsoft TRELLIS (MIT).
# ----------------------------------------------------------------------------
# STAGE 1 of the 3D pose-proxy pipeline (see docs/CHARACTER_3D.md). Turns the
# canonical Little One hero into a single clean mesh that becomes the rigged
# proxy driving diffusion (depth/lineart ControlNet) — it is NOT the final
# render, so we do NOT need texture. That single fact removes the entire
# Blackwell build-hell surface:
#
#   • We request formats=['mesh'] only (no gaussian).
#   • We export the raw MeshExtractResult (vertices/faces) straight through
#     trimesh, so we NEVER import trellis.utils.postprocessing_utils — the one
#     module that imports nvdiffrast at load and whose to_glb() texture-bake
#     needs nvdiffrast + diff-gaussian-rasterization. => no nvcc, no JIT build.
#
# What still matters on Blackwell (sm_120 / torch 2.8+cu128):
#   • Sparse attention: stock TRELLIS only supports xformers/flash-attn (neither
#     has sm_120 wheels). We run the SDPA backend (PR #357) — applied by the
#     setup script. Selected here via env BEFORE importing trellis:
#         ATTN_BACKEND=sdpa  SPARSE_ATTN_BACKEND=sdpa  SPCONV_ALGO=native
#   • spconv: prebuilt sm_120 wheel (fafraob) — installed by the setup script.
#
# Usage (inside the TRELLIS venv — see saga-trellis-setup.sh):
#   python saga-trellis.py --check                          # import + backend sanity only (no GPU work)
#   python saga-trellis.py --ref hero.png -o little_one.glb
#   python saga-trellis.py --ref hero.png --back hero_back.png -o little_one.glb   # multi-view (less back-smearing)
#
# The hero should be a single clean on-model view on a plain background; TRELLIS
# removes the background itself (rembg). A back view is optional but stops front
# features from smearing onto the back of the blob.
# ============================================================================
import os
import sys
import argparse

# --- backend selection MUST happen before `import trellis` (read at module load) ---
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPCONV_ALGO", "native")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def die(msg, code=1):
    log(f"❌ {msg}")
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser(description="TRELLIS image→mesh (geometry-only pose proxy)")
    ap.add_argument("--ref", help="front hero image (plain background; bg removed automatically)")
    ap.add_argument("--back", default="", help="optional back view (multi-image conditioning)")
    ap.add_argument("--extra", action="append", default=[], help="additional view(s) for multi-image (repeatable)")
    ap.add_argument("-o", "--out", default="little_one.glb", help="output mesh (.glb/.obj/.ply)")
    ap.add_argument("--model", default="microsoft/TRELLIS-image-large", help="pretrained pipeline")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--ss-steps", type=int, default=12, help="sparse-structure sampler steps")
    ap.add_argument("--ss-cfg", type=float, default=7.5, help="sparse-structure cfg strength")
    ap.add_argument("--slat-steps", type=int, default=12, help="structured-latent sampler steps")
    ap.add_argument("--slat-cfg", type=float, default=3.0, help="structured-latent cfg strength")
    ap.add_argument("--check", action="store_true", help="import + report backends, then exit (no GPU work)")
    args = ap.parse_args()

    # ---- torch / device report (also the first real import smoke test) ----
    try:
        import torch
    except Exception as e:
        die(f"torch import failed: {e}")
    log(f"  torch {torch.__version__}  cuda_available={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        log(f"  device: {torch.cuda.get_device_name(0)}  capability={torch.cuda.get_device_capability(0)}")
    else:
        log("  ⚠ CUDA not available to torch — mesh gen will be unusably slow / fail")

    # ---- import trellis (this is where a broken attention/spconv backend surfaces) ----
    try:
        from trellis.pipelines import TrellisImageTo3DPipeline
    except Exception as e:
        die(
            "trellis import failed: "
            f"{e}\n   → check the SDPA sparse-attention patch (PR #357) applied, and that "
            "spconv (sm_120 wheel) imports. Backends: "
            f"ATTN_BACKEND={os.environ.get('ATTN_BACKEND')} "
            f"SPARSE_ATTN_BACKEND={os.environ.get('SPARSE_ATTN_BACKEND')} "
            f"SPCONV_ALGO={os.environ.get('SPCONV_ALGO')}"
        )

    try:
        import trimesh  # geometry-only export path (no postprocessing_utils → no nvdiffrast)
    except Exception as e:
        die(f"trimesh import failed (pure-python dep): {e}")

    if args.check:
        log("✔ preflight ok — torch + trellis + trimesh import cleanly")
        log(f"  attention backends: ATTN={os.environ['ATTN_BACKEND']} SPARSE={os.environ['SPARSE_ATTN_BACKEND']} SPCONV={os.environ['SPCONV_ALGO']}")
        log("  (geometry-only: nvdiffrast/diff-gaussian-rasterization intentionally NOT exercised)")
        return

    if not args.ref:
        die("need --ref IMG (or use --check)")
    if not os.path.isfile(args.ref):
        die(f"ref not found: {args.ref}")

    from PIL import Image

    def load(p):
        if not os.path.isfile(p):
            die(f"image not found: {p}")
        return Image.open(p)

    images = [load(args.ref)]
    for p in ([args.back] if args.back else []) + list(args.extra):
        if p:
            images.append(load(p))

    log(f"▶ TRELLIS {args.model}  views={len(images)}  seed={args.seed}  "
        f"ss={args.ss_steps}/{args.ss_cfg}  slat={args.slat_steps}/{args.slat_cfg}")
    log("  loading pipeline (first run downloads weights to HF cache)…")
    pipeline = TrellisImageTo3DPipeline.from_pretrained(args.model)
    pipeline.cuda()

    ss_params = {"steps": args.ss_steps, "cfg_strength": args.ss_cfg}
    slat_params = {"steps": args.slat_steps, "cfg_strength": args.slat_cfg}

    log("  sampling geometry (formats=['mesh'])…")
    if len(images) == 1:
        outputs = pipeline.run(
            images[0], seed=args.seed, formats=["mesh"],
            sparse_structure_sampler_params=ss_params, slat_sampler_params=slat_params,
        )
    else:
        if not hasattr(pipeline, "run_multi_image"):
            die("this TRELLIS build lacks run_multi_image — drop --back/--extra and use a single --ref")
        outputs = pipeline.run_multi_image(
            images, seed=args.seed, formats=["mesh"],
            sparse_structure_sampler_params=ss_params, slat_sampler_params=slat_params,
        )

    meshes = outputs.get("mesh") if isinstance(outputs, dict) else None
    if not meshes:
        die("pipeline returned no 'mesh' output (check TRELLIS logs above)")
    m = meshes[0]

    # MeshExtractResult → numpy vertices/faces. Attribute names are stable across
    # TRELLIS versions (.vertices, .faces); guard anyway and detach off-GPU.
    def to_np(x):
        try:
            import torch
            if isinstance(x, torch.Tensor):
                return x.detach().cpu().numpy()
        except Exception:
            pass
        import numpy as np
        return np.asarray(x)

    verts = getattr(m, "vertices", None)
    faces = getattr(m, "faces", None)
    if verts is None or faces is None:
        die(f"MeshExtractResult missing .vertices/.faces (got attrs: {dir(m)})")
    verts = to_np(verts)
    faces = to_np(faces)
    log(f"  extracted mesh: {len(verts)} verts / {len(faces)} faces")

    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    # keep it as-is; orientation/scale/remesh are handled in Blender (stage 2).
    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    mesh.export(out)
    log(f"✅ mesh → {out}  ({len(verts)} verts, {len(faces)} faces)")
    print(out)


if __name__ == "__main__":
    main()
