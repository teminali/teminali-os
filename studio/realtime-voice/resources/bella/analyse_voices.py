"""Judge the audition voices by measurement instead of by ear.

I cannot listen to these files, but "pick by ear" is not the only option and median
F0 is not the whole story. The properties that decide whether a synthetic voice is
pleasant over a long conversation are measurable:

  pitch range      monotony is the single most fatiguing quality in a TTS voice.
                   Measured in semitones over voiced frames; a narrow range reads
                   flat and robotic, a very wide one reads theatrical.
  harmonicity      harmonic energy over residual noise. Low values mean breathy or
                   grainy; very high means clean but can read synthetic.
  spectral tilt    energy slope across frequency. Steeply negative is warm and dark,
                   shallow is bright and, past a point, shrill and tiring.
  jitter/shimmer   period and amplitude instability. Small amounts read as human,
                   large amounts as rough or wobbly.
  formants         F1/F2 of voiced frames -- the perceived size and body of the
                   voice, independent of its pitch.
  intelligibility  the same Whisper model the assistant listens with, run over each
                   sample. A voice it mis-hears is a voice a distracted human will
                   mis-hear. Reported as word error rate against the known line.

    ../../.venv/bin/python -u analyse_voices.py
"""

import glob
import os
import warnings

import librosa
import numpy as np
import scipy.signal

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.normpath(os.path.join(HERE, "..", "..", "code", "static", "bella_preview"))
LINE = "Close the laptop. It will still be broken tomorrow, and you will be sharper."


def formants(y, sr, n=2):
    """First two formants by LPC, averaged over the strongest voiced window."""
    y = librosa.effects.preemphasis(y)
    order = int(2 + sr / 1000)
    frames = librosa.util.frame(y, frame_length=1024, hop_length=512)
    rms = np.sqrt((frames ** 2).mean(axis=0))
    picks = np.argsort(rms)[-40:]                 # loudest frames are the most voiced
    out = []
    for i in picks:
        seg = frames[:, i] * np.hamming(1024)
        try:
            a = librosa.lpc(seg, order=order)
        except Exception:
            continue
        roots = [r for r in np.roots(a) if np.imag(r) > 0.01]
        f = sorted(np.arctan2(np.imag(r), np.real(r)) * sr / (2 * np.pi) for r in roots)
        f = [x for x in f if 90 < x < 4000]
        if len(f) >= n:
            out.append(f[:n])
    return np.median(np.array(out), axis=0) if out else [0.0] * n


def analyse(path):
    y, sr = librosa.load(path, sr=24000)
    f0, voiced, _ = librosa.pyin(y, fmin=librosa.note_to_hz("C3"),
                                 fmax=librosa.note_to_hz("C6"), sr=sr)
    vf = f0[~np.isnan(f0)]

    # Pitch range in semitones, 5th-95th percentile so one glitch cannot dominate.
    if len(vf) > 5:
        lo, hi = np.percentile(vf, 5), np.percentile(vf, 95)
        st_range = 12 * np.log2(hi / lo) if lo > 0 else 0.0
        periods = 1.0 / vf
        jitter = 100 * np.mean(np.abs(np.diff(periods))) / np.mean(periods)
    else:
        st_range, jitter = 0.0, 0.0

    harm, perc = librosa.effects.hpss(y)
    hnr = 10 * np.log10((harm ** 2).sum() / max((perc ** 2).sum(), 1e-12))

    S = np.abs(librosa.stft(y))
    freqs = librosa.fft_frequencies(sr=sr)
    power = S.mean(axis=1) + 1e-12
    band = (freqs > 80) & (freqs < 8000)
    tilt = np.polyfit(np.log10(freqs[band]), 20 * np.log10(power[band]), 1)[0]

    rms = librosa.feature.rms(y=y)[0]
    shimmer = 100 * np.mean(np.abs(np.diff(rms))) / max(np.mean(rms), 1e-9)

    intervals = librosa.effects.split(y, top_db=30)
    speech = sum(b - a for a, b in intervals) / len(y)

    f1, f2 = formants(y, sr)
    return dict(f0=float(np.median(vf)) if len(vf) else 0.0, st_range=st_range,
                hnr=hnr, tilt=tilt, jitter=jitter, shimmer=shimmer,
                speech=100 * speech, f1=f1, f2=f2,
                centroid=float(librosa.feature.spectral_centroid(y=y, sr=sr).mean()))


def wer(ref, hyp):
    r, h = ref.lower().split(), hyp.lower().split()
    import re
    r = [re.sub(r"[^a-z']", "", w) for w in r]
    h = [re.sub(r"[^a-z']", "", w) for w in h]
    d = np.zeros((len(r) + 1, len(h) + 1), int)
    d[:, 0] = np.arange(len(r) + 1); d[0, :] = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i-1, j] + 1, d[i, j-1] + 1,
                          d[i-1, j-1] + (r[i-1] != h[j-1]))
    return 100 * d[len(r), len(h)] / max(len(r), 1)


def main():
    files = sorted(glob.glob(os.path.join(STATIC, "audition_*.wav")))
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device="cpu", compute_type="int8")

    print(f"{'voice':14s} {'F0':>6s} {'range':>7s} {'HNR':>6s} {'tilt':>6s} "
          f"{'jit%':>5s} {'shim%':>6s} {'F1':>5s} {'F2':>5s} {'WER%':>5s}  transcript")
    print("-" * 108)
    rows = {}
    for f in files:
        v = os.path.basename(f)[len("audition_"):-4]
        a = analyse(f)
        segs, _ = asr.transcribe(f, language="en", beam_size=5)
        text = " ".join(s.text for s in segs).strip()
        a["wer"] = wer(LINE, text)
        a["text"] = text
        rows[v] = a
        print(f"{v:14s} {a['f0']:6.1f} {a['st_range']:6.1f}st {a['hnr']:6.1f} "
              f"{a['tilt']:6.1f} {a['jitter']:5.2f} {a['shimmer']:6.1f} "
              f"{a['f1']:5.0f} {a['f2']:5.0f} {a['wer']:5.1f}  {text[:38]}")
    return rows


if __name__ == "__main__":
    main()
