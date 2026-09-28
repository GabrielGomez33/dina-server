#!/usr/bin/env python3
# ============================================================================
# saga-3d-remesh.py — Blender-headless clean/remesh of a TRELLIS mesh (STAGE 2).
# ----------------------------------------------------------------------------
# TRELLIS gives a dense, non-uniform TRIANGLE SOUP (~470k faces). That skins and
# poses badly (tears at the stub joints) and is heavy. This turns it into a
# clean, watertight, evenly-tessellated, rigging-ready mesh:
#   join → (optional rot) → pre-clean (merge/loose/normals) → VOXEL remesh
#   (watertight, uniform, drops floating artifacts like the jagged tuft tip) →
#   QUADRIFLOW (clean quads for deformation) or DECIMATE (fast tris) → shade
#   smooth → NORMALIZE (center X/Y, floor to Z=0, scale to a target height).
# The mesh is a POSE PROXY (drives depth/lineart), so we keep geometry only and
# drop materials/textures.
#
# Run (headless; Blender 4.x):
#   blender -b -P saga-3d-remesh.py -- --in little_one.glb --out little_one_clean.glb \
#           --blend little_one_clean.blend
# Tunables:
#   --voxel-res N     voxels across the largest dimension (default 220; higher = finer, keeps the
#                     tuft/flippers sharper but heavier). --no-remesh skips voxel remesh entirely.
#   --quad N          Quadriflow to ~N quad faces AFTER voxel remesh (clean edge flow for rigging).
#   --target-faces N  if not --quad: collapse-decimate to ~N tris (default 40000; 0 = no decimate).
#   --height H        normalize so the mesh is H Blender units tall (default 2.0).
#   --symmetric       enforce left/right (X) symmetry in Quadriflow (Little One is bilateral).
#   --rot-x DEG       extra X rotation if the import lands on its side (default 0; check the bbox print).
# ============================================================================
import bpy
import bmesh
import sys
import os
from mathutils import Vector


def argv_after_ddash():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def parse_args():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", default="")
    ap.add_argument("--blend", default="")
    ap.add_argument("--voxel-res", type=int, default=220)
    ap.add_argument("--no-remesh", action="store_true")
    ap.add_argument("--quad", type=int, default=0)
    ap.add_argument("--target-faces", type=int, default=40000)
    ap.add_argument("--height", type=float, default=2.0)
    ap.add_argument("--symmetric", action="store_true")
    ap.add_argument("--rot-x", type=float, default=0.0)
    return ap.parse_args(argv_after_ddash())


def log(*a):
    print("  [remesh]", *a, flush=True)


def world_bbox(obj):
    cs = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mn = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
    mx = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
    return mn, mx


def dims(obj):
    mn, mx = world_bbox(obj)
    return (mx - mn)


def only_mesh_objects():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_transforms(obj):
    select_only(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def preclean(obj, merge_dist):
    """Merge coincident verts, drop loose geometry, make normals consistent — via bmesh (version-safe)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist)
    # delete loose verts/edges (no linked faces)
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()


def voxel_remesh(obj, voxel_size):
    select_only(obj)
    me = obj.data
    me.remesh_voxel_size = voxel_size
    me.remesh_voxel_adaptivity = 0.0
    # use the object operator (respects the data settings above)
    bpy.ops.object.voxel_remesh()


def quadriflow(obj, target_faces, symmetric):
    select_only(obj)
    bpy.ops.object.quadriflow_remesh(
        target_faces=target_faces,
        use_mesh_symmetry=symmetric,
        use_preserve_sharp=False,
        use_preserve_boundary=False,
        seed=0,
    )


def decimate(obj, target_faces):
    nfaces = len(obj.data.polygons)
    if target_faces <= 0 or nfaces <= target_faces:
        return
    select_only(obj)
    m = obj.modifiers.new("dec", "DECIMATE")
    m.decimate_type = "COLLAPSE"
    m.ratio = max(0.01, float(target_faces) / float(nfaces))
    bpy.ops.object.modifier_apply(modifier="dec")


def normalize(obj, target_height):
    """Center X/Y on origin, sit the mesh on the floor (min Z = 0), scale to target height."""
    apply_transforms(obj)
    mn, mx = world_bbox(obj)
    h = (mx.z - mn.z) or 1.0
    s = target_height / h
    obj.scale = (s, s, s)
    apply_transforms(obj)
    mn, mx = world_bbox(obj)
    cx = (mn.x + mx.x) / 2.0
    cy = (mn.y + mx.y) / 2.0
    obj.location = (obj.location.x - cx, obj.location.y - cy, obj.location.z - mn.z)
    apply_transforms(obj)


def main():
    args = parse_args()
    inp = os.path.abspath(args.inp)
    out = os.path.abspath(args.out) if args.out else os.path.splitext(inp)[0] + "_clean.glb"
    if not os.path.isfile(inp):
        print(f"❌ input not found: {inp}", file=sys.stderr)
        sys.exit(1)

    bpy.ops.wm.read_factory_settings(use_empty=True)

    ext = os.path.splitext(inp)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=inp)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=inp)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=inp)
    else:
        print(f"❌ unsupported input: {ext}", file=sys.stderr)
        sys.exit(1)

    meshes = only_mesh_objects()
    if not meshes:
        print("❌ no mesh imported", file=sys.stderr)
        sys.exit(1)

    # join everything into one object
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "little_one"

    # drop materials/UVs — geometry proxy only
    obj.data.materials.clear()

    if abs(args.rot_x) > 1e-6:
        import math
        select_only(obj)
        obj.rotation_euler[0] += math.radians(args.rot_x)
    apply_transforms(obj)

    d0 = dims(obj)
    log(f"imported: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces  "
        f"bbox(WxDxH)={d0.x:.3f} x {d0.y:.3f} x {d0.z:.3f}  "
        f"(H should be the largest if upright)")

    # scale-relative merge distance for pre-clean
    merge = max(d0) * 0.0004
    preclean(obj, merge)

    if not args.no_remesh:
        vsize = max(d0) / max(16, args.voxel_res)
        log(f"voxel remesh: size={vsize:.5f} (res={args.voxel_res})")
        voxel_remesh(obj, vsize)
        log(f"after voxel: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")

    if args.quad and args.quad > 0:
        log(f"quadriflow → ~{args.quad} quads (symmetric={args.symmetric})")
        quadriflow(obj, args.quad, args.symmetric)
        log(f"after quadriflow: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")
    else:
        decimate(obj, args.target_faces)
        log(f"after decimate: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")

    select_only(obj)
    bpy.ops.object.shade_smooth()

    normalize(obj, args.height)
    dF = dims(obj)
    mn, mx = world_bbox(obj)
    log(f"normalized: bbox(WxDxH)={dF.x:.3f} x {dF.y:.3f} x {dF.z:.3f}  "
        f"floor z={mn.z:.3f}  center=({(mn.x + mx.x) / 2:.3f},{(mn.y + mx.y) / 2:.3f})")

    # export GLB (+ OBJ sibling) and optionally save .blend
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    select_only(obj)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True)
    obj_path = os.path.splitext(out)[0] + ".obj"
    bpy.ops.wm.obj_export(filepath=obj_path, export_selected_objects=True)
    log(f"✅ wrote {out}")
    log(f"✅ wrote {obj_path}")
    if args.blend:
        blend = os.path.abspath(args.blend)
        bpy.ops.wm.save_as_mainfile(filepath=blend)
        log(f"✅ wrote {blend}")

    print(f"CLEAN_MESH {out}", flush=True)


if __name__ == "__main__":
    main()
