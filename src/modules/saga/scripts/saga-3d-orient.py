#!/usr/bin/env python3
# ============================================================================
# saga-3d-orient.py — stand a mesh UPRIGHT (Y-up), feet on the ground, via trimesh.
# ----------------------------------------------------------------------------
# Convention-free: works purely in the file's own coordinates (no Blender Y<->Z
# guessing, which is what tipped the remesh output over). Deterministic and
# verifiable. Reusable for ANY image->model output, not just Little One.
#
# Auto mode: the character's HEIGHT is the longest bbox axis; the TAPERED end
# (smaller cross-section — head/tuft) goes up, the WIDER end (feet/body) down.
# Then floor to Y=0, center X/Z, optionally scale to a target height, optional yaw.
#
#   python saga-3d-orient.py --in little_one_clean.glb -o little_one_upright.glb --project
#   python saga-3d-orient.py --in m.glb --up +Z --height 2.0 --yaw 180 -o up.glb   # manual up axis
#
# Needs trimesh (present in the TRELLIS venv). --project writes a <out>_proj.png
# silhouette triptych (front/side/top) so orientation is checkable without a GPU.
# ============================================================================
import argparse
import os
import sys
import numpy as np
import trimesh


def log(*a):
    print("  [orient]", *a, file=sys.stderr, flush=True)


def load_geom(p):
    g = trimesh.load(p, force="scene")
    return g.to_geometry() if hasattr(g, "to_geometry") else g


def detect_up(v):
    """Return (axis_index, sign): longest bbox axis is the height; tapered end (smaller cross-section) is up."""
    ext = v.max(0) - v.min(0)
    ax = int(np.argmax(ext))
    others = [i for i in range(3) if i != ax]
    col = v[:, ax]
    top = v[col > np.percentile(col, 98)][:, others]
    bot = v[col < np.percentile(col, 2)][:, others]
    spread_top = float(np.ptp(top[:, 0]) + np.ptp(top[:, 1])) if len(top) else 9e9
    spread_bot = float(np.ptp(bot[:, 0]) + np.ptp(bot[:, 1])) if len(bot) else 9e9
    sign = 1 if spread_top <= spread_bot else -1  # tapered end = head = up
    return ax, sign, spread_top, spread_bot


def parse_up(s):
    sign = -1 if s.startswith("-") else 1
    return "XYZ".index(s[-1].upper()), sign


def stand_rotation(ax, sign):
    """4x4 that brings the signed principal axis (ax,sign) to +Y via a SINGLE principal-axis rotation,
    so the other two axes stay axis-aligned (no arbitrary azimuth swap). Returns identity for +Y."""
    import trimesh.transformations as tf
    r = np.radians
    if ax == 1:                       # Y
        return np.eye(4) if sign > 0 else tf.rotation_matrix(r(180), [1, 0, 0])
    if ax == 2:                       # Z → Y about X
        return tf.rotation_matrix(r(-90 if sign > 0 else 90), [1, 0, 0])
    return tf.rotation_matrix(r(90 if sign > 0 else -90), [0, 0, 1])  # X → Y about Z


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("-o", "--out", default="")
    ap.add_argument("--up", default="auto",
                    help="current axis that is the character's UP/head: auto|+X|-X|+Y|-Y|+Z|-Z")
    ap.add_argument("--height", type=float, default=0.0, help="scale so height = H (0 = keep as-is)")
    ap.add_argument("--yaw", type=float, default=0.0, help="spin about the new up axis (deg) to face front")
    ap.add_argument("--flip", action="store_true",
                    help="180° about X after standing (use when auto-up lands it upside-down, e.g. a big-headed/narrow-legged character)")
    ap.add_argument("--project", action="store_true", help="write <out>_proj.png silhouette check")
    args = ap.parse_args()

    inp = os.path.abspath(args.inp)
    out = os.path.abspath(args.out) if args.out else os.path.splitext(inp)[0] + "_upright.glb"
    if not os.path.isfile(inp):
        log(f"❌ not found: {inp}"); sys.exit(1)

    m = load_geom(inp)
    v = np.asarray(m.vertices)
    e0 = v.max(0) - v.min(0)
    log(f"in: {len(v)} verts / {len(m.faces)} faces  extents={[round(float(x), 2) for x in e0]}")

    if args.up == "auto":
        ax, sign, st, sb = detect_up(v)
        log(f"auto up: axis {'XYZ'[ax]} sign {sign:+d}  (tapered-end spread top={st:.2f} bot={sb:.2f})")
    else:
        ax, sign = parse_up(args.up)
        log(f"manual up: {args.up}")

    # single principal-axis rotation → +Y (keeps width/depth axis-aligned, no arbitrary azimuth)
    m.apply_transform(stand_rotation(ax, sign))
    if args.flip:   # turn top-bottom over (fixes an inverted auto-up guess)
        m.apply_transform(trimesh.transformations.rotation_matrix(np.radians(180), [1, 0, 0]))
    if abs(args.yaw) > 1e-6:
        m.apply_transform(trimesh.transformations.rotation_matrix(np.radians(args.yaw), [0, 1, 0]))

    v = np.asarray(m.vertices)
    if args.height and args.height > 0:
        h = (v[:, 1].max() - v[:, 1].min()) or 1.0
        m.apply_scale(args.height / h)
        v = np.asarray(m.vertices)

    # floor feet to Y=0, center X and Z
    lo = v.min(0); hi = v.max(0)
    v[:, 0] -= (lo[0] + hi[0]) / 2.0
    v[:, 2] -= (lo[2] + hi[2]) / 2.0
    v[:, 1] -= lo[1]
    m.vertices = v

    e = v.max(0) - v.min(0)
    log(f"out: extents W×H×D = {e[0]:.2f} × {e[1]:.2f} × {e[2]:.2f}  (Y should be largest = height)  "
        f"floor y={v[:, 1].min():.2f}")
    if np.argmax(e) != 1:
        log("⚠ Y is NOT the largest axis — orientation may be wrong; try --up +Z / -Z / +X explicitly")

    m.export(out)
    log(f"✅ {out}")

    if args.project:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        pp = os.path.splitext(out)[0] + "_proj.png"
        fig, ax = plt.subplots(1, 3, figsize=(15, 6))
        for a, (i, j, t) in zip(ax, [(0, 1, "FRONT X-Y"), (2, 1, "SIDE Z-Y"), (0, 2, "TOP X-Z")]):
            a.scatter(v[:, i], v[:, j], s=0.5, alpha=0.15)
            a.set_title(t); a.set_aspect("equal"); a.grid(True, alpha=0.3)
        plt.tight_layout(); plt.savefig(pp, dpi=80)
        log(f"✅ {pp}")

    print(out)


if __name__ == "__main__":
    main()
