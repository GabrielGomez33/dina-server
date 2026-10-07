#!/usr/bin/env python3
# ============================================================================
# saga-3d-pose-render.py — pose the rigged puppet and render ControlNet signals (STAGE 4).
# ----------------------------------------------------------------------------
# Loads the UniRig-rigged GLB, optionally applies a POSE (bone rotations), places
# cameras around the character, and renders — per pose × camera — the control
# signals that drive diffusion downstream:
#   • depth  : camera-distance grayscale (near=bright)         → ControlNet depth
#   • lineart: compositor Sobel edge, black-on-white           → ControlNet lineart/canny
#   • clay   : neutral matte render (eyes-only ref; also a clean source for
#              ComfyUI canny/softedge/normal preprocessors)
# The mesh is a PROXY: these grey/line passes become the on-brand charcoal frame
# when fed to Flux (+ character LoRA) in Stage 5. Nothing here is the final look.
#
# CRITICAL: view transform is forced to STANDARD (linear) so depth/lineart aren't
# tone-mapped by AgX (a control signal must be linear). Depth range is calibrated
# to the actual CAMERA distance (View Z Depth is camera-relative, ~2× model size).
#
# Run (headless, Blender 4.x with GPU):
#   blender -b -P saga-3d-pose-render.py -- --in little_one_rigged.glb --out renders \
#           --pose rest --cams front,3q_l,3q_r,side_l --passes depth,lineart,clay
#   # calibrate a joint's local axis (learn which way a bone swings):
#   blender -b -P saga-3d-pose-render.py -- --in ... --out cal --rot "bone_6:z-45" --cams front --passes clay
#
# --list-poses prints the library. --rot augments a pose ad hoc ("bone:AxisDeg,.."
# e.g. "bone_6:z-45,bone_7:z-30"; axis x|y|z, degrees, bone-local).
# Little One bone roles (UniRig hierarchy): root=bone_0; spine=1,2,3; head=4,tuft=5;
# armR=6..9; armL=10..13; legR=14..17; legL=18..21.
# ============================================================================
import bpy, sys, os, math
from mathutils import Vector, Matrix

def argv():
    return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []

def parse_args():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", default="renders")
    ap.add_argument("--pose", default="rest")
    ap.add_argument("--label", default="",
                    help="prefix for every output filename (e.g. a sweep angle) so batch runs into one "
                         "--out dir never collide when flattened by scp")
    ap.add_argument("--rot", default="")
    ap.add_argument("--aim", default="",
                    help="ad-hoc AIM calibration, applied on top of --pose, as "
                         "'bone:x,y,z;bone:x,y,z' — each bone's head->tail is swung to "
                         "point along WORLD dir (x,y,z) [+X=right,-Y=forward,+Z=up]. "
                         "Use to validate one bone before trusting a full pose.")
    ap.add_argument("--cams", default="front,3q_l,3q_r,side_l")
    ap.add_argument("--passes", default="depth,lineart,clay")
    ap.add_argument("--res", type=int, default=768)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--smooth-deform", type=float, default=0.65,
                    help="Corrective-Smooth factor applied to the DEFORMED mesh before render "
                         "(0 disables). Heals shoulder/armpit pinching & tearing that bad skin "
                         "weights cause when a limb swings far. Proxy only — safe to smooth.")
    ap.add_argument("--smooth-iters", type=int, default=20)
    ap.add_argument("--subsurf", type=int, default=0,
                    help="Subdivision-surface levels for a smooth render surface on the "
                         "low-poly proxy (0=off). Applied last, after corrective smooth.")
    ap.add_argument("--list-poses", action="store_true")
    return ap.parse_args(argv())

def log(*a): print("  [pose-render]", *a, file=sys.stderr, flush=True)

CAMS = {
    "front": (0, 0), "back": (180, 0),
    "3q_l": (-35, 8), "3q_r": (35, 8),
    "side_l": (-90, 0), "side_r": (90, 0),
    "high": (0, 45), "low": (0, -18),
}

# ALIEN rig (T-pose, bone-heat skin). Bone roles read from the rig's rest axes:
#   shoulders bone_6 (R) / bone_13 (L), elbows bone_7 / bone_14;
#   hips bone_20 (R) / bone_24 (L), knees bone_21 / bone_25; spine bone_1; head bone_4.
# Arms swing up/down about LOCAL X (SAME sign both sides: +X raise, -X lower) and fwd/back about local Z.
# Legs & spine swing about local X. Magnitudes/signs are estimates confirmed by render, then finalized.
# Poses are authored INSIDE this character's safe range of motion. Its arms mount at
# the base of a giant head with no neck, so they CANNOT go overhead (they enter the
# head) and CANNOT go fully straight-down (they enter the wide belly). Caps used:
#   arm raise  ≲ +30  (hand stays clear of the head)
#   arm lower  ≳ -60  (hand stays clear of the belly)
#   spine/neck bends kept gentle so the thin neck doesn't crease/self-intersect.
# +X raises an arm, -X lowers it (both shoulders same sign: bone_6 R, bone_13 L).
# ALIEN rig — pose library authored from the MEASURED aim→result map (saga-3d-aimcal.sh)
# and the rig geometry (saga-3d-rig-inspect.py). Every action pose uses AIM:
#   ("aim", bone, (x,y,z)) swings that bone's head→tail to point along a WORLD direction
#   — +X=char-right, −Y=forward/face, +Z=up — via a shortest-arc rotation (no flip/twist).
# Confirmed bone response:
#   ARM upper bone_6(R)/bone_13(L): Yf→forward, Yb→back, Xr/Xl→out/across, Zu→up, Zd→down;
#     forearm bone_7/14, hand bone_8/15, fingers 9-12/16-19 (curled by the "fist" op).
#   LEG thigh bone_20(R)/bone_24(L): Yf→knee lifts forward, Xr/Xl→abduct/adduct, Yb→back,
#     Zd→down; shin bone_21/25, foot bone_22/26, toe bone_23/27.  spine bone_1, head bone_4.
# Ops run parent→child in order (view layer updates between), so chains follow.
POSES = {
    "rest":      [],                                             # T-pose (bind)
    "arms_down": [("aim","bone_6",( 0.35,0.0,-1.0)),("aim","bone_7",( 0.25,0.0,-1.0)),("aim","bone_8",( 0.15,0.0,-1.0)),
                  ("aim","bone_13",(-0.35,0.0,-1.0)),("aim","bone_14",(-0.25,0.0,-1.0)),("aim","bone_15",(-0.15,0.0,-1.0))],
    "reach":     [("bone_6","x",28),("bone_13","x",28),("bone_4","x",-8)],    # (euler; untouched)
    "wave":      [("bone_6","x",-55),("bone_13","x",28),("bone_14","x",22)],  # (euler; untouched)
    "crouch":    [("bone_1","x",12),("bone_6","x",-45),("bone_13","x",-45),
                  ("bone_20","x",38),("bone_21","x",-55),("bone_22","x",20),
                  ("bone_24","x",38),("bone_25","x",-55),("bone_26","x",20)],
    "run":       [("bone_6","x",-30),("bone_13","x",-45),("bone_20","x",35),("bone_24","x",-35),("bone_1","x",10)],
    # --- action poses (aim, calibrated) ---
    "punch":     [("aim","bone_6",( 0.12,-1.0, 0.0)),   # R arm thrusts straight forward (Yf)
                  ("aim","bone_7",( 0.06,-1.0, 0.0)),   #   forearm forward = full extension
                  ("aim","bone_8",( 0.0, -1.0, 0.0)),("fist","R"),
                  ("aim","bone_13",(-0.35,0.55,-0.45)), # L fist chambered back at the ribs
                  ("aim","bone_14",(-0.12,-0.5, 0.2)),("fist","L")],
    "kick":      [("aim","bone_20",( 0.0,-1.0, 0.35)),  # R thigh drives knee up & forward (Yf+up)
                  ("aim","bone_21",( 0.0,-1.0, 0.0)),   #   shin snaps straight out (front kick)
                  ("aim","bone_22",( 0.0,-1.0,-0.15)),  #   foot pointed
                  ("aim","bone_6",( 0.35,0.45,-0.45)),  # R arm back, L arm guards forward
                  ("aim","bone_13",(-0.25,-0.6,-0.25)),("fist","L")],
    "karate":    [("aim","bone_6",( 0.22,-0.45,-0.35)), # guard: upper arms fwd/down,
                  ("aim","bone_7",( 0.10,-0.35, 0.85)), #   forearms up -> fists by the face
                  ("fist","R"),
                  ("aim","bone_13",(-0.22,-0.45,-0.35)),
                  ("aim","bone_14",(-0.10,-0.35, 0.85)),("fist","L"),
                  ("aim","bone_20",( 0.32,-0.25,-0.90)),# feet apart, knees softly bent
                  ("aim","bone_21",( 0.12,-0.10,-1.0)),
                  ("aim","bone_24",(-0.32,-0.25,-0.90)),
                  ("aim","bone_25",(-0.12,-0.10,-1.0))],
    "karate_stance": [("aim","bone_20",( 0.70,0.0,-0.72)), # horse stance: thighs wide & down,
                      ("aim","bone_21",( 0.15,0.0,-1.0)),  #   shins near-vertical (deep bend)
                      ("aim","bone_24",(-0.70,0.0,-0.72)),
                      ("aim","bone_25",(-0.15,0.0,-1.0)),
                      ("aim","bone_6",( 0.30,-0.2,-0.88)), # fists chambered at the hips
                      ("aim","bone_7",( 0.20,-0.70,0.15)),("fist","R"),
                      ("aim","bone_13",(-0.30,-0.2,-0.88)),
                      ("aim","bone_14",(-0.20,-0.70,0.15)),("fist","L")],
    "meditate":  [("aim","bone_20",( 0.60,-0.5,-0.55)), # cross-legged: thighs out-forward,
                  ("aim","bone_21",(-0.95,-0.35,-0.05)),#   R shin crosses LEFT in front (Xl)
                  ("aim","bone_24",(-0.60,-0.5,-0.55)),
                  ("aim","bone_25",( 0.95,-0.35,-0.05)),#   L shin crosses RIGHT (Xr)
                  ("aim","bone_6",( 0.22,-0.5,-0.80)),  # hands rest toward the lap
                  ("aim","bone_7",(-0.35,-0.70,-0.2)),
                  ("aim","bone_13",(-0.22,-0.5,-0.80)),
                  ("aim","bone_14",( 0.35,-0.70,-0.2)),
                  ("aim","bone_4",( 0.0,-0.40, 0.90))], # head gently bowed
    "ninja_run": [("aim","bone_1",( 0.0,-0.50, 0.87)), # torso leans forward (~30°)
                  ("aim","bone_6",( 0.20,1.0,0.10)),    # arms swept straight back (Yb)
                  ("aim","bone_7",( 0.10,1.0,0.10)),
                  ("aim","bone_13",(-0.20,1.0,0.10)),
                  ("aim","bone_14",(-0.10,1.0,0.10)),
                  ("aim","bone_20",( 0.0,-0.70,-0.60)), # R leg strides forward
                  ("aim","bone_21",( 0.0,-0.50,-0.85)),
                  ("aim","bone_24",( 0.0, 0.60,-0.70)), # L leg trails back
                  ("aim","bone_25",( 0.0, 0.40,-0.90))],
    "jump":      [("aim","bone_6",( 0.70,-0.1,0.60)),   # arms up & out (clear of the head)
                  ("aim","bone_7",( 0.55,-0.1,0.75)),
                  ("aim","bone_13",(-0.70,-0.1,0.60)),
                  ("aim","bone_14",(-0.55,-0.1,0.75)),
                  ("aim","bone_20",( 0.0,-0.50,0.40)),  # knees tucked up
                  ("aim","bone_21",( 0.0, 0.30,-0.85)),
                  ("aim","bone_24",( 0.0,-0.50,0.40)),
                  ("aim","bone_25",( 0.0, 0.30,-0.85))],
}

LENS, SENSOR = 50.0, 36.0
def cam_radius(size):
    fov = 2*math.atan(SENSOR/2/LENS)
    return (size*1.15/2)/math.tan(fov/2) + size*0.5

def clear_scene(): bpy.ops.wm.read_factory_settings(use_empty=True)
def import_glb(p): bpy.ops.import_scene.gltf(filepath=p)

def find_objs():
    arm = next((o for o in bpy.data.objects if o.type=="ARMATURE"), None)
    meshes = [o for o in bpy.data.objects if o.type=="MESH"]
    # ignore stray/junk meshes (e.g. UniRig's leftover Icosphere): keep only meshes
    # bound to the armature; if none are bound, fall back to the single largest mesh.
    bound = [m for m in meshes if any(md.type=="ARMATURE" for md in m.modifiers)]
    if bound:
        meshes = bound
    elif len(meshes) > 1:
        meshes = [max(meshes, key=lambda m: len(m.data.vertices))]
    # delete the rest so they never affect framing or the render
    keep = set(meshes)
    for o in [o for o in bpy.data.objects if o.type=="MESH" and o not in keep]:
        bpy.data.objects.remove(o, do_unlink=True)
    return arm, meshes

def world_bbox(meshes):
    lo = Vector(( 1e9,)*3); hi = Vector((-1e9,)*3)
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo.x,w.x),min(lo.y,w.y),min(lo.z,w.z)))
            hi = Vector((max(hi.x,w.x),max(hi.y,w.y),max(hi.z,w.z)))
    return lo, hi

# Finger bones per hand (UniRig alien) — curled for a FIST.
FINGERS = {"R": ["bone_9","bone_10","bone_11","bone_12"],
           "L": ["bone_16","bone_17","bone_18","bone_19"]}

def _aim(arm, name, tgt_world, _roll="Z"):
    """Swing pose bone `name` so its head→tail points along tgt_world (a direction in
    WORLD space: +X=char-right, -Y=forward/face, +Z=up).

    Uses a SHORTEST-ARC rotation (rotation_difference) from the bone's CURRENT
    direction to the target, applied about the bone's head. This is critical:
      • it only swings the bone the minimal amount, so it NEVER flips a limb
        upside-down (the failure to_track_quat('Y','Z') hit on down-pointing legs);
      • it preserves the bone's existing ROLL, so no twist is injected into the skin
        — that twist was what cracked the torso/belly open.
    Call parent→child (op order does) with a view-layer update between so the child
    reads its parent's new pose before swinging."""
    pb = arm.pose.bones.get(name)
    if pb is None: log(f"⚠ no bone '{name}'"); return
    Rinv = arm.matrix_world.to_3x3().inverted()
    t = (Rinv @ Vector(tgt_world)).normalized()          # target dir, armature space
    M = pb.matrix.copy()
    head = M.to_translation()
    cur = (M.to_3x3() @ Vector((0, 1, 0))).normalized()  # bone's current length (+Y) axis
    if cur.dot(t) < -0.9999:                              # antiparallel: pick any ⊥ axis
        axis = cur.cross(Vector((1, 0, 0)))
        if axis.length < 1e-6: axis = cur.cross(Vector((0, 0, 1)))
        rot = Matrix.Rotation(math.pi, 4, axis.normalized())
    else:
        rot = cur.rotation_difference(t).to_matrix().to_4x4()  # minimal swing cur→t
    # rotate the bone about its head: translate head→origin, rotate, translate back
    pb.matrix = Matrix.Translation(head) @ rot @ Matrix.Translation(-head) @ M
    bpy.context.view_layer.update()

def apply_pose(arm, ops):
    if arm is None: return
    from mathutils import Vector, Matrix  # local alias in case module import differs
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"; pb.rotation_euler = (0,0,0)
    bpy.context.view_layer.update()
    ax = {"x":0,"y":1,"z":2}
    for op in ops:
        tag = op[0]
        if tag == "aim":                                  # ("aim", bone, (x,y,z)[, rollaxis])
            _aim(arm, op[1], op[2], op[3] if len(op) > 3 else "Z")
        elif tag == "fist":                               # ("fist", "R"|"L"[, deg])
            deg = op[2] if len(op) > 2 else -80
            for b in FINGERS.get(op[1], []):
                pb = arm.pose.bones.get(b)
                if pb is None: continue
                pb.rotation_mode = "XYZ"
                e = list(pb.rotation_euler); e[0] += math.radians(deg); pb.rotation_euler = e
            bpy.context.view_layer.update()
        else:                                             # (bone, axis, deg) explicit local rot
            bone, axis, deg = op
            pb = arm.pose.bones.get(bone)
            if pb is None: log(f"⚠ no bone '{bone}'"); continue
            e = list(pb.rotation_euler); e[ax[axis]] += math.radians(deg); pb.rotation_euler = e
            bpy.context.view_layer.update()
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

def place_camera(center, size, az, el):
    for o in [o for o in bpy.data.objects if o.type=="CAMERA"]:
        bpy.data.objects.remove(o, do_unlink=True)
    cam_data = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam_data.lens = LENS; cam_data.sensor_width = SENSOR
    R = cam_radius(size)
    a, e = math.radians(az), math.radians(el)
    # Blender scene is Z-UP (glTF Y-up is converted on import). Orbit azimuth about +Z, elevation above
    # the horizon; front (az0,el0) sits at -Y looking +Y. to_track_quat('-Z','Y') keeps world +Z as frame-up.
    pos = Vector((center.x + R*math.cos(e)*math.sin(a),
                  center.y - R*math.cos(e)*math.cos(a),
                  center.z + R*math.sin(e)))
    cam.location = pos
    cam.rotation_euler = (center - pos).to_track_quat("-Z","Y").to_euler()
    bpy.context.scene.camera = cam

def all_mesh_materials(meshes, mat):
    for o in meshes:
        o.data.materials.clear(); o.data.materials.append(mat)

def mat_clay():
    m = bpy.data.materials.new("clay"); m.use_nodes=True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value=(0.8,0.8,0.82,1); b.inputs["Roughness"].default_value=0.85
    return m

def mat_white_emit():
    m = bpy.data.materials.new("white"); m.use_nodes=True
    nt=m.node_tree; nt.nodes.clear()
    e=nt.nodes.new("ShaderNodeEmission"); e.inputs["Color"].default_value=(1,1,1,1)
    o=nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs["Emission"],o.inputs["Surface"])
    return m

def mat_depth():
    m = bpy.data.materials.new("depth"); m.use_nodes=True
    nt=m.node_tree; nt.nodes.clear()
    cam=nt.nodes.new("ShaderNodeCameraData")
    mr=nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["To Min"].default_value=1.0;   mr.inputs["To Max"].default_value=0.0   # near=white, far=black
    mr.clamp=True
    # euclidean distance to camera (always positive) — matches the Python range calc exactly, no sign ambiguity
    nt.links.new(cam.outputs["View Distance"], mr.inputs["Value"])
    e=nt.nodes.new("ShaderNodeEmission"); nt.links.new(mr.outputs["Result"], e.inputs["Color"])
    o=nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs["Emission"], o.inputs["Surface"])
    return m, mr   # caller sets mr From Min/Max per camera from the actual mesh depth range

def view_depth_range(meshes):
    """Nearest/farthest EUCLIDEAN distance from camera over the DEFORMED (evaluated) mesh — matches
    what the shader's 'View Distance' actually sees (skinned glTF verts move under the armature)."""
    deps=bpy.context.evaluated_depsgraph_get()
    cam=bpy.context.scene.camera; loc=cam.matrix_world.translation
    near=1e18; far=-1e18
    for o in meshes:
        ev=o.evaluated_get(deps); me=ev.to_mesh(); mw=ev.matrix_world
        for v in me.vertices:
            d=(mw @ v.co - loc).length
            if d<near: near=d
            if d>far: far=d
        ev.to_mesh_clear()
    pad=(far-near)*0.02 or 0.01
    return near-pad, far+pad

def set_world(color):
    w = bpy.data.worlds.new("w"); w.use_nodes=True
    bg=w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value=(*color,1); bg.inputs["Strength"].default_value=1.0
    bpy.context.scene.world=w

def clear_lights():
    for o in [o for o in bpy.data.objects if o.type=="LIGHT"]:
        bpy.data.objects.remove(o, do_unlink=True)

def add_key_light():
    l=bpy.data.lights.new("key","SUN"); l.energy=3.0
    o=bpy.data.objects.new("key",l); bpy.context.scene.collection.objects.link(o)
    o.rotation_euler=(math.radians(55),0,math.radians(30))

def lineart_compositor(on):
    """Sobel edge on the camera-space Normal pass → black lines on white. Robust headless alt to Freestyle."""
    scene=bpy.context.scene
    vl=scene.view_layers[0]
    if not on:
        scene.use_nodes=False; return
    vl.use_pass_normal=True
    scene.use_nodes=True
    nt=scene.node_tree; nt.nodes.clear()
    rl=nt.nodes.new("CompositorNodeRLayers")
    f=nt.nodes.new("CompositorNodeFilter"); f.filter_type="SOBEL"
    nt.links.new(rl.outputs["Normal"], f.inputs["Image"])
    # Sobel on the RGB normal gives COLORED edges → collapse to luminance so lines are monochrome,
    # boost contrast, then invert → crisp BLACK lines on WHITE.
    bw=nt.nodes.new("CompositorNodeRGBToBW"); nt.links.new(f.outputs["Image"], bw.inputs["Image"])
    br=nt.nodes.new("CompositorNodeBrightContrast"); br.inputs["Contrast"].default_value=60.0
    nt.links.new(bw.outputs["Val"], br.inputs["Image"])
    inv=nt.nodes.new("CompositorNodeInvert"); nt.links.new(br.outputs["Image"], inv.inputs["Color"])
    comp=nt.nodes.new("CompositorNodeComposite"); nt.links.new(inv.outputs["Color"], comp.inputs["Image"])

def render_to(path, res, samples):
    scene=bpy.context.scene
    scene.render.resolution_x=res; scene.render.resolution_y=res
    scene.render.image_settings.file_format="PNG"
    scene.cycles.samples=samples
    scene.render.filepath=path
    bpy.ops.render.render(write_still=True)

def add_corrective_smooth(meshes, factor, iters):
    """Append a Corrective Smooth modifier AFTER the armature so it operates on the
    DEFORMED surface, smoothing out deform-induced pinching/tearing (shoulder, armpit,
    belly creases) while holding the rest shape as reference. ORCO = the mesh's original
    (bind) coordinates, so the correction is measured against the undeformed proxy."""
    if factor <= 0: return
    for o in meshes:
        cs = o.modifiers.new("deform_smooth", "CORRECTIVE_SMOOTH")
        cs.smooth_type   = "LENGTH_WEIGHTED"   # resists collapse/shrink better than simple
        cs.rest_source   = "ORCO"              # undeformed verts as the reference shape
        cs.factor        = factor
        cs.iterations    = iters
        cs.use_pin_boundary = False
    log(f"corrective-smooth: factor={factor} iters={iters} on {[o.name for o in meshes]}")

def add_subsurf(meshes, levels):
    """Append a Subdivision Surface modifier (after corrective smooth) so the final
    render surface is smooth/rounded even on a low-poly proxy. Catmull-Clark; render
    and viewport levels both set. Off when levels<=0. Added LAST so it polishes the
    already-smoothed deformation."""
    if levels <= 0: return
    for o in meshes:
        ss = o.modifiers.new("render_subsurf", "SUBSURF")
        ss.subdivision_type = "CATMULL_CLARK"
        ss.levels = levels
        ss.render_levels = levels
    log(f"subsurf: levels={levels} on {[o.name for o in meshes]}")

def main():
    args = parse_args()
    if args.list_poses:
        print("poses:", ", ".join(POSES)); return
    inp=os.path.abspath(args.inp); outd=os.path.abspath(args.out); os.makedirs(outd, exist_ok=True)
    ops=list(POSES.get(args.pose, []))
    if args.rot:
        for tok in args.rot.split(","):
            b,spec=tok.split(":"); ops.append((b, spec[0].lower(), float(spec[1:])))
    if args.aim:
        for tok in args.aim.split(";"):
            tok=tok.strip()
            if not tok: continue
            b,vec=tok.split(":"); x,y,z=(float(c) for c in vec.split(","))
            ops.append(("aim", b, (x,y,z)))
    cams=[c.strip() for c in args.cams.split(",") if c.strip()]
    passes=[p.strip() for p in args.passes.split(",") if p.strip()]

    clear_scene(); import_glb(inp)
    arm, meshes = find_objs()
    if not meshes: log("❌ no mesh imported"); sys.exit(1)
    log(f"armature: {arm.name if arm else 'NONE'}   meshes: {[m.name for m in meshes]}")
    apply_pose(arm, ops)
    add_corrective_smooth(meshes, args.smooth_deform, args.smooth_iters)
    add_subsurf(meshes, args.subsurf)
    lo,hi = world_bbox(meshes); center=(lo+hi)/2; size=max((hi-lo).x,(hi-lo).y,(hi-lo).z)
    R=cam_radius(size)
    log(f"pose='{args.pose}'{' +rot' if args.rot else ''}  size={size:.2f}  camR={R:.2f}  cams={cams}  passes={passes}")

    scene=bpy.context.scene
    setup_gpu(scene)
    scene.view_settings.view_transform="Standard"     # linear — do NOT tone-map control signals
    scene.render.film_transparent=False
    # depth range = the character's actual camera-distance band, for full contrast
    depth_mat, depth_mr = mat_depth(); white_mat=mat_white_emit(); clay_mat=mat_clay()

    for cname in cams:
        if cname not in CAMS: log(f"⚠ unknown cam '{cname}'"); continue
        az,el=CAMS[cname]; place_camera(center,size,az,el)
        for p in passes:
            tag=f"{args.label}{args.pose}_{cname}_{p}"; path=os.path.join(outd,tag+".png")
            if p=="depth":
                lineart_compositor(False); set_world((0,0,0)); all_mesh_materials(meshes, depth_mat)
                near,vfar = view_depth_range(meshes)
                # map from nearest surface to just past the CENTRE plane (camR), not the invisible back —
                # so the visible front bulge uses the full white→black gradient (punchy control signal).
                far = R + (R-near)*0.2
                log(f"depth range: near={near:.3f} far={far:.3f}  (camR={R:.3f} full-far={vfar:.3f})")
                depth_mr.inputs["From Min"].default_value=near; depth_mr.inputs["From Max"].default_value=far
                render_to(path,args.res,1)
            elif p=="lineart":
                set_world((1,1,1)); all_mesh_materials(meshes, white_mat); lineart_compositor(True)
                render_to(path,args.res,1); lineart_compositor(False)
            elif p=="clay":
                lineart_compositor(False); set_world((0.12,0.12,0.13)); all_mesh_materials(meshes, clay_mat)
                clear_lights(); add_key_light()
                render_to(path,args.res,args.samples)
            else:
                log(f"⚠ unknown pass '{p}'"); continue
            log(f"✅ {tag}.png")
    print(f"RENDERS {outd}")

if __name__ == "__main__":
    main()
