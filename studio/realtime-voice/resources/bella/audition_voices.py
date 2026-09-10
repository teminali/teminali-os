"""Audition every locally cached Kokoro voice as a candidate for the assistant.

The forged-Bella work chased one target: reproduce Benedetta Porcaroli's measured
register. That is a different question from "which voice is best to listen to for
hours", and it was never asked. This asks it.

Every voice is rendered on the same line and measured for REAL-TIME FACTOR --
synthesis wall time divided by the duration of audio produced. RTF below 1.0 means
it generates faster than it plays, which is the actual precondition for streaming
speech with no waiting; the lower the number, the more headroom before the first
audible word. Latency is reported, not asserted.

    ../../.venv/bin/python -u audition_voices.py
"""

import glob
import os
import time

import certifi
import librosa
import numpy as np
import soundfile as sf

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ.setdefault("HF_HUB_OFFLINE", "1")

from kokoro import KPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.normpath(os.path.join(HERE, "..", "..", "code", "static", "bella_preview"))

LINE = ("Close the laptop. It will still be broken tomorrow, and you will be sharper.")
SPEED = 1.10

ACCENT = {"b": "British", "a": "American", "i": "Italian"}


def cached_voices():
    cache = os.path.expanduser("~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M")
    found = {os.path.basename(p)[:-3] for p in glob.glob(cache + "/**/voices/*.pt", recursive=True)}
    # Female voices only; the persona is a woman.
    return sorted(v for v in found if v[1] == "f")


def main():
    pipelines = {}
    rows = []
    for voice in cached_voices():
        lang = voice[0]                      # a=American, b=British, i=Italian
        if lang not in pipelines:
            pipelines[lang] = KPipeline(lang_code=lang)
        pipe = pipelines[lang]

        t0 = time.perf_counter()
        chunks = list(pipe(LINE, voice=voice, speed=SPEED))
        audio = np.concatenate([c.audio.cpu().numpy() for c in chunks if c.audio is not None])
        synth = time.perf_counter() - t0

        audio, _ = librosa.effects.trim(audio, top_db=25)
        out = os.path.join(STATIC, f"audition_{voice}.wav")
        sf.write(out, audio, 24000)

        dur = len(audio) / 24000
        f0, _, _ = librosa.pyin(audio, fmin=librosa.note_to_hz("C3"),
                                fmax=librosa.note_to_hz("C6"), sr=24000)
        voiced = f0[~np.isnan(f0)] if f0 is not None else np.array([])
        rows.append({
            "voice": voice,
            "accent": ACCENT.get(lang, lang),
            "dur": dur,
            "synth": synth,
            "rtf": synth / dur if dur else 0,
            "f0": float(np.median(voiced)) if len(voiced) else 0.0,
        })
        r = rows[-1]
        print(f"{voice:14s} {r['accent']:9s} {dur:5.2f}s audio  "
              f"synth {synth:5.2f}s  RTF {r['rtf']:.2f}  median F0 {r['f0']:6.1f} Hz")

    print("\nRTF < 1.0 generates faster than it plays. Lower is more headroom.")
    best = min(rows, key=lambda r: r["rtf"])
    print(f"fastest: {best['voice']} at RTF {best['rtf']:.2f}")
    return rows


if __name__ == "__main__":
    main()
