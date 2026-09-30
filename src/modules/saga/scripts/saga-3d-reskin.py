#!/usr/bin/env python3
# ============================================================================
# saga-3d-reskin.py — recompute skin weights with Blender bone-heat, keeping the
# existing armature. Fixes hard-weight CRUMPLING at joints (an auto-rigger's skin
# weights often have sharp boundaries that fold/self-intersect when posed;
# bone-heat gives smooth gradients so joints crease smoothly).
#
#   blender -b -P saga-3d-reskin.py -- --in alien_rigged.glb --out alien_reskinned.glb
#
# HARD REQUIREMENT: the output GLB must round-trip as a real rig. glTF has no
# "armature" — it stores joint NODES + a SKIN (weights + inverse-bind matrices),
# and Blender only rebuilds an Armature on import if that skin is present. If the
# skin is dropped, the joints re-import as plain EMPTY objects and the mesh is
# static — silently un-poseable. So after export we RE-IMPORT and assert a real
# armature with a skinned mesh exists; if not, we exit non-zero.
# ============================================================================
import bpy, sys, os

def argv(): return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def log(*a): print("  [reskin]", *a, file=sys.stderr, flush=True)

def has_armature_mod(mesh, arm):
    return any(md.type == "ARMATURE" and md.object == arm for md in mesh.modifiers)

def total_weighted_verts(mesh):
    n = 0
    for v in mesh.data.vertices:
        if any(g.weight > 0.0 for g in v.groups):
            n += 1
    return n

def verify_glb_is_rigged(path):
    """Fresh-scene re-import and assert a real Armature + skinned mesh exist."""
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
    log(f"✅ verify ok: '{arms[0].name}' bones={len(arms[0].data.bones)}, "
        f"mesh '{skinned[0].name}' is skinned")
    return True

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", default="")
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

    # keep only the main character mesh (most verts); delete stray junk (e.g. UniRig's Icosphere)
    main_mesh = max(meshes, key=lambda m: len(m.data.vertices))
    for m in meshes:
        if m is not main_mesh:
            log(f"removing stray mesh '{m.name}' ({len(m.data.vertices)} verts)")
            bpy.data.objects.remove(m, do_unlink=True)
    log(f"armature: {arm.name}  bones: {len(arm.data.bones)}  mesh: '{main_mesh.name}' "
        f"({len(main_mesh.data.vertices)} verts)")

    # strip existing armature modifiers + weights, then re-parent with bone-heat weights
    for md in list(main_mesh.modifiers):
        if md.type == "ARMATURE":
            main_mesh.modifiers.remove(md)
    main_mesh.vertex_groups.clear()

    bpy.ops.object.select_all(action="DESELECT")
    main_mesh.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")   # bone-heat automatic weights

    ng = len(main_mesh.vertex_groups)
    wv = total_weighted_verts(main_mesh)
    log(f"bone-heat: {ng} vertex groups, {wv}/{len(main_mesh.data.vertices)} verts weighted")

    # ARMATURE_AUTO adds the deform modifier; if bone-heat failed to create it, add it explicitly
    # so the glTF exporter still writes a skin (better a hard-bound mesh than an unrigged one).
    if not has_armature_mod(main_mesh, arm):
        log("⚠ bone-heat did not leave an armature modifier — adding one explicitly")
        mod = main_mesh.modifiers.new(name="Armature", type="ARMATURE")
        mod.object = arm
    if wv == 0:
        log("⚠ ZERO weighted verts — bone-heat found no solution; deformation will be wrong. "
            "The mesh may be non-manifold/have loose geometry. Continuing so the rig still exports.")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    main_mesh.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    # explicit skin export; export_apply MUST stay False (True would bake/freeze the deform and drop the skin)
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
