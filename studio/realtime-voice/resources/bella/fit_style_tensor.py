"""
Fit Kokoro 256-dim style tensors numerically instead of by ear.

The earlier Bella tensors (bella_exact_custom.pt, bella_neural_deep.pt) were built
from hand-picked blend weights. This script solves for the weights: it measures
register/timbre/phonation descriptors on the reference cuts, measures the same
descriptors on every candidate Kokoro voice actor, and searches the simplex of
blend weights (and the speed) that lands closest to the target.

Scope note: the descriptors are low-dimensional and generic -- median F0, F0
spread, jitter, creak fraction, spectral tilt, centroid, H1-H2, harmonic-to-noise
ratio and an octave-band long-term average spectrum. That describes a vocal
*register* (how deep, how bright, how creaky, how breathy), not a speaker
voiceprint. No speaker-embedding similarity is fitted and no reference audio
reaches the model; every output is a blend of licensed Kokoro voice actors,
exactly as the hand-tuned tensors were.

The style tensor is decoupled: [:128] is vocal-tract timbre, [128:] is prosodic
cadence. The halves are fitted against different feature groups.

The two usable reference cuts sit in genuinely different registers (~226 Hz
seductive vs ~180 Hz cold authority), so they are fitted SEPARATELY into one
tensor each rather than averaged into a voice that matches neither.

Usage:
    ../../.venv/bin/python fit_style_tensor.py [--evals 120] [--restarts 2]
"""

import argparse
import os

import librosa
import numpy as np
import soundfile as sf
import torch
from scipy.optimize import minimize

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES_DIR = os.path.join(HERE, "audio_samples")
SR = 24000

# Each reference cut becomes its own fitted register.
# bella_orig_s02e06_drive_carefully.wav is deliberately absent: it has 0% voiced
# frames in 70-400 Hz and 56% of its energy in the 80-200 Hz band, i.e. it is
# dominated by a low tonal source (engine/score), not speech. is_usable() would
# reject it anyway; it is left out so the run does not look like it lost a target.
TARGETS = [
    {"key": "seductive", "ref": "bella_orig_s02e04_hard_to_get.wav",
     "text": "I'm not playing hard to get... All you have to do is ask, Eddie.",
     "speed": 1.08},
    {"key": "authority", "ref": "bella_orig_s02e02_door_is_closed.wav",
     "text": "How and why my boyfriend was killed... is no longer relevant. That door is closed.",
     "speed": 1.10},
]

# Held out from fitting; used only to check the result generalises off its own line.
HOLDOUT_TEXT = ("Please drive carefully... If you hurt yourself, I'll kill you... "
                "But if you hurt the car... I'll kill your family.")

VOICES = [
    "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
    "af_sarah", "af_nicole", "af_heart", "af_bella", "af_sky",
    "if_sara",
]

LTAS_BANDS = [100, 200, 400, 800, 1600, 3200, 6400, 10000]
# 110 Hz, not 70: at a 70 Hz floor librosa.pyin halves octaves on the deeper
# voices, and every feature derived from the f0 track inherits the error. Measured
# 2026-09-09 on af_nicole (the deepest voice, true median 151.8 Hz): 9.8% of frames
# landed near median/2 carrying +12.4 dB more energy at 2*f0 than at the reported
# f0 -- the signature of halving, not of phonation. Measured before/after on the
# same s02e02 probe line, the floor change moves af_nicole: creak 21.5% -> 0.0%,
# jitter 3.93% -> 2.09%, f0_med 144.9 -> 146.8 Hz, and f0_range 17.48 -> 5.72 st
# (on the audition line). Its h1h2 barely moves (+21.3 -> +20.3), so that outlier
# is genuine lax/breathy phonation, NOT an artifact -- do not "fix" it.
# Nothing genuine is lost by the higher floor: both reference cuts measure 0.0% of
# voiced frames below 120 Hz, so the target has no creak or fry to miss.
F0_MIN, F0_MAX = 110.0, 400.0
CREAK_HZ = 120.0          # voiced frames below this are counted as creak/fry

MIN_VOICED_FRAC = 0.30
MAX_LOWBAND_FRAC = 0.45

TIMBRE_NAMES = ([f"ltas{lo}" for lo in LTAS_BANDS[:-1]] +
                ["tilt", "centroid", "h1h2", "hnr"])
# decl/term/pause_s are the cadence carriers. Measured reachability across all ten
# Kokoro voices on the s02e02 line: these three CAN be hit by blending, while
# f0_range (target 2.34 st) and the intensity dynamics (int_std 9.85 vs ceiling
# 7.54; int_rng 32.62 vs ceiling 26.42) are not reachable in any blend. The
# intensity features are therefore measured and reported but left OUT of the
# objective, so an unreachable target cannot distort a reachable one.
#
# The old justification for that exclusion said af_nicole "also has the widest
# pitch range of the set". That was the F0_MIN=70 octave-halving artifact above:
# af_nicole is in fact one of the FLATTEST voices (5.72 st at a sane floor) and the
# deepest. Whether including the intensity features now pays is an open question --
# do not re-answer it in the same run as the floor fix, or the two changes confound.
# The "Kokoro floor 5.26 st" figure is likewise retired: it was measured with the
# broken floor and has not been re-established.
PROSODY_NAMES = ["f0_med", "f0_p10", "f0_p90", "f0_range",
                 "jitter", "creak", "voiced", "rate",
                 "decl", "term", "pause_s"]

# LTAS bands are held at low weight: they carry the reference's TV dialogue EQ and
# compression as much as the speaker's resonance, so fitting them hard chases the
# mix. Tilt, H1-H2 and HNR describe phonation and are weighted up.
TIMBRE_WEIGHTS = np.array([0.5] * 7 + [2.0, 1.0, 2.0, 2.0])
PROSODY_WEIGHTS = np.array([3.0, 1.0, 1.0, 2.0, 1.5, 1.0, 1.0, 1.0,
                            2.0, 2.5, 2.0])

I_TILT = TIMBRE_NAMES.index("tilt")
I_H1H2 = TIMBRE_NAMES.index("h1h2")
I_HNR = TIMBRE_NAMES.index("hnr")

TOPK = 4                  # voices carried from stage A into stage B, per half


# ----------------------------------------------------------------------------
# Feature extraction
# ----------------------------------------------------------------------------

def _f0(y):
    f0, voiced, _ = librosa.pyin(y, fmin=F0_MIN, fmax=F0_MAX, sr=SR,
                                 frame_length=2048)
    return f0[voiced & np.isfinite(f0)], float(np.mean(voiced))


def _ltas(y):
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    power = np.mean(S ** 2, axis=1)
    bands = [power[(freqs >= lo) & (freqs < hi)].mean() if ((freqs >= lo) & (freqs < hi)).any()
             else 1e-12 for lo, hi in zip(LTAS_BANDS[:-1], LTAS_BANDS[1:])]
    db = 10.0 * np.log10(np.array(bands) + 1e-12)
    return db - db.mean()


def _tilt(y):
    """Spectral tilt in dB/octave over 100-5000 Hz -- chest vs head resonance."""
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    sel = (freqs >= 100) & (freqs <= 5000)
    db = 10.0 * np.log10(np.mean(S[sel] ** 2, axis=1) + 1e-12)
    return float(np.polyfit(np.log2(freqs[sel] / 100.0), db, 1)[0])


def _h1_h2(y, f0):
    """H1-H2 in dB: the classic breathy(+) vs pressed/creaky(-) phonation measure."""
    if f0.size == 0:
        return 0.0
    f0_med = float(np.median(f0))
    S = np.abs(librosa.stft(y, n_fft=4096, hop_length=512))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=4096)
    spec = np.mean(S ** 2, axis=1)

    def peak_db(centre):
        sel = (freqs > centre * 0.85) & (freqs < centre * 1.15)
        return 10.0 * np.log10(spec[sel].max() + 1e-12) if sel.any() else -120.0

    return float(peak_db(f0_med) - peak_db(2 * f0_med))


def _hnr(y):
    """Harmonic-to-noise ratio in dB -- low means breathy/smoky, high means clean."""
    h, p = librosa.effects.hpss(y)
    return float(10.0 * np.log10((np.mean(h ** 2) + 1e-12) / (np.mean(p ** 2) + 1e-12)))


def _rate(y):
    """Syllable-rate proxy: onset-envelope peaks per second."""
    env = librosa.onset.onset_strength(y=y, sr=SR)
    peaks = librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=3,
                                   post_avg=5, delta=0.2, wait=4)
    return float(len(peaks) / (len(y) / SR))


def _cadence(y):
    """Declination (st/s), terminal fall (st) and long-pause total (s).

    These are what makes a read sound like speech rather than a recital: whether
    the pitch drifts down across the utterance, how hard it drops on the final
    syllables, and how long the hesitations are.
    """
    f0, voiced, _ = librosa.pyin(y, fmin=F0_MIN, fmax=F0_MAX, sr=SR, frame_length=2048)
    idx = np.where(voiced & np.isfinite(f0))[0]
    if idx.size < 5:
        return 0.0, 0.0, 0.0
    st = 12.0 * np.log2(f0[idx] / 100.0)
    decl = float(np.polyfit(idx * 512 / SR, st, 1)[0])
    k = max(2, int(len(st) * 0.15))
    term = float(np.median(st[-k:]) - np.median(st))

    db = 20.0 * np.log10(librosa.feature.rms(y=y, hop_length=256)[0] + 1e-9)
    silent = db < (db.max() - 28)
    runs, run = [], 0
    for s_ in silent:
        if s_:
            run += 1
        elif run:
            runs.append(run * 256 / SR)
            run = 0
    if run:
        runs.append(run * 256 / SR)
    return decl, term, float(sum(r for r in runs if r > 0.12))


def intensity_dynamics(y):
    """Reported, not fitted -- outside Kokoro's reach (see PROSODY_NAMES)."""
    db = 20.0 * np.log10(librosa.feature.rms(y=y, hop_length=256)[0] + 1e-9)
    vd = db[db > (db.max() - 35)]
    return float(vd.std()), float(np.percentile(vd, 95) - np.percentile(vd, 5))


def is_usable(y):
    """Reject a reference cut whose pitch statistics would not describe a voice."""
    _, voiced_frac = _f0(y)
    S = np.abs(librosa.stft(y, n_fft=4096))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=4096)
    power = np.mean(S ** 2, axis=1)
    lowband = power[freqs < 200].sum() / power.sum()
    if voiced_frac < MIN_VOICED_FRAC:
        return False, f"only {voiced_frac * 100:.1f}% voiced frames"
    if lowband > MAX_LOWBAND_FRAC:
        return False, f"{lowband * 100:.0f}% of energy below 200 Hz (non-speech source)"
    return True, f"{voiced_frac * 100:.0f}% voiced, {lowband * 100:.0f}% below 200 Hz"


def features(y):
    """Return (timbre_features, prosody_features)."""
    y = librosa.util.normalize(y)
    f0, voiced_frac = _f0(y)
    if f0.size < 8:
        raise ValueError(f"only {f0.size} voiced frames -- not usable as a voice target")

    st = 12.0 * np.log2(f0 / 100.0)
    jitter = float(np.abs(np.diff(f0)).mean() / f0.mean()) if f0.size > 1 else 0.0
    creak = float(np.mean(f0 < CREAK_HZ))

    timbre = np.concatenate([
        _ltas(y),
        [_tilt(y)],
        [np.log2(float(np.mean(librosa.feature.spectral_centroid(y=y, sr=SR))) / 100.0)],
        [_h1_h2(y, f0)],
        [_hnr(y)],
    ])
    decl, term, pause_s = _cadence(y)
    prosody = np.array([
        np.median(st), np.percentile(st, 10), np.percentile(st, 90),
        np.percentile(st, 90) - np.percentile(st, 10),
        jitter * 100.0, creak * 100.0, voiced_frac * 10.0, _rate(y),
        decl, term, pause_s * 10.0,
    ])
    return timbre, prosody


# ----------------------------------------------------------------------------
# Synthesis
# ----------------------------------------------------------------------------

def synth(pipeline, style, text, speed):
    results = list(pipeline(text, voice=style, speed=speed))
    y = np.concatenate([r.audio.cpu().numpy() for r in results if r.audio is not None])
    y, _ = librosa.effects.trim(y, top_db=25)
    return y.astype(np.float32)


# ----------------------------------------------------------------------------
# Weight search
# ----------------------------------------------------------------------------

def _simplex_fit(basis, target, scale, fw):
    n = basis.shape[0]
    B, t = basis / scale * fw, target / scale * fw
    res = minimize(lambda w: float(np.sum((B.T @ w - t) ** 2)),
                   np.full(n, 1.0 / n), method="SLSQP",
                   bounds=[(0.0, 1.0)] * n,
                   constraints=[{"type": "eq", "fun": lambda w: w.sum() - 1.0}],
                   options={"maxiter": 500, "ftol": 1e-10})
    return res.x


def _prune(weights, floor=0.04):
    names = list(weights)
    w = np.array([weights[n] for n in names])
    w = np.where(w < floor, 0.0, w)
    if w.sum() <= 0:
        w = np.ones_like(w) / len(w)
    w = w / w.sum()
    return {n: float(v) for n, v in zip(names, w) if v > 0}


def formula(weights):
    return " + ".join(f"{v:.2f}*{k}" for k, v in
                      sorted(weights.items(), key=lambda kv: -kv[1]))


def blend(voice_tensors, weights, half):
    sl = slice(0, 128) if half == "timbre" else slice(128, 256)
    out = None
    for name, w in weights.items():
        part = voice_tensors[name][:, :, sl] * w
        out = part if out is None else out + part
    return out


def residual_table(t, p, target_t, target_p, scale_t, scale_p):
    rows = []
    for n, a, b, s, w in zip(TIMBRE_NAMES, t, target_t, scale_t, TIMBRE_WEIGHTS):
        rows.append((n, a, b, w * abs(a - b) / s))
    for n, a, b, s, w in zip(PROSODY_NAMES, p, target_p, scale_p, PROSODY_WEIGHTS):
        rows.append((n, a, b, w * abs(a - b) / s))
    return sorted(rows, key=lambda r: -r[3])


# ----------------------------------------------------------------------------

def fit_one(pipeline, voice_tensors, basis_t, basis_p, spec, args):
    key, text, speed0 = spec["key"], spec["text"], spec["speed"]
    print(f"\n{'=' * 72}\n== fitting register '{key}' against {spec['ref']}\n{'=' * 72}")

    y, _ = librosa.load(os.path.join(SAMPLES_DIR, spec["ref"]), sr=SR)
    y, _ = librosa.effects.trim(y, top_db=25)
    ok, why = is_usable(y)
    if not ok:
        print(f"  SKIPPED -- {why}")
        return None
    target_t, target_p = features(y)
    print(f"  target: F0 {100 * 2 ** (target_p[0] / 12):.1f} Hz, range {target_p[3]:.1f} st, "
          f"jitter {target_p[4]:.2f}%, creak {target_p[5]:.1f}%, tilt {target_t[I_TILT]:+.2f} dB/oct, "
          f"H1-H2 {target_t[I_H1H2]:+.1f} dB, HNR {target_t[I_HNR]:+.1f} dB  ({why})")

    scale_t = basis_t.std(axis=0) + 1e-6
    scale_p = basis_p.std(axis=0) + 1e-6

    wt = _prune(dict(zip(VOICES, _simplex_fit(basis_t, target_t, scale_t, TIMBRE_WEIGHTS))))
    wp = _prune(dict(zip(VOICES, _simplex_fit(basis_p, target_p, scale_p, PROSODY_WEIGHTS))))
    names_t = sorted(wt, key=lambda n: -wt[n])[:TOPK]
    names_p = sorted(wp, key=lambda n: -wp[n])[:TOPK]
    print(f"  stage A timbre  {formula(wt)}")
    print(f"  stage A prosody {formula(wp)}")

    def build(a, b):
        return torch.cat([blend(voice_tensors, a, "timbre"),
                          blend(voice_tensors, b, "prosody")], dim=2)

    def cost_of(style, speed):
        t, p = features(synth(pipeline, style, text, speed))
        # Groups weighted equally despite differing dimensionality.
        ct = np.sum(TIMBRE_WEIGHTS * ((t - target_t) / scale_t) ** 2) / TIMBRE_WEIGHTS.sum()
        cp = np.sum(PROSODY_WEIGHTS * ((p - target_p) / scale_p) ** 2) / PROSODY_WEIGHTS.sum()
        return float(ct + cp), t, p

    def unpack(x):
        a = np.exp(np.clip(x[:len(names_t)], -8, 8))
        b = np.exp(np.clip(x[len(names_t):len(names_t) + len(names_p)], -8, 8))
        speed = float(np.clip(x[-1], 0.90, 1.30))
        return (dict(zip(names_t, a / a.sum())),
                dict(zip(names_p, b / b.sum())), speed)

    best = {"cost": np.inf, "wt": None, "wp": None, "speed": speed0, "n": 0}

    def score(a, b, speed, tag):
        best["n"] += 1
        c, _, _ = cost_of(build(a, b), speed)
        if c < best["cost"]:
            best.update(cost=c, wt=dict(a), wp=dict(b), speed=speed)
            print(f"    {tag} {best['n']:3d}  cost {c:.4f}  speed {speed:.3f}  <- best")
        return c

    # Phase 1: Dirichlet exploration over the FULL voice simplex. Nelder-Mead was
    # returning stage A unchanged -- a noisy 9-dim objective defeats it -- so the
    # broad search happens by sampling, and the simplex is sampled directly rather
    # than through a log parameterisation that distorts the measure.
    rng = np.random.default_rng(0)
    explore = max(1, int(args.evals * 0.55))
    print(f"    phase 1: {explore} Dirichlet samples over all {len(VOICES)} voices")
    score(wt, wp, speed0, "seed")
    for i in range(explore):
        # Alternate between a broad prior and one concentrated on the stage-A support.
        if i % 2 == 0:
            alpha_t = np.full(len(VOICES), 0.35)
            alpha_p = np.full(len(VOICES), 0.35)
        else:
            alpha_t = np.array([6.0 if v in names_t else 0.25 for v in VOICES])
            alpha_p = np.array([6.0 if v in names_p else 0.25 for v in VOICES])
        a = dict(zip(VOICES, rng.dirichlet(alpha_t)))
        b = dict(zip(VOICES, rng.dirichlet(alpha_p)))
        sp = float(np.clip(rng.normal(speed0, 0.05), 0.95, 1.25))
        score(a, b, sp, "rand")

    # Phase 2: local polish on the best support found.
    names_t = sorted(best["wt"], key=lambda n: -best["wt"][n])[:TOPK]
    names_p = sorted(best["wp"], key=lambda n: -best["wp"][n])[:TOPK]
    polish = args.evals - best["n"]
    print(f"    phase 2: {polish} Nelder-Mead polish on "
          f"{'+'.join(names_t)} / {'+'.join(names_p)}")

    def objective(x):
        a, b, sp = unpack(x)
        return score(a, b, sp, "poli")

    x0 = np.concatenate([
        np.log([max(best["wt"].get(n, 1e-3), 1e-3) for n in names_t]),
        np.log([max(best["wp"].get(n, 1e-3), 1e-3) for n in names_p]),
        [best["speed"]]])
    for r in range(args.restarts):
        xs = x0 if r == 0 else x0 + np.concatenate([
            rng.normal(0, 0.4, len(names_t) + len(names_p)), [rng.normal(0, 0.015)]])
        minimize(objective, xs, method="Nelder-Mead",
                 options={"maxfev": max(10, polish // args.restarts),
                          "xatol": 1e-3, "fatol": 1e-5})

    wt, wp, speed = _prune(best["wt"]), _prune(best["wp"]), best["speed"]
    style = build(wt, wp)
    cost, t, p = cost_of(style, speed)

    print(f"\n  RESULT '{key}'  cost {cost:.4f}  speed {speed:.3f}")
    print(f"    timbre  [:128]  {formula(wt)}")
    print(f"    prosody [128:]  {formula(wp)}")
    print(f"    fitted: F0 {100 * 2 ** (p[0] / 12):.1f} Hz (target {100 * 2 ** (target_p[0] / 12):.1f}), "
          f"range {p[3]:.1f} (target {target_p[3]:.1f}), jitter {p[4]:.2f} (target {target_p[4]:.2f}), "
          f"creak {p[5]:.1f} (target {target_p[5]:.1f})")
    print(f"    worst-matched features (z-distance):")
    for n, a, b, z in residual_table(t, p, target_t, target_p, scale_t, scale_p)[:5]:
        print(f"      {n:10} fitted {a:+8.2f}  target {b:+8.2f}  z {z:.2f}")

    out = os.path.join(SAMPLES_DIR, f"bella_fitted_{key}.pt")
    torch.save(style, out)
    print(f"    saved {os.path.basename(out)}  shape {tuple(style.shape)}")

    for label, txt in (("line", text), ("holdout", HOLDOUT_TEXT)):
        wav = os.path.join(SAMPLES_DIR, f"bella_fitted_{key}_{label}.wav")
        audio = synth(pipeline, style, txt, speed)
        sf.write(wav, audio, SR)
        print(f"    wrote {os.path.basename(wav)}  ({len(audio) / SR:.2f}s)")

    return {"key": key, "cost": cost, "formula_t": formula(wt),
            "formula_p": formula(wp), "speed": speed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evals", type=int, default=120)
    ap.add_argument("--restarts", type=int, default=2)
    args = ap.parse_args()

    from kokoro import KPipeline
    pipeline = KPipeline(lang_code="a")

    print("== basis: measuring each Kokoro voice ==")
    voice_tensors, bt, bp = {}, [], []
    probe = TARGETS[1]["text"]
    for v in VOICES:
        style = pipeline.load_voice(v)
        voice_tensors[v] = style
        t, p = features(synth(pipeline, style, probe, 1.10))
        bt.append(t)
        bp.append(p)
        print(f"  {v:14} F0 {100 * 2 ** (p[0] / 12):6.1f} Hz  tilt {t[I_TILT]:+6.2f}  "
              f"H1-H2 {t[I_H1H2]:+6.1f}  HNR {t[I_HNR]:+5.1f}  creak {p[5]:4.1f}%  jitter {p[4]:.2f}%")
    bt, bp = np.array(bt), np.array(bp)

    results = [r for r in (fit_one(pipeline, voice_tensors, bt, bp, s, args)
                           for s in TARGETS) if r]

    print(f"\n{'=' * 72}\n== summary ==")
    for r in results:
        print(f"  {r['key']:10} cost {r['cost']:.4f}  speed {r['speed']:.3f}")
        print(f"    timbre  {r['formula_t']}")
        print(f"    prosody {r['formula_p']}")


if __name__ == "__main__":
    main()
