#!/usr/bin/env python3
"""saga-clone.py — voice-cloned narration via Chatterbox TTS (MIT, commercial-safe).

Zero-shot clone from a short clean reference (~30-45s WAV, close-mic, quiet room).
The MIRROR narrator alternative to Kokoro (saga-vo.py): same pipeline slot, but the
brand's OWN voice. Runs in the isolated venv-chatter on the pod (torch 2.8+cu128 for
Blackwell). Tuned defaults are the values chosen in the V3 shoot: exaggeration 0.3,
cfg 0.5 (lower cfg = closer to the reference's natural cadence/timbre).

  saga-clone.py -t "line" -r voiceref.wav -o out.wav [--exaggeration 0.3] [--cfg 0.5]

Consent: only clone a voice you own or have explicit written consent to use. Keep the
reference recording and Chatterbox's built-in watermark (on by default).
"""
import argparse, torchaudio as ta
from chatterbox.tts import ChatterboxTTS

ap = argparse.ArgumentParser()
ap.add_argument('-t', '--text', required=True)
ap.add_argument('-r', '--ref', required=True, help='reference voice wav (~30-45s, clean)')
ap.add_argument('-o', '--out', default='clone_out.wav')
ap.add_argument('--exaggeration', type=float, default=0.3, help='low = calm/natural (V3: 0.3)')
ap.add_argument('--cfg', type=float, default=0.5, help='lower = closer to the reference (V3: 0.5)')
ap.add_argument('--device', default='cuda')
a = ap.parse_args()

m = ChatterboxTTS.from_pretrained(device=a.device)
wav = m.generate(a.text, audio_prompt_path=a.ref, exaggeration=a.exaggeration, cfg_weight=a.cfg)
ta.save(a.out, wav, m.sr)
print("✓", a.out, "@", m.sr, "Hz")
