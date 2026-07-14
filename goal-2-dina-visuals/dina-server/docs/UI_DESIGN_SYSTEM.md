# dina-visuals — UI Design System (locked)

The visual contract for the workstation frontend (mirror-server, React/Vite). Tokens live in
`goal-2-dina-visuals/mirror-server/ui/tokens.css` — the single source of truth; components style
against `var(--*)` only, never raw hex. A live style-guide preview accompanies this doc.

## 1. Direction (from the reference set)

Dark-first studio environment: **white on layered blacks** (base → card → elevated → hover, four
distinct blacks so depth reads without heavy shadows), grey text hierarchy, **one warm-gold accent**
doing quiet work, and **pastel hues reserved for semantics** (state, never decoration). Sleek,
spacious, professional: an 8px grid, generous negative space, rounded corners (8/14/20), hairline
borders doing the separation, soft shadows doing the lift.

**Dual theme, token-level.** Dark "studio" is the primary working environment; light "paper" is its
twin (warm-grey ground, white cards, same accent deepened for contrast). OS preference is respected;
an explicit in-app toggle overrides it. The pair is generated from the same token names so they can
never structurally drift.

## 2. The one opinionated rule: glow = live GPU

Glows are **reserved exclusively for live GPU activity**. A rendering shot card, an active job row,
the progress bar of a running generation — these glow (accent ring + soft bloom). Nothing else does:
not hovers, not selection, not decoration. The user learns one lesson once: *if it glows, the card
is working.* This turns an aesthetic flourish into an instrument reading — and it's cheap to enforce
because the glow is a single token (`--glow-live`).

## 3. Token reference (see tokens.css for exact values)

| Group | Dark (studio) | Light (paper) |
|---|---|---|
| Ground → hover | `#0B0B0D → #131316 → #1A1A1F → #232329` | `#F4F4F6 → #FFF → #FAFAFC → #EFEFF2` |
| Text hierarchy | `#F2F2F5 / #9B9BA6 / #6A6A75` | `#1A1A1F / #5E5E68 / #8E8E99` |
| Hairline | `#2A2A31` | `#E3E3E8` |
| Accent (gold) | `#D9A662` | `#B8813C` |
| Semantics (pastel) | mint `#8FD9B0` ok · sky `#93BFE6` info · sand `#E6C893` warn · rose `#E39A9A` err · lavender `#B9A8E3` special | deepened equivalents |
| Radii / spacing | 8 / 14 / 20 / pill · 8-16-24-40-64 | same |

Type: geometric-leaning system stack. Display = heavy weight (750+), tight tracking (-0.02em), large
sizes — the "Minimalism at its finest" voice. Body = regular, 15–16px, relaxed line-height. Data =
mono with `tabular-nums` (ETAs, VRAM, seeds, percentages — every column of digits aligns).

## 4. Component contracts (flagships)

**Job progress card** (the UX centerpiece, feeds on `JobProgress` events):
phase label (eyebrow, uppercase, letter-spaced) · monotonic bar (accent fill, `--glow-live` while
running) · `overall_pct` large in mono · ETA + VRAM + step `idx/total` in mono small · live preview
thumb (rounded, hairline border) · warnings as sand-pastel chips. On success the glow drops and the
bar turns mint; on failure rose, with the error text inline — state is readable from across the room.

**Shot card** (pre-production board): panel thumb, shot number + camera angle/movement as grey
metadata, dialogue snippet, status pill (draft grey / approved mint / rendered gold), fps chip when
60 (sand, flagged "review interpolation"). Approve is a quiet outline button; the primary filled
button is reserved for "Render" — the expensive action gets the visual weight.

**Buttons**: filled accent = the one primary action per view; outline = secondary; ghost = tertiary.
Destructive = rose outline, filled only in the confirm dialog. Pill radius on chips/pills, `--r-md`
elsewhere.

**Quota / GPU meters**: thin bars, grey track, accent fill; watermark ticks at 80/90%; mono numbers.

## 5. Interaction principles

- **Spacious**: whitespace is the grid's default state; density is opt-in (library table view).
- **Intuitive**: expensive actions look expensive (filled gold), reversible ones look light; every
  control names its outcome ("Render 720p final", then a toast "Render queued — #142").
- Focus states visible always (accent ring, not glow — glow means GPU); `prefers-reduced-motion`
  respected (progress bars still move, blooms/pulses stop).
- Motion: one orchestrated moment per view (progress bloom), never scattered hover theatrics.

## 6. Accessibility floor

Text contrast ≥ 4.5:1 in both themes (grey hierarchy values were picked against both grounds);
pastel semantics never carry meaning alone — always paired with a label or icon; keyboard path
through board → shot → approve/render complete; hit targets ≥ 40px.

## 7. Route application

| Route | Treatment |
|---|---|
| `/preprod` scene board | dark studio, shot cards in a spacious grid, animatic player docked |
| `/generate/*` | left: parameters (quiet), right: job progress card (the glowing focal point) |
| `/library` | dense grid of generations, lineage breadcrumbs, promote = gold action |
| `/audio` | waveform on elevated surface, beat ticks in accent, lyric words as chips |
| `/settings` | paper-calm even in dark theme — the one low-stimulation surface |
