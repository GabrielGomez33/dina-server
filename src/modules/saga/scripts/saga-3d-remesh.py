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
    ap.add_argument("--symmetrize", action="store_true",
                    help="enforce exact bilateral symmetry (Blender mesh.symmetrize across the wider horizontal axis)")
    ap.add_argument("--no-upright", action="store_true",
                    help="skip auto-upright (rotate the longest axis to vertical, head up)")
    ap.add_argument("--flip", action="store_true", help="180° about X after upright (if it lands head-down)")
    ap.add_argument("--rot-x", type=float, default=0.0, help="manual X rotation (deg); disables auto-upright")
    ap.add_argument("--rot-y", type=float, default=0.0)
    ap.add_argument("--rot-z", type=float, default=0.0)
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


def keep_largest_component(obj):
    """Delete all but the largest connected face-island (removes voxel-remesh specks). Returns island count."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    visited = set()
    islands = []
    for f in bm.faces:
        if f in visited:
            continue
        stack = [f]
        comp = []
        while stack:
            cf = stack.pop()
            if cf in visited:
                continue
            visited.add(cf)
            comp.append(cf)
            for e in cf.edges:
                for lf in e.link_faces:
                    if lf not in visited:
                        stack.append(lf)
        islands.append(comp)
    n = len(islands)
    if n > 1:
        islands.sort(key=len, reverse=True)
        dead = [f for comp in islands[1:] for f in comp]
        bmesh.ops.delete(bm, geom=dead, context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()
    return n


def auto_upright(obj, flip):
    """Rotate so the LONGEST bbox axis is vertical (Blender Z), head up. Little One is taller than wide,
    so the longest extent is its height. Returns a short description of what happened."""
    import math
    apply_transforms(obj)
    d = dims(obj)
    up = max(range(3), key=lambda i: d[i])  # 0=X 1=Y 2=Z
    select_only(obj)
    if up == 1:      # Y longest → bring to Z. -90° about X sends -Y (the inferred head) to +Z (up).
        obj.rotation_euler = (math.radians(-90), 0, 0)
    elif up == 0:    # X longest → bring to Z.
        obj.rotation_euler = (0, math.radians(90), 0)
    # up == 2 already vertical → no rotation
    if flip:
        obj.rotation_euler.rotate_axis("X", math.radians(180))
    apply_transforms(obj)
    return {0: "X", 1: "Y", 2: "Z"}[up]


def symmetrize_mesh(obj, axis):
    """Exact bilateral symmetry via Blender's robust bisect+mirror+weld. axis in {'X','Y'} (up is Z)."""
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.symmetrize(direction="POSITIVE_" + axis)   # keep +axis half, mirror onto -axis
    bpy.ops.mesh.remove_doubles(threshold=1e-4)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

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

    d_raw = dims(obj)
    log(f"imported: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces  "
        f"raw XYZ extents={d_raw.x:.3f} x {d_raw.y:.3f} x {d_raw.z:.3f}")

    # orient upright: manual rotation if any --rot-* given, else auto (longest axis → vertical, head up)
    manual = abs(args.rot_x) > 1e-6 or abs(args.rot_y) > 1e-6 or abs(args.rot_z) > 1e-6
    if manual:
        import math
        select_only(obj)
        obj.rotation_euler = (math.radians(args.rot_x), math.radians(args.rot_y), math.radians(args.rot_z))
        apply_transforms(obj)
        log(f"manual rotation applied: ({args.rot_x},{args.rot_y},{args.rot_z})°")
    elif not args.no_upright:
        longest = auto_upright(obj, args.flip)
        log(f"auto-upright: longest axis was {longest} → now vertical (Blender Z){' +flip' if args.flip else ''}")

    d0 = dims(obj)
    log(f"oriented: bbox(WxDxH)={d0.x:.3f} x {d0.y:.3f} x {d0.z:.3f}  (H=Z should now be the largest)")

    # scale-relative merge distance for pre-clean
    merge = max(d0) * 0.0004
    preclean(obj, merge)

    if not args.no_remesh:
        vsize = max(d0) / max(16, args.voxel_res)
        log(f"voxel remesh: size={vsize:.5f} (res={args.voxel_res})")
        voxel_remesh(obj, vsize)
        log(f"after voxel: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")
        islands = keep_largest_component(obj)
        if islands > 1:
            log(f"kept largest of {islands} islands (removed {islands - 1} floating speck(s))")

    if args.quad and args.quad > 0:
        log(f"quadriflow → ~{args.quad} quads (symmetric={args.symmetric})")
        quadriflow(obj, args.quad, args.symmetric)
        log(f"after quadriflow: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")
    else:
        decimate(obj, args.target_faces)
        log(f"after decimate: {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")

    select_only(obj)
    bpy.ops.object.shade_smooth()

    if args.symmetrize:
        d=dims(obj); ax = "X" if d.x >= d.y else "Y"   # wider horizontal axis = left-right (up is Z)
        symmetrize_mesh(obj, ax)
        log(f"symmetrized across {ax}=0 → {len(obj.data.vertices)} verts / {len(obj.data.polygons)} faces")

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
