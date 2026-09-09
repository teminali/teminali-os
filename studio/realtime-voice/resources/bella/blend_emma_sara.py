"""Separate if_sara's darkness from if_sara's accent.

The user auditioned all ten voices and reported bf_emma and if_sara as closest to
Bella, then ruled sara out: "her accent is too deep into italian". Both halves of
that judgement are visible in the measurements from analyse_voices.py:

    bf_emma   F0 182.3   tilt -13.7   F1 831   F2 1886   WER  0.0%
    if_sara   F0 216.2   tilt -21.6   F1 568   F2 1419   WER 14.3%

if_sara has the steepest spectral tilt of the ten and an F2 four hundred hertz below
every other voice. That is a dark, covered vocal tract -- the quality the ear is
picking up. It is also, phonetically, the Italian accent: the same low F2 that reads
as "warm" reads as "foreign vowels", and Whisper mis-hears one word in seven.

The claim under test is that those are separable, for two structural reasons:

  1. Pronunciation comes from the pipeline's lang_code, not from the voice tensor.
     if_sara's 14.3% was measured under KPipeline(lang_code="i") -- an Italian
     grapheme-to-phoneme frontend applied to an English sentence. Rendered under the
     British frontend, her tensor never chooses a phoneme.
  2. The style vector is two independent halves: [0:128] timbre, [128:256] prosody
     (see fit_style_tensor.blend). Vocal-tract colour and speech melody can be taken
     from different voices.

So the ladder holds prosody at pure bf_emma and walks if_sara into the timbre half
alone. The CONTROL walks her into both halves at the same weight. If the accent
lives in prosody, the control's WER climbs while the timbre-only column stays at
zero -- and a control that fails to break is a result too, because it would mean
the accent is in the timbre half and the whole approach is dead.

WER is the gate, not a statistic: it is the same Whisper the assistant listens with,
so a voice it mis-hears is one a distracted human mis-hears.

Bella's own reference cuts are measured with the identical code and printed as
target rows, so the ladder is read against her rather than against "darker is
better". Rendered clips land in code/static/bella_preview/ as emmasara_*.wav.

    ../../.venv/bin/python -u blend_emma_sara.py
"""

import os
import warnings

import certifi
import numpy as np
import soundfile as sf
import torch

warnings.filterwarnings("ignore")
os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import librosa
from analyse_voices import LINE, analyse, wer

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "audio_samples")
STATIC = os.path.normpath(os.path.join(HERE, "..", "..", "code", "static", "bella_preview"))

# Rendered under the BRITISH frontend: bf_emma leads the formula, and RealtimeTTS
# takes a blend's lang_code from its first token, so this is what production runs.
LANG = "b"
SPEED = 1.10
BASE, DARK = "bf_emma", "if_sara"

# A line with no Italian-friendly vowels to hide behind, held out of the fit.
HOLDOUT = ("Please drive carefully. If you hurt yourself, I'll kill you. "
           "But if you hurt the car, I'll kill your family.")

WEIGHTS = [0.00, 0.15, 0.30, 0.45, 0.60, 0.75, 1.00]

# The measured target. Two cuts, because one line is not a voice.
REFERENCES = [
    ("REF authority", "bella_orig_s02e02_door_is_closed.wav"),
    ("REF seductive", "bella_orig_s02e04_hard_to_get.wav"),
]

HEAD = (f"{'candidate':22s} {'F0':>6s} {'range':>7s} {'HNR':>6s} {'tilt':>6s} "
        f"{'F1':>5s} {'F2':>5s} {'WER%':>5s}  transcript")


def synth(pipeline, style, text):
    results = list(pipeline(text, voice=style, speed=SPEED))
    y = np.concatenate([r.audio.cpu().numpy() for r in results if r.audio is not None])
    y, _ = librosa.effects.trim(y, top_db=25)
    return y.astype(np.float32)


def mix(tensors, w, both):
    """Timbre half = (1-w)*emma + w*sara. Prosody half likewise only if `both`."""
    def half(sl, weight):
        return tensors[BASE][:, :, sl] * (1 - weight) + tensors[DARK][:, :, sl] * weight
    return torch.cat([half(slice(0, 128), w),
                      half(slice(128, 256), w if both else 0.0)], dim=2)


def row(label, path, asr, ref_text):
    a = analyse(path)
    segs, _ = asr.transcribe(path, language="en", beam_size=5)
    text = " ".join(s.text for s in segs).strip()
    a["wer"] = wer(ref_text, text) if ref_text else float("nan")
    w = f"{a['wer']:5.1f}" if ref_text else "    -"
    print(f"{label:22s} {a['f0']:6.1f} {a['st_range']:6.1f}st {a['hnr']:6.1f} "
          f"{a['tilt']:6.1f} {a['f1']:5.0f} {a['f2']:5.0f} {w}  {text[:34]}")
    return a


def main():
    from faster_whisper import WhisperModel
    from kokoro import KPipeline

    asr = WhisperModel("small.en", device="cpu", compute_type="int8")
    pipeline = KPipeline(lang_code=LANG)
    tensors = {v: pipeline.load_voice(v) for v in (BASE, DARK)}

    print("\nTARGET -- Benedetta Porcaroli's own cuts, same measurement code.\n")
    print(HEAD)
    print("-" * 104)
    targets = [row(label, os.path.join(SAMPLES, f), asr, None) for label, f in REFERENCES]
    tgt_f1 = float(np.mean([t["f1"] for t in targets]))
    tgt_f2 = float(np.mean([t["f2"] for t in targets]))
    tgt_tilt = float(np.mean([t["tilt"] for t in targets]))

    for both in (False, True):
        arm = "CONTROL: sara in BOTH halves" if both else "sara in the TIMBRE half only"
        print(f"\n{arm}  (prosody = {'sara too' if both else 'pure bf_emma'})\n")
        print(HEAD)
        print("-" * 104)
        for w in WEIGHTS:
            tag = f"{'both' if both else 'timb'}_{int(w * 100):03d}"
            path = os.path.join(STATIC, f"emmasara_{tag}.wav")
            sf.write(path, synth(pipeline, mix(tensors, w, both), LINE), 24000)
            a = row(f"sara {w:.2f} {'both' if both else 'timbre'}", path, asr, LINE)
            if not both:
                a["w"] = w
                ladder.append(a)
            # The holdout is for the ear, not the table: it is Bella's own line.
            sf.write(os.path.join(STATIC, f"emmasara_{tag}_holdout.wav"),
                     synth(pipeline, mix(tensors, w, both), HOLDOUT), 24000)

    print(f"\nTarget colour: F1 {tgt_f1:.0f}  F2 {tgt_f2:.0f}  tilt {tgt_tilt:.1f}")
    clean = [a for a in ladder if a["wer"] == 0.0]
    if clean:
        def dist(a):
            return (abs(a["f1"] - tgt_f1) / 200) ** 2 + (abs(a["f2"] - tgt_f2) / 300) ** 2 \
                 + (abs(a["tilt"] - tgt_tilt) / 4) ** 2
        best = min(clean, key=dist)
        print(f"Closest to target with WER still 0.0%: sara {best['w']:.2f} in timbre "
              f"(F1 {best['f1']:.0f}  F2 {best['f2']:.0f}  tilt {best['tilt']:.1f})")
    else:
        print("No timbre-only weight kept WER at 0.0% -- the accent is not separable.")
    print(f"\nAudition: http://127.0.0.1:8000/static/bella_preview/emmasara_timb_045.wav "
          f"(and _holdout for Bella's own line)")


ladder = []

if __name__ == "__main__":
    main()
