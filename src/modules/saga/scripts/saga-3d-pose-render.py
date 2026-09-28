#!/usr/bin/env python3
# ============================================================================
# saga-3d-pose-render.py — pose the rigged puppet and render ControlNet signals (STAGE 4).
# ----------------------------------------------------------------------------
# Loads the UniRig-rigged GLB, optionally applies a POSE (bone rotations), places
# cameras around the character, and renders — per pose × camera — the control
# signals that drive diffusion downstream:
#   • depth  : camera-distance grayscale (near=bright)         → ControlNet depth
#   • lineart: Freestyle black outline on white                → ControlNet lineart/canny
#   • clay   : neutral matte render (our eyes-only reference)
# The mesh is a PROXY: these grey/line passes become the on-brand charcoal frame
# when fed to Flux (+ character LoRA) in Stage 5. Nothing here is the final look.
#
# Run (headless, Blender 4.x with GPU):
#   blender -b -P saga-3d-pose-render.py -- --in little_one_rigged.glb --out renders \
#           --pose rest --cams front,3q_l,3q_r,side_l --passes depth,lineart,clay
#   # calibrate a joint's local axis (learn which way a bone swings):
#   blender -b -P saga-3d-pose-render.py -- --in ... --out cal --rot "bone_6:z-45" --cams front
#
# --list-poses prints the built-in library. --rot overrides/augments a pose ad hoc
# ("bone:AxisDeg,.." e.g. "bone_6:z-45,bone_7:z-30"; axis x|y|z, degrees, bone-local).
# Bone roles for Little One (from the UniRig hierarchy): root=bone_0; spine=1,2,3;
# head=4,tuft=5; armR=6..9; armL=10..13; legR=14..17; legL=18..21.
# ============================================================================
import bpy, sys, os, math
from mathutils import Vector

def argv():
    return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []

def parse_args():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", default="renders")
    ap.add_argument("--pose", default="rest")
    ap.add_argument("--rot", default="", help="ad hoc bone rotations 'bone:axisDeg,..' e.g. bone_6:z-45")
    ap.add_argument("--cams", default="front,3q_l,3q_r,side_l", help="comma list of named angles")
    ap.add_argument("--passes", default="depth,lineart,clay")
    ap.add_argument("--res", type=int, default=768)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--list-poses", action="store_true")
    return ap.parse_args(argv())

def log(*a): print("  [pose-render]", *a, file=sys.stderr, flush=True)

# ---- camera angles: (azimuth deg around Y-up, elevation deg) ----
CAMS = {
    "front": (0, 0), "back": (180, 0),
    "3q_l": (-35, 8), "3q_r": (35, 8),
    "side_l": (-90, 0), "side_r": (90, 0),
    "high": (0, 45), "low": (0, -18),
}

# ---- pose library: role → list of (bone, axis, degrees) local rotations. Refined after axis calibration. ----
# 'rest' is the bind pose (validates skin/cameras/passes). The action poses are FIRST GUESSES at the bone
# local axes; the first calibration render tells us the true axis/sign and we correct these in place.
POSES = {
    "rest": [],
    "reach": [("bone_6","z",-70),("bone_7","z",-25),("bone_10","z",70),("bone_11","z",25),("bone_4","x",-12)],
    "crouch": [("bone_1","x",25),("bone_14","x",50),("bone_15","x",-70),("bone_18","x",50),("bone_19","x",-70)],
    "jump": [("bone_6","z",-55),("bone_10","z",55),("bone_14","x",30),("bone_15","x",-40),
             ("bone_18","x",30),("bone_19","x",-40),("bone_4","x",-15)],
    "run": [("bone_6","z",-35),("bone_10","z",20),("bone_14","x",35),("bone_18","x",-35),("bone_1","x",12)],
    "wave": [("bone_6","z",-95),("bone_7","z",-30),("bone_4","z",8)],
}

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def import_glb(p):
    bpy.ops.import_scene.gltf(filepath=p)

def find_objs():
    arm = next((o for o in bpy.data.objects if o.type=="ARMATURE"), None)
    meshes = [o for o in bpy.data.objects if o.type=="MESH"]
    return arm, meshes

def world_bbox(meshes):
    lo = Vector(( 1e9, 1e9, 1e9)); hi = Vector((-1e9,-1e9,-1e9))
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo.x,w.x),min(lo.y,w.y),min(lo.z,w.z)))
            hi = Vector((max(hi.x,w.x),max(hi.y,w.y),max(hi.z,w.z)))
    return lo, hi

def apply_pose(arm, ops):
    if arm is None: return
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:                       # reset to rest
        pb.rotation_mode = "XYZ"; pb.rotation_euler = (0,0,0)
    ax = {"x":0,"y":1,"z":2}
    for bone, axis, deg in ops:
        pb = arm.pose.bones.get(bone)
        if pb is None: log(f"⚠ no bone '{bone}'"); continue
        e = list(pb.rotation_euler); e[ax[axis]] += math.radians(deg); pb.rotation_euler = e
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()

def setup_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dt in ("OPTIX","CUDA"):
        try:
            prefs.compute_device_type = dt; prefs.get_devices()
            if any(d.type==dt for d in prefs.devices):
                for d in prefs.devices: d.use = (d.type==dt)
                scene.cycles.device = "GPU"; log(f"GPU: {dt}"); return
        except Exception as e:
            log(f"{dt} unavailable: {e}")
    scene.cycles.device = "CPU"; log("GPU not available → CPU")

def place_camera(center, size, az, el, res):
    cam_data = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam_data.lens = 50; cam_data.sensor_width = 36
    fov = 2*math.atan(cam_data.sensor_width/2/cam_data.lens)
    R = (size*1.15/2)/math.tan(fov/2) + size*0.5     # frame the character with margin
    a, e = math.radians(az), math.radians(el)
    pos = Vector((center.x + R*math.cos(e)*math.sin(a),
                  center.y + R*math.sin(e),
                  center.z + R*math.cos(e)*math.cos(a)))
    cam.location = pos
    d = (center - pos).normalized()
    cam.rotation_euler = d.to_track_quat("-Z","Y").to_euler()
    bpy.context.scene.camera = cam
    return cam

def all_mesh_materials(meshes, mat):
    for o in meshes:
        o.data.materials.clear(); o.data.materials.append(mat)

def mat_clay():
    m = bpy.data.materials.new("clay"); m.use_nodes=True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.8,0.8,0.82,1)
    bsdf.inputs["Roughness"].default_value = 0.8
    return m

def mat_white_emit():
    m = bpy.data.materials.new("white"); m.use_nodes=True
    nt=m.node_tree; nt.nodes.clear()
    e=nt.nodes.new("ShaderNodeEmission"); e.inputs["Color"].default_value=(1,1,1,1); e.inputs["Strength"].default_value=1.0
    o=nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs["Emission"],o.inputs["Surface"])
    return m

def mat_depth(near, far):
    m = bpy.data.materials.new("depth"); m.use_nodes=True
    nt=m.node_tree; nt.nodes.clear()
    cam=nt.nodes.new("ShaderNodeCameraData")
    mr=nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value=near; mr.inputs["From Max"].default_value=far
    mr.inputs["To Min"].default_value=1.0;   mr.inputs["To Max"].default_value=0.0   # near=white, far=black
    nt.links.new(cam.outputs["View Z Depth"], mr.inputs["Value"])
    e=nt.nodes.new("ShaderNodeEmission"); nt.links.new(mr.outputs["Result"], e.inputs["Color"])
    o=nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs["Emission"], o.inputs["Surface"])
    return m

def set_world(color):
    w = bpy.data.worlds.new("w"); w.use_nodes=True
    bg=w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value=(*color,1); bg.inputs["Strength"].default_value=1.0
    bpy.context.scene.world=w

def add_key_light(center, size):
    l=bpy.data.lights.new("key","SUN"); l.energy=3.0
    o=bpy.data.objects.new("key",l); bpy.context.scene.collection.objects.link(o)
    o.rotation_euler=(math.radians(55),0,math.radians(30))

def render_to(path, scene, res, samples):
    scene.render.resolution_x=res; scene.render.resolution_y=res
    scene.render.image_settings.file_format="PNG"
    scene.cycles.samples=samples
    scene.render.filepath=path
    bpy.ops.render.render(write_still=True)

def main():
    args = parse_args()
    if args.list_poses:
        print("poses:", ", ".join(POSES)); return
    inp=os.path.abspath(args.inp); outd=os.path.abspath(args.out); os.makedirs(outd, exist_ok=True)
    ops = list(POSES.get(args.pose, []))
    if args.rot:
        for tok in args.rot.split(","):
            b,spec=tok.split(":"); ops.append((b, spec[0].lower(), float(spec[1:])))
    cams=[c.strip() for c in args.cams.split(",") if c.strip()]
    passes=[p.strip() for p in args.passes.split(",") if p.strip()]

    clear_scene(); import_glb(inp)
    arm, meshes = find_objs()
    if not meshes: log("❌ no mesh imported"); sys.exit(1)
    log(f"armature: {arm.name if arm else 'NONE'}   meshes: {[m.name for m in meshes]}")
    apply_pose(arm, ops)
    lo,hi = world_bbox(meshes); center=(lo+hi)/2; size=max((hi-lo).x,(hi-lo).y,(hi-lo).z)
    log(f"pose='{args.pose}'{' +rot' if args.rot else ''}  bbox size={size:.2f}  cams={cams}  passes={passes}")

    scene=bpy.context.scene
    setup_gpu(scene)
    scene.render.film_transparent=False
    depth_mat=mat_depth(size*0.4, size*1.8); white_mat=mat_white_emit(); clay_mat=mat_clay()

    for cname in cams:
        if cname not in CAMS: log(f"⚠ unknown cam '{cname}'"); continue
        az,el=CAMS[cname]
        # fresh camera each angle
        for o in [o for o in bpy.data.objects if o.type=="CAMERA"]: bpy.data.objects.remove(o, do_unlink=True)
        place_camera(center, size, az, el, args.res)
        for p in passes:
            tag=f"{args.pose}_{cname}_{p}"
            if p=="depth":
                scene.render.use_freestyle=False; set_world((0,0,0)); all_mesh_materials(meshes, depth_mat)
                render_to(os.path.join(outd,tag+".png"), scene, args.res, 1)
            elif p=="lineart":
                scene.render.use_freestyle=True
                vl=scene.view_layers[0]; vl.use_freestyle=True
                scene.render.line_thickness=1.4
                set_world((1,1,1)); all_mesh_materials(meshes, white_mat)
                render_to(os.path.join(outd,tag+".png"), scene, args.res, 1)
                scene.render.use_freestyle=False
            elif p=="clay":
                scene.render.use_freestyle=False; set_world((0.05,0.05,0.06)); all_mesh_materials(meshes, clay_mat)
                for o in [o for o in bpy.data.objects if o.type=="LIGHT"]: bpy.data.objects.remove(o, do_unlink=True)
                add_key_light(center,size)
                render_to(os.path.join(outd,tag+".png"), scene, args.res, args.samples)
            log(f"✅ {tag}.png")
    print(f"RENDERS {outd}")

if __name__ == "__main__":
    main()
