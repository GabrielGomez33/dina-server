#!/usr/bin/env python3
# ============================================================================
# saga-3d-reskin.py — recompute skin weights with Blender bone-heat, keeping the
# existing armature. Fixes hard-weight CRUMPLING at joints (an auto-rigger's skin
# weights often have sharp boundaries that fold/self-intersect when posed;
# bone-heat gives smooth gradients so joints crease smoothly).
#
#   blender -b -P saga-3d-reskin.py -- --in alien_rigged.glb --out alien_reskinned.glb
# ============================================================================
import bpy, sys, os

def argv(): return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def log(*a): print("  [reskin]", *a, file=sys.stderr, flush=True)

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
    log(f"armature: {arm.name}  bones: {len(arm.data.bones)}  meshes: {[m.name for m in meshes]}")

    for mesh in meshes:
        # strip existing armature modifiers + weights
        for md in list(mesh.modifiers):
            if md.type == "ARMATURE":
                mesh.modifiers.remove(md)
        mesh.vertex_groups.clear()
        # re-parent to the armature with automatic (bone-heat) weights
        bpy.ops.object.select_all(action="DESELECT")
        mesh.select_set(True); arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        ng = len(mesh.vertex_groups)
        log(f"  {mesh.name}: bone-heat weights → {ng} vertex groups")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True)
    log(f"✅ {out}")
    print(out)

if __name__ == "__main__":
    main()
