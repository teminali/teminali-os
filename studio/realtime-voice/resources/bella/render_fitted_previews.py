"""Render the two numerically fitted voices to audio so they can be heard.

`fit_style_tensor.py` solved bella_fitted_authority.pt and bella_fitted_seductive.pt
against measured descriptors, and `audio_module.py` wires both as switchable
profiles -- but neither has ever been rendered to a file. A blend that wins on
F0 residual can still be unpleasant to listen to, and that is not visible in a
cost number.

This renders both, plus the shipped default, on the same three lines the existing
benchmarks use, at each profile's own shipped speed, so the preview page can A/B
them against each other and against the real reference clips.

    ../../.venv/bin/python -u render_fitted_previews.py
"""

import os

import certifi
import librosa
import numpy as np
import soundfile as sf
import torch

os.environ["SSL_CERT_FILE"] = certifi.where()

from kokoro import KPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "audio_samples")
STATIC = os.path.normpath(os.path.join(HERE, "..", "..", "code", "static", "bella_preview"))

# Same lines as generate_decoupled_bella_benchmarks.py, so the new renders drop
# straight into the existing comparison.
LINES = [
    ("s1", "I'm not playing hard to get... All you have to do is ask, Eddie."),
    ("s2", "How and why my boyfriend was killed... is no longer relevant. That door is closed."),
    ("s3", "Please drive carefully... If you hurt yourself, I'll kill you... "
           "But if you hurt the car... I'll kill your family."),
]

# Speed is part of the profile, not a knob to equalise: these are the values
# audio_module.py ships for each, so this is what the operator would hear.
VOICES = [
    ("bella_fit_authority", "bella_fitted_authority.pt", 1.07),
    ("bella_fit_seductive", "bella_fitted_seductive.pt", 1.06),
    ("bella_soranza", "bella_exact_custom.pt", 1.10),
]

# The reference clips, for the F0 the renders are being judged against. Scene 3
# is deliberately absent: bella_exact_scene3_original.wav (identical to
# audio_samples/bella_orig_s02e06_drive_carefully.wav) is a car scene whose
# pitch track is rumble, not voice. Measured: with fmin=C3 it reports 40.2%
# voiced at a median F0 of 130.8 Hz -- which is fmin exactly, i.e. railed on the
# analysis floor. Drop fmin to C2 and it slides to 105.0 Hz with voicing halved
# to 20.1%, while scene 1 holds steady at 226.4 -> 227.8 Hz, 69% -> 70%. A real
# voice does not move when you move the floor. Scoring against this file is how
# the "98.8% match" headline was manufactured.
#
# (The earlier handover recorded this file as 0% voiced. That number does not
# reproduce; the conclusion it drew from it does.)
REFERENCE = {
    "s1": "bella_exact_scene1_original.wav",
    "s2": "bella_exact_scene2_original.wav",
}


def measure(path):
    y, sr = librosa.load(path, sr=24000)
    f0, voiced, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz("C3"), fmax=librosa.note_to_hz("C6"), sr=sr)
    voiced_f0 = f0[~np.isnan(f0)] if f0 is not None else np.array([])
    share = float(np.mean(voiced)) if voiced is not None and len(voiced) else 0.0
    return {
        "dur": len(y) / sr,
        "f0": float(np.median(voiced_f0)) if len(voiced_f0) else 0.0,
        "voiced": share,
    }


def main():
    pipeline = KPipeline(lang_code="b")

    print("reference clips")
    for key, name in REFERENCE.items():
        m = measure(os.path.join(STATIC, name))
        print(f"  {key}  {m['dur']:5.2f}s  median F0 {m['f0']:6.1f} Hz  "
              f"voiced {100 * m['voiced']:.0f}%")

    for profile, tensor_name, speed in VOICES:
        style = torch.load(os.path.join(SAMPLES, tensor_name), weights_only=True)
        print(f"\n{profile}  ({tensor_name}, speed {speed})")
        for key, text in LINES:
            chunks = list(pipeline(text, voice=style, speed=speed))
            audio = np.concatenate(
                [c.audio.cpu().numpy() for c in chunks if c.audio is not None])
            audio, _ = librosa.effects.trim(audio, top_db=25)
            out = os.path.join(STATIC, f"{profile}_{key}.wav")
            sf.write(out, audio, 24000)
            m = measure(out)
            ref = REFERENCE.get(key)
            delta = ""
            if ref:
                r = measure(os.path.join(STATIC, ref))
                delta = f"  vs reference: F0 {m['f0'] - r['f0']:+6.1f} Hz"
            print(f"  {key}  {m['dur']:5.2f}s  median F0 {m['f0']:6.1f} Hz  "
                  f"voiced {100 * m['voiced']:.0f}%{delta}")
            if m["voiced"] < 0.2:
                print(f"       WARNING: almost no voiced audio in {out}")


if __name__ == "__main__":
    main()
