#!/usr/bin/env python3
# ============================================================================
# saga-3d-reskin.py — turn a raw UniRig output into a cleanly-poseable rig:
# WELD the triangle-soup mesh, then RECOMPUTE skin weights with bone-heat.
#
#   blender -b -P saga-3d-reskin.py -- --in alien_rigged.glb --out alien_reskinned.glb
#   blender -b -P saga-3d-reskin.py -- --in r.glb --polish 3      # soften a residual joint crease
#   blender -b -P saga-3d-reskin.py -- --in r.glb --method smooth # keep+blur UniRig weights instead
#
# THE TWO DEFECTS UNIRIG LEAVES, AND THE FIX (proven on the alien):
#   1) TRIANGLE SOUP — UniRig's merge writes a separate vertex per triangle, so the
#      clean 40k-vert watertight input comes back as ~240k verts / 80k components /
#      every edge non-manifold. Posed, the detached triangles fly apart (shred).
#      FIX: weld coincident verts (merge-by-distance) → one watertight component.
#   2) BLEEDING WEIGHTS — UniRig's weights let the arm bones own head/neck verts, so
#      posing the arms drags the face; smoothing those weights only spreads the bleed.
#      FIX: once the mesh is welded (manifold), bone-heat SUCCEEDS (it returns zero
#      weights on soup) and weights by distance ALONG THE SURFACE — head verts are far
#      from the arm bones along the surface, so they get ~zero arm weight. Head holds
#      still, fingers follow their own bones. This is the default (--method boneheat).
#   --method smooth keeps UniRig's weights and blurs them; only useful when a mesh
#   arrives already clean and you want to preserve its authored weights.
#
# HARD REQUIREMENT: the output GLB must round-trip as a real rig. glTF stores
# joint NODES + a SKIN; Blender only rebuilds an Armature on import if the skin is
# present. So after export we RE-IMPORT and assert a real armature + skinned mesh
# exist (and that weights are non-zero); otherwise we exit non-zero.
# ============================================================================
import bpy, bmesh, sys, os

def argv(): return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def log(*a): print("  [reskin]", *a, file=sys.stderr, flush=True)

def weld_mesh(mesh, eps):
    """Merge coincident vertices (merge-by-distance) to repair UniRig's output,
    which unwelds the surface into TRIANGLE SOUP — a separate vertex per triangle
    (≈3× verts, one component per face, every edge non-manifold). Welding restores
    shared vertices → a single watertight component whose weights are continuous,
    so posing can't tear it apart and weight-smoothing can diffuse across the real
    surface. Done with bmesh so it runs headless (no 3D-viewport context needed).
    Merged verts' skin weights (the deform layer) are carried onto the survivor."""
    me = mesh.data
    before = len(me.vertices)
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=eps)
    bm.to_mesh(me); bm.free()
    me.update()
    after = len(me.vertices)
    log(f"weld (merge-by-distance eps={eps}): {before} → {after} verts")
    return before, after

def has_armature_mod(mesh, arm):
    return any(md.type == "ARMATURE" and md.object == arm for md in mesh.modifiers)

def total_weighted_verts(mesh):
    return sum(1 for v in mesh.data.vertices if any(g.weight > 0.0 for g in v.groups))

def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

def smooth_all_weights(mesh, factor, iters):
    """Blur every vertex group toward its topological neighbours so hard bone
    boundaries become gradients (joints crease instead of tearing). Implemented
    directly in NumPy over the mesh graph — NO bpy.ops — because the interactive
    vertex_group_smooth operator requires a 3D-viewport context that headless
    Blender lacks (poll() fails). This runs identically with or without a UI."""
    import numpy as np
    me = mesh.data
    nv = len(me.vertices)
    vgs = list(mesh.vertex_groups)
    nb = len(vgs)
    col_of = {vg.index: k for k, vg in enumerate(vgs)}      # vertex_group.index -> matrix column

    # dense weight matrix W[vert, bone]
    W = np.zeros((nv, nb), dtype=np.float32)
    for v in me.vertices:
        for g in v.groups:
            c = col_of.get(g.group)
            if c is not None:
                W[v.index, c] = g.weight

    # undirected edge graph
    ne = len(me.edges)
    e = np.empty(ne * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    e = e.reshape(ne, 2)
    i, j = e[:, 0], e[:, 1]
    valence = (np.bincount(i, minlength=nv) + np.bincount(j, minlength=nv)).astype(np.float32)
    valence = np.maximum(valence, 1.0)[:, None]

    # iterative Laplacian blend: W <- (1-f)W + f * mean(neighbours)
    for _ in range(iters):
        nsum = np.zeros_like(W)
        np.add.at(nsum, i, W[j])
        np.add.at(nsum, j, W[i])
        W = (1.0 - factor) * W + factor * (nsum / valence)

    # renormalise each vertex's weights to sum to 1 (skip unweighted verts)
    rs = W.sum(axis=1, keepdims=True)
    nz = rs[:, 0] > 1e-8
    W[nz] = W[nz] / rs[nz]

    # write back: clear each group fully, then re-add in quantised buckets (fast — avoids
    # 240k individual add() calls while keeping ~1/255 weight precision, ample for a proxy).
    all_idx = list(range(nv))
    for vg in vgs:
        vg.remove(all_idx)
    Q = 255
    Wq = np.rint(W * Q).astype(np.int32)
    idx_arange = np.arange(nv)
    for c, vg in enumerate(vgs):
        wc = Wq[:, c]
        for b in range(1, Q + 1):
            sel = idx_arange[wc == b]
            if sel.size:
                vg.add(sel.tolist(), b / Q, "REPLACE")

def bone_heat(mesh, arm):
    """Fallback for a raw mesh with no incoming weights."""
    mesh.vertex_groups.clear()
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")

def verify_glb_is_rigged(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    empties = [o for o in bpy.data.objects if o.type == "EMPTY"]
    skinned = [m for m in meshes if any(md.type == "ARMATURE" for md in m.modifiers)]
    log(f"verify re-import: armatures={len(arms)} skinned_meshes={len(skinned)} "
        f"meshes={len(meshes)} empties={len(empties)}")
    if not arms:
        log("❌ VERIFY FAILED: no armature on re-import — the skin was NOT written "
            f"(joints came back as {len(empties)} empties). Output is un-poseable.")
        return False
    if not skinned:
        log("❌ VERIFY FAILED: armature present but no mesh has an armature modifier — not bound.")
        return False
    wv = total_weighted_verts(skinned[0])
    if wv == 0:
        log("❌ VERIFY FAILED: skinned mesh has ZERO weighted verts — would not deform.")
        return False
    log(f"✅ verify ok: '{arms[0].name}' bones={len(arms[0].data.bones)}, "
        f"mesh '{skinned[0].name}' skinned, {wv}/{len(skinned[0].data.vertices)} verts weighted")
    return True

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--method", choices=["boneheat", "smooth"], default="boneheat",
                    help="boneheat: RECOMPUTE weights on the welded mesh — surface-distance weights, "
                         "so no bleed into the head and fingers follow the arm (the good result). "
                         "smooth: keep UniRig weights and blur them (bleeds on no-neck characters).")
    ap.add_argument("--polish", type=int, default=0,
                    help="optional post-boneheat smoothing passes to soften a residual joint crease (0 = none)")
    ap.add_argument("--iters", type=int, default=20, help="smooth-method weight-smoothing passes")
    ap.add_argument("--factor", type=float, default=0.5, help="per-pass smoothing strength 0..1")
    ap.add_argument("--weld", type=float, default=1e-4,
                    help="merge-by-distance epsilon to repair UniRig triangle-soup (0 = skip welding)")
    args = ap.parse_args(argv())
    inp = os.path.abspath(args.inp)
    out = os.path.abspath(args.out) if args.out else os.path.splitext(inp)[0] + "_reskinned.glb"
    if not os.path.isfile(inp): log(f"❌ not found: {inp}"); sys.exit(1)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=inp)
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if arm is None or not meshes:
        log(f"❌ need an armature + mesh (armature={arm}, meshes={len(meshes)})"); sys.exit(1)

    # keep only the main character mesh; delete stray junk (e.g. UniRig's Icosphere)
    main_mesh = max(meshes, key=lambda m: len(m.data.vertices))
    for m in meshes:
        if m is not main_mesh:
            log(f"removing stray mesh '{m.name}' ({len(m.data.vertices)} verts)")
            bpy.data.objects.remove(m, do_unlink=True)

    wv0 = total_weighted_verts(main_mesh)
    log(f"armature: {arm.name}  bones: {len(arm.data.bones)}  mesh: '{main_mesh.name}' "
        f"({len(main_mesh.data.vertices)} verts)  incoming weighted verts={wv0}")

    # repair UniRig triangle-soup FIRST: weld coincident verts into a single
    # watertight surface so weights are continuous and smoothing can diffuse
    # across the real mesh (on soup, each vert only touches its own triangle).
    if args.weld and args.weld > 0:
        weld_mesh(main_mesh, args.weld)

    wv0 = total_weighted_verts(main_mesh)
    # DEFAULT = boneheat: recompute weights on the now-watertight welded mesh. Bone-heat
    # weights by distance ALONG THE SURFACE, so head verts (far from the arm bones along
    # the surface) get ~zero arm weight — the head no longer drags and the fingers follow
    # their own bones. This only works because welding made the mesh manifold; on the raw
    # triangle-soup bone-heat returned zero weights. "smooth" keeps UniRig's weights and
    # blurs them, which bleeds into the head on a no-neck character.
    if args.method == "boneheat" or wv0 == 0:
        log("bone-heat on welded mesh (localized surface-distance weights)")
        bone_heat(main_mesh, arm)
        if args.polish > 0:
            log(f"polish smoothing: factor={args.factor} iters={args.polish}")
            smooth_all_weights(main_mesh, args.factor, args.polish)
    else:
        if not has_armature_mod(main_mesh, arm):
            mod = main_mesh.modifiers.new(name="Armature", type="ARMATURE"); mod.object = arm
        log(f"smoothing existing UniRig weights: factor={args.factor} iters={args.iters}")
        smooth_all_weights(main_mesh, args.factor, args.iters)

    wv1 = total_weighted_verts(main_mesh)
    log(f"after reskin: {wv1}/{len(main_mesh.data.vertices)} verts weighted")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    main_mesh.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    # explicit skin export; export_apply MUST stay False (True bakes/freezes the deform, dropping the skin)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB", use_selection=True,
        export_skins=True, export_apply=False, export_yup=True,
    )
    log(f"exported → {out}")

    if not verify_glb_is_rigged(out):
        sys.exit(2)
    log(f"✅ {out}")
    print(out)

if __name__ == "__main__":
    main()
