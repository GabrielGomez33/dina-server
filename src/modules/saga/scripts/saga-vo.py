#!/usr/bin/env python3
"""saga-vo.py — Mirror narration generator (self-hosted TTS via Kokoro).

Reusable AUDIO component of the self-hosted Mirror content pipeline
(image -> video -> AUDIO -> ffmpeg assembler). No ElevenLabs: renders narration
locally on the pod GPU/CPU with Kokoro, zero per-word cost.

TWO modes:
  • sequential (default) — one narration line per input line, concatenated with --gap.
      saga-vo.py -i vid1.txt -o vid1_vo.wav [--voice af_heart] [--speed 0.9] [--gap 0.5]
  • --timeline — each input line is "SECONDS|text"; the line is PLACED at that offset on
      the timeline (silence-padded), so narration stays synced to the shots/captions. This is
      the proven Video-3 path (beats at 0.3/3.5/8.0/13.1/15.5). Overlaps are detected + warned.
      saga-vo.py --timeline -i vid3.tl -o vid3_vo.wav [--total 18]
      # vid3.tl:   0.3|People call you complicated.
      #            3.5|When they mean they haven't taken the time to understand you.
      #            # blank lines and lines starting with # are ignored

Storyboard SSML-style pauses are honored in the text:  <break time="0.6s"/>  -> that much silence.
Output: a single 24kHz WAV. Voice defaults to the brand narrator (af_heart); keep it the SAME
across every video for brand consistency (per the storyboard kit).
"""
import argparse
import re
import sys

import numpy as np
from kokoro import KPipeline

SR = 24000
BREAK = re.compile(r'<break\s+time="([\d.]+)s"\s*/>')


def silence(sec: float) -> np.ndarray:
    return np.zeros(int(SR * max(sec, 0.0)), dtype=np.float32)


def synth(pipe, text: str, voice: str, speed: float) -> np.ndarray:
    chunks = [np.asarray(a, dtype=np.float32) for _, _, a in pipe(text, voice=voice, speed=speed)]
    return np.concatenate(chunks) if chunks else silence(0)


def render_line(pipe, line: str, voice: str, speed: float) -> np.ndarray:
    # BREAK.split gives [text, dur, text, dur, ...] — odd indices are break seconds.
    out, parts = [], BREAK.split(line)
    for i, seg in enumerate(parts):
        if i % 2:
            out.append(silence(float(seg)))
        elif seg.strip():
            out.append(synth(pipe, seg.strip(), voice, speed))
    return np.concatenate(out) if out else silence(0)


def save_wav(path: str, audio: np.ndarray, sr: int) -> None:
    """Save a mono float32 wav. Prefer soundfile; fall back to torchaudio (always present on the pod)."""
    audio = np.asarray(audio, dtype=np.float32)
    try:
        import soundfile as sf
        sf.write(path, audio, sr)
    except Exception:
        import torch
        import torchaudio as ta
        ta.save(path, torch.from_numpy(audio).unsqueeze(0), sr)


def run_sequential(pipe, a) -> np.ndarray:
    track = []
    with open(a.infile, encoding='utf-8') as fh:
        for raw in fh:
            line = raw.rstrip('\n')
            track.append(silence(a.gap) if not line.strip()
                         else render_line(pipe, line, a.voice, a.speed))
            track.append(silence(a.gap))
    return np.concatenate(track) if track else silence(0)


def run_timeline(pipe, a) -> np.ndarray:
    # parse "SECONDS|text" entries (skip blanks / # comments)
    entries = []
    with open(a.infile, encoding='utf-8') as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if '|' not in line:
                sys.exit(f"❌ timeline line {n} needs 'SECONDS|text': {line!r}")
            off_s, text = line.split('|', 1)
            try:
                off = float(off_s.strip())
            except ValueError:
                sys.exit(f"❌ timeline line {n}: bad offset {off_s!r}")
            entries.append((off, text.strip()))
    if not entries:
        sys.exit("❌ timeline has no entries")

    rendered = [(off, render_line(pipe, text, a.voice, a.speed), text) for off, text in entries]
    end = max(off + len(aud) / SR for off, aud, _ in rendered)
    total = a.total if a.total and a.total > 0 else end + 0.3
    track = silence(total)

    # place each line + report timing; warn on overlaps (a line running into the next start)
    ordered = sorted(rendered, key=lambda r: r[0])
    warned = False
    for i, (off, aud, text) in enumerate(ordered):
        s = int(SR * off)
        e = min(s + len(aud), len(track))
        track[s:e] += aud[:e - s]
        endt = off + len(aud) / SR
        nxt = ordered[i + 1][0] if i + 1 < len(ordered) else total
        flag = ""
        if endt > nxt + 1e-3:
            flag = f"  ⚠ overlaps next (starts {nxt:.1f}s)"
            warned = True
        print(f"  @{off:6.1f}s  len {len(aud)/SR:4.1f}s  ends {endt:5.1f}s{flag}  | {text[:40]}")
    if warned:
        print("⚠ some lines overlap — widen those offsets or shorten the text/speed", file=sys.stderr)
    if a.total and end > a.total + 1e-3:
        print(f"⚠ content ends at {end:.1f}s but --total is {a.total:.1f}s (tail will be clipped on mux)",
              file=sys.stderr)
    return track


def main() -> None:
    ap = argparse.ArgumentParser(description="Kokoro narration → wav (sequential or beat-placed).")
    ap.add_argument('-i', '--infile', required=True, help='VO script (sequential: one line each; timeline: "SECONDS|text")')
    ap.add_argument('-o', '--out', required=True, help='output WAV (24kHz)')
    ap.add_argument('--timeline', action='store_true', help='place each line at its "SECONDS|" offset (synced VO)')
    ap.add_argument('--total', type=float, default=0.0, help='timeline: force track length in seconds (else = last line end + 0.3)')
    ap.add_argument('--voice', default='af_heart', help='Kokoro voice (Mirror narrator = af_heart)')
    ap.add_argument('--speed', type=float, default=0.9, help='<1 = calmer/slower delivery')
    ap.add_argument('--gap', type=float, default=0.5, help='sequential mode: silence between lines (s)')
    ap.add_argument('--lang', default='a', help="Kokoro lang_code ('a' = American English)")
    a = ap.parse_args()

    pipe = KPipeline(lang_code=a.lang)
    audio = run_timeline(pipe, a) if a.timeline else run_sequential(pipe, a)
    save_wav(a.out, audio, SR)
    print(f"✓ narration → {a.out}  ({a.voice} @ speed {a.speed}, {len(audio)/SR:.1f}s"
          f"{', timeline' if a.timeline else ''})")


if __name__ == '__main__':
    main()
