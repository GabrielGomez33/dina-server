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

def voxel_remesh(mesh, voxel):
    """Rebuild the surface as a GUARANTEED watertight manifold via voxel remesh.
    A volumetric re-surface cannot preserve a seam/crack/hole (they're re-filled
    from the solid), so it permanently eliminates the TRELLIS front/back seam that
    tears open when posed — and smooths generation bumps in the same step. New
    uniform topology; the armature modifier + vertex groups are dropped here and
    recomputed by bone-heat afterwards. Headless-safe (modifier_apply on the
    active object). Smaller voxel = more detail (keep thin antennae/fingers)."""
    for md in list(mesh.modifiers):
        mesh.modifiers.remove(md)
    mesh.vertex_groups.clear()
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True); bpy.context.view_layer.objects.active = mesh
    mod = mesh.modifiers.new(name="Remesh", type="REMESH")
    mod.mode = "VOXEL"; mod.voxel_size = voxel; mod.use_smooth_shade = True
    before = len(mesh.data.vertices)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    log(f"voxel remesh @ {voxel}: {before} -> {len(mesh.data.vertices)} verts (watertight)")

def smooth_surface(mesh, iters, factor=0.5):
    """Laplacian smoothing of VERTEX POSITIONS to knock down the raw TRELLIS
    generation bumps for a cleaner depth/lineart control signal. Topology is
    unchanged, so skin weights are preserved. Headless-safe (bmesh)."""
    if iters <= 0:
        return
    me = mesh.data
    bm = bmesh.new(); bm.from_mesh(me)
    for _ in range(iters):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=factor,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(me); bm.free(); me.update()
    log(f"surface smooth: {iters} passes @ factor {factor}")

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

def clamp_bone_weights(mesh, bone_names, x_abs):
    """Zero the named bones' skin weight on central-torso verts (|x| < x_abs in bind
    pose), then renormalize. Confines shoulder/arm bones whose heads sit inside the
    chest to the arm, so lifting the arm no longer drags and folds the chest. NumPy,
    headless-safe. x_abs is in the mesh's own units (the character stands arms-out)."""
    import numpy as np
    me = mesh.data
    nv = len(me.vertices)
    vgs = list(mesh.vertex_groups)
    col = {vg.index: k for k, vg in enumerate(vgs)}
    clampcols = [k for k, vg in enumerate(vgs) if vg.name in set(bone_names)]
    if not clampcols:
        log(f"⚠ clamp: none of {bone_names} found as vertex groups"); return
    W = np.zeros((nv, len(vgs)), np.float32)
    for v in me.vertices:
        for g in v.groups:
            c = col.get(g.group)
            if c is not None: W[v.index, c] = g.weight
    co = np.empty(nv * 3); me.vertices.foreach_get("co", co); X = co.reshape(-1, 3)[:, 0]
    inb = np.abs(X) < x_abs
    W[np.ix_(inb, clampcols)] = 0.0
    rs = W.sum(1, keepdims=True); nz = rs[:, 0] > 1e-8; W[nz] = W[nz] / rs[nz]
    ai = list(range(nv))
    for vg in vgs: vg.remove(ai)
    Wq = np.rint(W * 255).astype(np.int32); ar = np.arange(nv)
    for c, vg in enumerate(vgs):
        wc = Wq[:, c]
        for b in range(1, 256):
            sel = ar[wc == b]
            if sel.size: vg.add(sel.tolist(), b / 255, "REPLACE")
    log(f"clamp {list(bone_names)} off central torso: {int(inb.sum())} verts cleared (|x|<{x_abs})")

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
                    help="optional post-boneheat weight-smoothing passes to soften residual joint creases (0 = none)")
    ap.add_argument("--smooth-surface", dest="smooth_surface", type=int, default=0,
                    help="Laplacian vertex-position smoothing passes to remove generation bumps (0 = none)")
    ap.add_argument("--surface-factor", dest="surface_factor", type=float, default=0.5,
                    help="strength of each surface-smoothing pass 0..1")
    ap.add_argument("--iters", type=int, default=20, help="smooth-method weight-smoothing passes")
    ap.add_argument("--factor", type=float, default=0.5, help="per-pass smoothing strength 0..1")
    ap.add_argument("--weld", type=float, default=1e-4,
                    help="merge-by-distance epsilon to repair UniRig triangle-soup (0 = skip welding)")
    ap.add_argument("--remesh", type=float, default=0.0,
                    help="voxel size for a watertight voxel-remesh after welding (0 = off; "
                         "~0.012 keeps thin antennae/fingers while killing seams/cracks and bumps)")
    ap.add_argument("--clamp-arms", dest="clamp_arms", default="",
                    help="comma bone names whose weight is removed from the central torso "
                         "(e.g. the shoulder bones that sit inside the chest), to stop arm motion "
                         "dragging/folding the chest, e.g. 'bone_6,bone_13'")
    ap.add_argument("--clamp-x", dest="clamp_x", type=float, default=0.3,
                    help="|x| below which --clamp-arms bones are cleared (bind-pose units)")
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

    # optional: voxel-remesh to a guaranteed watertight manifold (kills seams/cracks/holes
    # and bumps). Drops weights → recomputed by bone-heat below. Do it before smoothing.
    if args.remesh and args.remesh > 0:
        voxel_remesh(main_mesh, args.remesh)

    # optional: smooth generation bumps out of the surface (positions only; weights preserved)
    if args.smooth_surface > 0:
        smooth_surface(main_mesh, args.smooth_surface, args.surface_factor)

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

    # targeted clamp: pull shoulder/arm bones off the central torso so arm motion
    # doesn't drag and fold the chest (their heads sit inside the chest on this character)
    if args.clamp_arms.strip():
        clamp_bone_weights(main_mesh, [b.strip() for b in args.clamp_arms.split(",") if b.strip()], args.clamp_x)

    wv1 = total_weighted_verts(main_mesh)
    log(f"after reskin: {wv1}/{len(main_mesh.data.vertices)} verts weighted")

    # SMOOTH SHADING before export is REQUIRED: with flat faces the glTF exporter writes a
    # separate vertex per face corner (re-souping our welded mesh back to ~3x verts), which
    # breaks any downstream per-surface op. Smooth shading shares the vertex normal so the
    # exporter keeps shared (welded) vertices — the file stays ~40k and truly connected.
    for p in main_mesh.data.polygons:
        p.use_smooth = True

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
