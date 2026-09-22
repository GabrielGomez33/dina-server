---
name: visual-storytelling
description: >-
  The emotional-craft playbook for Mirror's wordless short films — how Disney/Pixar and the great
  ad houses make an audience FEEL, translated into concrete moves for our keyframe→motion pipeline.
  Use this whenever planning, storyboarding, or writing a `.video` manifest for a Little One / Mirror
  video, whenever a piece feels flat, static, or "nothing happens," or whenever the goal is to make a
  viewer feel something (be seen, not-enough→enough, loneliness→belonging). Reach for it before
  choosing beats, durations, keyframe compositions, motion, color grade, or music — even when the user
  only says "make the next video," "a more emotional story," "more depth," or "a different story." It
  is the difference between a slideshow and a film that lands.
---

# Visual Storytelling — making a wordless short *feel*

Our films have no dialogue and no voiceover. Every ounce of emotion must come from **image + motion +
timing + color + music**. That is not a limitation — it is Pixar's "Piper," Disney's "Paperman," the
John Lewis ads. They make grown adults cry with a bird or a paper airplane and **zero words**. This
skill is how they do it, reduced to moves you apply per beat in the SAGA pipeline.

**The one rule above all: a short makes the viewer feel ONE clear thing.** Not four ideas — one
feeling, set up and paid off. Everything below serves that. If you can't name the single feeling in
one word (*seen, safe, not-alone, enough, wonder, relief*), stop and find it before building.

## Why V3/V5 fell flat (the anti-patterns to kill)

- **Static tableaux, one per line.** A character standing in front of a thing while a caption explains
  the idea is *illustration*, not storytelling. The image restated the text; nothing was *discovered*.
- **Uniform beats, no arc.** Four ~equal shots with the same energy = a slideshow. Emotion needs a
  **shape**: a low, a turn, a lift. Flat energy reads as flat feeling.
- **Telling, not showing.** The caption did the emotional work the picture should do. If the line and
  the image say the same thing, the image is wasted — make the image carry it and cut the line.
- **No vulnerability, no stakes.** Nothing was at risk, wanted, or lost, so there was nothing to feel.

## The spine — structure that creates feeling

Pick ONE and compress it to **5–8 beats** across ~18–24s. The beat that matters most is **the turn.**

- **Setup → Turn → Payoff** (default). Establish the character + a small want/lack (beats 1–2) → a
  shift changes everything (the turn, ~60% in) → an earned emotional release (payoff) → rest on it.
- **Pixar story spine**: *Once upon a time… Every day… **Until one day**… Because of that… Until
  finally… Ever since.* The "until one day" is your turn. Maps cleanly to 6 beats.
- **Kishōtenketsu** (conflict-free — best for gentle brand pieces): *ki* (introduce) → *shō* (develop)
  → **ten** (an unexpected turn — not conflict, a re-frame) → *ketsu* (reconciliation). Lets a piece
  feel profound without a villain.

**The emotional pivot is the whole game.** A mid-piece shift — *alone→seen, hiding→held, not-enough→
enough, searching→found* — is what makes a viewer feel. Build toward it, land it clearly, let it breathe.

## Make us care in the first 3 seconds (the hook + empathy)

Short-form lives or dies in ~3 seconds. Earn empathy immediately:

- **Appeal + vulnerability.** Little One is already appealing (round, soft, big eyes). Add a small
  vulnerability instantly — a tiny sigh, a hopeful look, a too-heavy posture. We bond to what is soft
  and a little bit fragile.
- **A small, legible want.** Give the character one clear desire in the first beats (to reach the
  light, to see itself, to not be alone). Want = the engine of attention.
- **"Save the cat."** One tiny sympathetic action (a hopeful reach, a shy smile) and the audience is
  on their side. Do it early.
- **Start in motion or on a feeling**, never on a logo. The scroll stops for an emotion, not a brand.

## The per-beat emotional-craft checklist

For **every** beat, decide these five. This is the core of the skill — run it per shot.

1. **What does this beat make me FEEL, and how does it move the arc?** (name it; if it doesn't shift
   the feeling from the beat before, cut or merge it.)
2. **Staging & composition** — stage the emotion so it reads in a silent thumbnail:
   - *Small in a big frame* = loneliness/awe. *Filling the frame* = intimacy/safety. Move between them
     to feel the arc (start small & isolated → end close & warm).
   - Negative space above/around the character = yearning, smallness. Center for stillness; off-center
     + empty space they look into = longing/anticipation.
   - Vertical format: use the tall frame — a lot of empty space above a small character reads as
     alone; fill it with warmth/light at the payoff.
3. **Acting — the eyes carry it.** For a simple creature, emotion = eyes + posture + tuft/brows.
   Bigger, brighter, up = hope/wonder; half-lidded, down, small = sad/tired; a single slow **blink**
   is a reset or a held feeling. **Posture:** slumped/heavy = defeat; lifting/opening = hope. Change
   one of these across the beat and the audience reads a whole inner shift.
4. **Motion & timing (the aliveness + the pause).** Nothing should be dead — always a breath, an
   ambient drift, a blink. But **more cuts ≠ more emotion.** The most powerful moment is often a
   **held beat**: stillness right before or after the turn lets it land. Slow down at the emotional
   peak (a visual *ritardando*). Fast, small motion = anxiety; slow, smooth = calm/tenderness. A
   **transformation** (something appearing, a smudge clearing, warmth blooming, the world lighting up)
   is inherently emotional — use reveal beats for the turn.
5. **Color & light — the emotional arc is a color arc.** Plan a mini **color script**: the palette
   should *travel*. Cold, desaturated, dim, high-contrast shadow = sad/alone/afraid. Warm, soft,
   glowing, low-contrast = safe/seen/loved. **The cold→warm turn IS the payoff** — light literally
   arriving on the character is the feeling made visible. Never keep one flat palette across a piece.

## Pacing & music — the arc has a rhythm

- **Vary beat durations.** Uniform = flat. Give the setup room, quicken through the "because of that,"
  then **stretch the turn and payoff** (the longest, slowest beats). Rhythm is emotion.
- **Cut/land motion on the music.** Match the reveal and the payoff to the swell; put a **half-beat of
  silence/stillness right before** the emotional peak (the breath before). Build → release.
- **End on resonance, not information.** Last beat = the feeling, held. The brand end-card comes after
  the emotion has landed, never on top of it.

## Mapping to the SAGA pipeline (how each move is built)

- **Feeling & arc** → the storyboard + `.video` manifest: choose a spine, name the one feeling.
- **Staging/composition/acting** → the **keyframe** (`saga-flux` prompt): describe scale, negative
  space, eye state, posture, light direction. Curate hard for the *emotion*, not just on-model-ness.
- **The turn / transformation** → a **reveal beat** (`REVEAL[k]` + a `shotK_end.png` made with
  `saga-flux --init`): Wan interpolates the shift (smudge clears, warmth blooms, eyes lift). This is
  where the emotion happens — spend your craft here.
- **Motion & the pause** → `MOTION[k]` prompts (gentle, morphology-true) + **beat durations** (`DUR`):
  make the turn/payoff the longest beats; keep motion slow at the peak.
- **Color arc** → per-beat grade. Start cooler/dimmer, end on `soft-heavy`/warm. (If we need a true
  cold→warm arc, grade early beats cooler and let the payoff be the warm one — a small pipeline add.)
- **Rhythm & music** → `XFADE` dissolves for continuity (calm brand), durations for rhythm, the music
  bed and the silence-before-peak in assembly.
- **Feel over caption** → captions become sparse *punctuation*, not narration. If the image carries
  it, cut the words. Let the picture win.

## The test before you build

Storyboard it, then ask: **strip every caption — does the emotion still land from the pictures and
music alone?** If no, the images aren't doing the work yet. Fix the images, not the captions. That is
the whole craft.

## References

- `references/studio-craft.md` — the sourced deep-dive (story structure + the 22 rules, the visual/
  animation craft of emotion, wordless-short case studies) this playbook distills. Read it when you
  want the underlying "why" or concrete studio examples to emulate.
- Story spines for Little One / Mirror live with each video's storyboard; `references/studio-craft.md`
  holds the worked emotional concepts to draw from.
