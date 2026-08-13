#!/usr/bin/env python3
"""saga-vo.py — Mirror narration generator (self-hosted TTS via Kokoro).

Reusable AUDIO component of the self-hosted Mirror content pipeline
(image -> video -> AUDIO -> ffmpeg assembler). No ElevenLabs: renders narration
locally on the pod GPU/CPU with Kokoro, zero per-word cost.

Input : a plain-text VO script, ONE line per narration line. A blank line adds an
        extra beat. Storyboard SSML-style pauses are honored:
          <break time="0.6s"/>  -> inserts 0.6s of silence
        Ellipses / commas render as Kokoro's own natural pauses.
Output: a single 24kHz WAV — the video's full narration track, ready for the
        ffmpeg assembler to lay under the animated clips.

Usage : saga-vo.py -i vid1.txt -o vid1_vo.wav [--voice af_heart] [--speed 0.9] [--gap 0.5]

Voice is locked to the Mirror brand narrator (af_heart, warm/calm) but overridable.
Keep the SAME voice across every video for brand consistency (per the storyboard kit).
"""
import argparse
import re

import numpy as np
import soundfile as sf
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('-i', '--infile', required=True, help='VO script: one narration line per line')
    ap.add_argument('-o', '--out', required=True, help='output WAV (24kHz)')
    ap.add_argument('--voice', default='af_heart', help='Kokoro voice (Mirror narrator = af_heart)')
    ap.add_argument('--speed', type=float, default=0.9, help='<1 = calmer/slower delivery')
    ap.add_argument('--gap', type=float, default=0.5, help='silence between lines (s)')
    ap.add_argument('--lang', default='a', help="Kokoro lang_code ('a' = American English)")
    a = ap.parse_args()

    pipe = KPipeline(lang_code=a.lang)
    track = []
    with open(a.infile, encoding='utf-8') as fh:
        for raw in fh:
            line = raw.rstrip('\n')
            track.append(silence(a.gap) if not line.strip()
                         else render_line(pipe, line, a.voice, a.speed))
            track.append(silence(a.gap))
    sf.write(a.out, np.concatenate(track) if track else silence(0), SR)
    print(f"✓ narration → {a.out}  ({a.voice} @ speed {a.speed})")


if __name__ == '__main__':
    main()
