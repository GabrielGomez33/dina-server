#!/usr/bin/env python3
# ============================================================================
# saga-3d-rig-inspect.py — dump a rigged GLB's armature so poses can target the
# RIGHT bone and the RIGHT rotation axis. A pose that produces no visible motion
# is almost always (a) the wrong bone name, or (b) rotating about the bone's
# LONG axis (a twist, invisible on a smooth limb) instead of the swing axis.
#
# For each bone it prints, in Blender WORLD space (glTF Y-up is imported as
# Z-up, so height = Z, character width = X, depth = Y):
#   • parent, head, tail, length
#   • the world-space direction of the bone's LOCAL x/y/z axes (what
#     rotation_euler rotates about) and which WORLD axis each aligns with.
#
# Reading it: to RAISE/LOWER an arm you rotate in the vertical (X–Z) plane, i.e.
# about WORLD Y — so the pose axis to use is whichever LOCAL axis aligns with
# world ±Y. To swing a leg forward/back you rotate about world X, etc. The
# "swing↕ (raise/lower)" hint names the local axis aligned with world Y for you.
#
#   blender -b -P saga-3d-rig-inspect.py -- --in alien_reskinned.glb
#   blender -b -P saga-3d-rig-inspect.py -- --in alien_reskinned.glb --bone bone_6
# ============================================================================
import bpy, sys, os, math

def argv(): return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def log(*a): print(*a, file=sys.stderr, flush=True)

AXES = {"X": (1,0,0), "Y": (0,1,0), "Z": (0,0,1)}

def nearest_world_axis(v):
    """Return (label, signed_dot) of the world axis this unit vector aligns with."""
    best_l, best_d = "?", 0.0
    for l, a in AXES.items():
        d = v.x*a[0] + v.y*a[1] + v.z*a[2]
        if abs(d) > abs(best_d): best_l, best_d = l, d
    return f"{'+' if best_d>=0 else '-'}{best_l}", best_d

def fmt(v): return f"({v.x:+.3f}, {v.y:+.3f}, {v.z:+.3f})"

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--bone", default="", help="only this bone (else all)")
    args = ap.parse_args(argv())
    inp = os.path.abspath(args.inp)
    if not os.path.isfile(inp): log(f"❌ not found: {inp}"); sys.exit(1)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=inp)
    arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if arm is None: log("❌ no armature in file"); sys.exit(1)

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    M = arm.matrix_world

    log(f"armature: {arm.name}   bones: {len(arm.pose.bones)}   (world: Z=up/height, X=width, Y=depth)")
    log("=" * 100)
    for pb in arm.pose.bones:
        if args.bone and pb.name != args.bone: continue
        head = M @ pb.head; tail = M @ pb.tail
        length = (tail - head).length
        # local axis world directions (what rotation_euler x/y/z rotate about)
        xa, ya, za = (M.to_3x3() @ pb.x_axis).normalized(), \
                     (M.to_3x3() @ pb.y_axis).normalized(), \
                     (M.to_3x3() @ pb.z_axis).normalized()
        xl, _ = nearest_world_axis(xa); yl, _ = nearest_world_axis(ya); zl, _ = nearest_world_axis(za)
        # to RAISE/LOWER (rotate in X–Z plane) the rotation axis must point along world Y:
        swing = min((("x", xa), ("y", ya), ("z", za)), key=lambda t: 1 - abs(t[1].y))[0]
        parent = pb.parent.name if pb.parent else "-"
        log(f"{pb.name:10s} parent={parent:10s} len={length:.3f}  head={fmt(head)} tail={fmt(tail)}")
        log(f"           local X→world {fmt(xa)} [{xl}]   Y→{fmt(ya)} [{yl}]   Z→{fmt(za)} [{zl}]")
        log(f"           ↳ swing↕ (raise/lower this bone) = rotate about LOCAL {swing.upper()}")
        log("-" * 100)

if __name__ == "__main__":
    main()
