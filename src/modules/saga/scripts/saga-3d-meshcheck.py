#!/usr/bin/env python3
# ============================================================================
# saga-3d-meshcheck.py — report mesh HEALTH for a GLB, so we know whether a mesh
# is safe to rig/pose. A mesh SHREDS under posing when it has defects that skin
# weights cannot hold together:
#   • multiple disconnected COMPONENTS (loose flakes/islands fly off when posed)
#   • LOOSE verts/edges (no face) — scatter under any deform
#   • NON-MANIFOLD edges (>2 faces, or surfaces that touch) — tear at the seam
#   • many BOUNDARY edges (holes) — open shells split open
# A watertight, single-component, manifold mesh CANNOT shred: every vertex is
# edge-connected to its neighbours, so the surface deforms as one skin.
#
#   blender -b -P saga-3d-meshcheck.py -- --in alien_upright.glb
#   blender -b -P saga-3d-meshcheck.py -- --in alien_rigged.glb
# ============================================================================
import bpy, sys, os, bmesh

def argv(): return sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def log(*a): print(*a, file=sys.stderr, flush=True)

def count_components(bm):
    seen = set(); comps = 0; sizes = []
    for v in bm.verts:
        if v.index in seen: continue
        comps += 1; stack = [v]; seen.add(v.index); n = 0
        while stack:
            w = stack.pop(); n += 1
            for e in w.link_edges:
                o = e.other_vert(w)
                if o.index not in seen:
                    seen.add(o.index); stack.append(o)
        sizes.append(n)
    sizes.sort(reverse=True)
    return comps, sizes

def main():
    inp = os.path.abspath(argv()[argv().index("--in")+1])
    if not os.path.isfile(inp): log(f"❌ not found: {inp}"); sys.exit(1)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=inp)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    log(f"\n=== {os.path.basename(inp)} ===  meshes={len(meshes)}")
    for o in meshes:
        me = o.data
        bm = bmesh.new(); bm.from_mesh(me); bm.verts.ensure_lookup_table()
        nonmani_e = sum(1 for e in bm.edges if not e.is_manifold)
        boundary_e = sum(1 for e in bm.edges if e.is_boundary)
        loose_v = sum(1 for v in bm.verts if not v.link_edges)
        loose_e = sum(1 for e in bm.edges if not e.link_faces)
        nonmani_v = sum(1 for v in bm.verts if not v.is_manifold)
        comps, sizes = count_components(bm)
        big = sizes[0] if sizes else 0
        stray = sum(sizes[1:]) if len(sizes) > 1 else 0
        watertight = (boundary_e == 0 and nonmani_e == 0 and comps == 1 and loose_v == 0)
        log(f"  '{o.name}': verts={len(bm.verts)} faces={len(bm.faces)}")
        log(f"     components={comps} (largest={big}, stray-in-others={stray})")
        log(f"     non-manifold edges={nonmani_e}  boundary(hole) edges={boundary_e}  non-manifold verts={nonmani_v}")
        log(f"     loose verts={loose_v}  loose edges={loose_e}")
        log(f"     → {'✅ WATERTIGHT/CLEAN (safe to pose)' if watertight else '❌ DEFECTIVE (will shred/tear when posed)'}")
        bm.free()

if __name__ == "__main__":
    main()
