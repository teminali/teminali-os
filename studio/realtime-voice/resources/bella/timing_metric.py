"""Measure DELIVERY, not timbre -- the axes the six-axis acoustic metric cannot see.

The acoustic metric (analyse_voices.py: F0, range, HNR, tilt, F1, F2) is saturated:
bf_emma scores 73.1% against Bella's reference cuts while Bella scores 71.7% against
herself. Every one of those six axes is STATIC -- a single number summarising the whole
file. None of them can represent the property the user actually hears and calls "lazy":

    "i also realized bella orignal voice has that lazy feeling"

Lazy is a property of TIME. It is some combination of speaking slowly, leaving gaps
where a script has no punctuation, trailing off at the end of a phrase instead of
landing on it, and not fully reaching the target position of each vowel. Those are
four separate measurable things, and this module measures them.

The axes
--------
articulation rate   syllables per second of PHONATION -- pauses excluded. This is the
                    rate of the mouth, not of the paragraph. A slow talker with no
                    pauses and a fast talker with many pauses have the same speech
                    rate and completely different deliveries; only this separates them.
speech rate         syllables per second overall, pauses included. Reported alongside
                    so the difference between the two IS the pause burden.
pause structure     count, median and p90 duration, and share of total time. A pause
                    is a silence run >= 120 ms; below that is a stop consonant closure,
                    not a hesitation.
pause PLACEMENT     the share of pauses that fall where no punctuation is. This is the
                    axis with the most headroom: Kokoro can only pause where the text
                    tells it to, so it pauses at commas and full stops and nowhere
                    else. A human hesitates mid-clause. Expected to be the single
                    largest gap between her and any TTS render.
final lengthening   the last word of a phrase, per syllable, over the phrase mean.
                    Drawling the last word is most of what "trailing off" sounds like.
final pitch slope   semitones per second over the last 300 ms of each phrase. Strongly
                    negative is a dropped, disengaged ending; near zero is a recital.
energy decay        dB per second over the last 200 ms. Fading out vs stopping.
vowel space         the AREA of the F1/F2 scatter, not its centre. Undershoot -- the
                    articulatory signature of relaxed speech -- shrinks the area while
                    leaving the means, which is exactly why the six-axis metric (which
                    fits F1 and F2 MEANS) is blind to it.

Two decisions worth stating
---------------------------
1. TURN GAPS ARE NOT PAUSES. bella_raw_reference_s02e02.wav is 46 s of dialogue with
   the other actor's lines cut out; it contains gaps of 4.1 s, 3.1 s and 6.9 s. Those
   are edit points, not her delivery. Any silence >= TURN_GAP is excluded from the
   pause statistics and reported separately, or the median pause would describe the
   film editor rather than the performer.
2. PAUSES COME FROM ENERGY, PLACEMENT COMES FROM WHISPER. Whisper's word timestamps
   are attention-derived and drift by tens of milliseconds -- good enough to say WHICH
   word boundary a pause sits at, not good enough to say how long it was. So silence
   runs are measured from the RMS envelope and then attributed to the nearest word
   boundary. Neither tool is asked for what it cannot give.

What the metric can and cannot support (measured 2026-09-09)
-----------------------------------------------------------
Run with --floor: the 46 s reference is cut in half and each half measured, which is
the timing analogue of "Bella scores 71.7% against Bella" on the acoustic metric. The
result decides which axes may be quoted at all.

    axis              half 1   half 2   verdict
    artic_rate          5.14     5.26   STABLE (2.3%) -- the only axis good on 23 s
    vowel_area         19.37    26.61   spread 7.2 -- an undershoot claim needs >7
    speech_rate         3.89     4.82   content-bound
    pause_ratio         24.3      8.3   content-bound
    pause_med           0.71     0.49   content-bound
    mid_clause_frac       17       50   content-bound
    final_lengthen      1.76     0.49   content-bound
    final_slope         -2.0     -0.3   content-bound
    decay_slope          -27       -7   content-bound

"Content-bound" does not mean useless -- it means those axes may only be compared on
MATCHED TEXT (--vs-emma renders her exact words), never between two different samples.
Unpaired, half of them disagree with themselves by more than any effect worth chasing.

NEVER POOL MID-CLAUSE AND PUNCTUATED PAUSES. pause_med does, and on her reference it
reads 0.71 s -- which is her SENTENCE BOUNDARIES, a thing bf_emma already produces on
its own at punctuation. Her actual mid-clause hesitations are 0.13, 0.41 and 0.52 s.
Read the pooled figure as a hesitation target and you ask the delivery layer for a gap
longer than the longest she ever takes; that was done on 2026-09-09 and the user heard
it at once -- "her pauses are very short, completely swallowed, almost non". Quote
pause_med_mid (hers 0.41) against a hesitation and pause_med_punct (hers 0.85) against
a sentence break.

Both new axes inherit the mid_clause_frac caveat below: on OUR OWN renders the split is
wrong, because Whisper transcribes an inserted "..." back as punctuation, so every
hesitation the delivery layer adds is filed under pause_med_punct and pause_med_mid
reads 0.00. On natural speech the split is sound. Fixing it needs the pre-lazify source
text passed into measure() and placement classified against that, not against Whisper.

    ../../.venv/bin/python -u timing_metric.py FILE [FILE ...]
    ../../.venv/bin/python -u timing_metric.py --floor        # Bella vs Bella
    ../../.venv/bin/python -u timing_metric.py --vs-emma      # paired, matched text
    ../../.venv/bin/python -u timing_metric.py --speed-sweep  # the speed calibration
"""

import json
import os
import re
import sys
import warnings

import librosa
import numpy as np

warnings.filterwarnings("ignore")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "audio_samples")
CACHE = os.path.join(HERE, ".cache")

SR = 24000
HOP = 256                      # 10.7 ms -- fine enough to time a 120 ms pause
F0_MIN, F0_MAX = 90.0, 400.0   # narrow: analyse()'s C3-C6 octave-doubles on long files
SIL_DB = 32.0                  # below peak, counts as silence
PAUSE_MIN = 0.12               # shorter than this is a stop closure, not a hesitation
TOL = 0.10                     # Whisper word-time drift; see word_pauses()
TURN_GAP = 2.50                # longer than this is an edit point, not her delivery
# 2.50 is measured, not chosen. On the reference the gap durations are bimodal with
# nothing in between: her longest real between-sentence pauses are 1.54 and 1.56 s,
# and the four stretches where the other actor was cut out are 3.58, 4.54, 7.34 and
# 8.02 s. An earlier 1.50 s cut through the middle of that gap and threw away two
# genuine sentence-final pauses as if they were edit points.
FINAL_WIN = 0.30               # window for the phrase-final pitch slope
DECAY_WIN = 0.20               # window for the phrase-final energy decay

# misaki's vowel nuclei: standard IPA plus its own digraph-free diphthong letters
# (A=face I=price W=mouth Y=choice Q=goat_GB O=goat_US) and the syllabic schwas.
VOWELS = set("AIWYQOɑɒɔæəɜɛɪiʊuʌᵊᵻ")

AXES = ["artic_rate", "speech_rate", "pause_ratio", "pause_med", "pause_p90",
        "pause_per_100syl", "pause_med_mid", "pause_med_punct", "mid_clause_frac", "final_lengthen", "final_slope",
        "decay_slope", "vowel_area"]


# --------------------------------------------------------------------------- words

def transcribe(path):
    """Word timestamps, cached -- Whisper on 46 s of audio is not free."""
    os.makedirs(CACHE, exist_ok=True)
    key = os.path.join(CACHE, os.path.basename(path) + ".words.json")
    if os.path.exists(key) and os.path.getmtime(key) > os.path.getmtime(path):
        return json.load(open(key))
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device="cpu", compute_type="int8")
    segs, _ = asr.transcribe(path, language="en", beam_size=5,
                             word_timestamps=True, vad_filter=False)
    out = []
    for s in segs:
        for w in (s.words or []):
            out.append(dict(w=w.word.strip(), s=float(w.start), e=float(w.end)))
    json.dump(out, open(key, "w"))
    return out


_G2P = None


def syllables(word):
    """Syllable count from Kokoro's own G2P -- count vowel nuclei in the phonemes.

    Using misaki rather than a vowel-letter heuristic matters: the heuristic gets
    "closed" (1) and "organisation" (5) wrong in opposite directions, and those errors
    do not cancel -- they land directly on the articulation rate.
    """
    global _G2P
    w = re.sub(r"[^A-Za-z']", "", word)
    if not w:
        return 0
    if _G2P is None:
        from misaki import en
        _G2P = en.G2P(trf=False, british=True, fallback=None)
    ps, _ = _G2P(w)
    n = sum(1 for ch in ps if ch in VOWELS)
    return max(n, 1)


# ------------------------------------------------------------------------- silence

def silence_runs(y):
    """Silence runs as (start_s, end_s) from the RMS envelope."""
    db = 20.0 * np.log10(librosa.feature.rms(y=y, hop_length=HOP)[0] + 1e-9)
    quiet = db < (db.max() - SIL_DB)
    runs, start = [], None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            runs.append((start * HOP / SR, i * HOP / SR))
            start = None
    if start is not None:
        runs.append((start * HOP / SR, len(quiet) * HOP / SR))
    return runs


def word_pauses(y, words):
    """Pauses: existence and duration from energy, placement from Whisper.

    Each tool is used for what it is good at, because using either alone fails, and
    both failures were observed on the reference file before this was written.

    ENERGY ALONE over-counts. bella_raw_reference_s02e02.wav has stretches
    (14.1-18.3 s, 34.1-40.9 s) where the other actor's lines were cut out: 0.0%
    voiced, median -44 dB, but room tone peaking at -27 dB. A peak-relative
    threshold chops that into fragments and reports eleven "pauses" in audio with
    no speech in it -- 33% of the first pass.

    WHISPER ALONE under-counts, and does so precisely on the axis of interest. Its
    word spans are attention-derived and it STRETCHES a word across the silence
    that follows it: in this file "he" is given 0.76 s and "So" swallows a 0.47 s
    gap whole. Every genuine mid-clause hesitation therefore looks like it begins
    inside a word. A pass that rejected those as stop closures reported 0.0%
    mid-clause pauses -- a confident zero on the one measurement this metric exists
    to make.

    So: silence runs come from the RMS envelope, and each is attributed to the last
    word that ended before it. Runs sharing that word are ONE pause however the
    envelope fragmented them, which is what collapses the cut-out stretches to a
    single turn gap each. Placement is therefore accurate to about one word -- more
    than enough to decide punctuated vs not, which is a property of the region and
    not of the exact boundary, and not enough to claim anything finer.
    """
    runs = [(a, b) for a, b in silence_runs(y) if b - a >= 0.04]
    ends = np.array([w["e"] for w in words])
    starts = np.array([w["s"] for w in words])
    groups = {}
    for r0, r1 in runs:
        prev = np.where(ends <= r0 + TOL)[0]
        if not prev.size:
            continue                      # before the first word: framing, not a pause
        i = int(prev[-1])
        g = groups.setdefault(i, dict(sil=0.0, last=r1))
        g["sil"] += r1 - r0
        g["last"] = max(g["last"], r1)
    out = []
    for i, g in sorted(groups.items()):
        if g["sil"] < PAUSE_MIN:
            continue
        nxt = np.where(starts >= g["last"] - TOL)[0]
        if not nxt.size:
            continue                      # after the last word: framing, not a pause
        span = float(starts[int(nxt[0])] - ends[i])
        out.append(dict(i=i, t=float(ends[i]), d=g["sil"], span=max(span, g["sil"]),
                        punct=bool(re.search(r"[.,!?;:\u2026-]$", words[i]["w"])),
                        turn=max(span, g["sil"]) >= TURN_GAP))
    return out


# -------------------------------------------------------------------------- pitch

def f0_track(y):
    f0, voiced, _ = librosa.pyin(y, fmin=F0_MIN, fmax=F0_MAX, sr=SR,
                                 frame_length=2048, hop_length=HOP)
    t = np.arange(len(f0)) * HOP / SR
    ok = voiced & np.isfinite(f0)
    return t, f0, ok


def formant_cloud(y):
    """Per-frame (F1, F2) over voiced frames -- the scatter, not its centre.

    analyse_voices.formants() medians the 40 loudest frames because it wants ONE
    number per voice. Undershoot lives in the spread, so here every voiced frame is
    a point and nothing is collapsed.
    """
    yp = librosa.effects.preemphasis(y)
    order = int(2 + SR / 1000)
    n_fft = 1024
    frames = librosa.util.frame(yp, frame_length=n_fft, hop_length=HOP)
    rms = np.sqrt((frames ** 2).mean(axis=0))
    live = rms > np.percentile(rms, 55)          # drop silence and weak frames
    win = np.hamming(n_fft)
    pts = []
    for i in np.where(live)[0]:
        try:
            a = librosa.lpc(frames[:, i] * win, order=order)
        except Exception:
            continue
        roots = [r for r in np.roots(a) if np.imag(r) > 0.01]
        f = sorted(np.arctan2(np.imag(r), np.real(r)) * SR / (2 * np.pi) for r in roots)
        f = [x for x in f if 200 < x < 3600]
        if len(f) >= 2 and f[0] < 1100 and f[1] > f[0]:
            pts.append((f[0], f[1]))
    return np.array(pts) if pts else np.zeros((0, 2))


def bark(hz):
    return 26.81 * hz / (1960.0 + hz) - 0.53


def vowel_area(pts):
    """Area of the 2-SD ellipse of the F1/F2 cloud, in Bark^2.

    The ellipse rather than the convex hull: a hull is decided by its handful of most
    extreme points, which on LPC formants are the estimation failures. Bark rather
    than Hz because equal Hz distances are not equal perceptual distances, and F2
    would otherwise dominate the area by an order of magnitude.
    """
    if len(pts) < 20:
        return 0.0
    b = np.column_stack([bark(pts[:, 0]), bark(pts[:, 1])])
    med = np.median(b, axis=0)
    d = np.linalg.norm(b - med, axis=1)
    b = b[d < np.percentile(d, 95)]              # trim LPC outliers, keep the shape
    cov = np.cov(b.T)
    return float(np.pi * 2.0 * 2.0 * np.sqrt(max(np.linalg.det(cov), 0.0)))


# ------------------------------------------------------------------------- measure

def measure(path, verbose=False):
    y, _ = librosa.load(path, sr=SR)
    y = librosa.util.normalize(y)
    dur = len(y) / SR
    words = transcribe(path)

    allp = word_pauses(y, words)
    turns = [p for p in allp if p["turn"]]
    pauses = [p for p in allp if not p["turn"]]
    pd = np.array([p["d"] for p in pauses]) if pauses else np.zeros(0)

    # Phonation is transcribed word spans only -- room tone is not phonation. The
    # speech span is built up from articulation + hesitation rather than by
    # subtracting turn gaps from the file length, so an overlapping or duplicated
    # turn gap cannot push it negative and silently invert every rate below it.
    phon = sum(w["e"] - w["s"] for w in words)
    speech_span = phon + float(pd.sum())

    syl = sum(syllables(w["w"]) for w in words)
    mid = [p for p in pauses if not p["punct"]]

    # Mid-clause and punctuated pauses are different behaviours and must not be
    # pooled. Bella's ten pauses on the 46s reference are 0.13-0.52s mid-clause
    # against 0.14-1.39s at punctuation; the pooled median of 0.71 is her sentence
    # boundaries, which bf_emma already produces on its own. Reading the pooled
    # figure as a hesitation target asks the delivery layer for a 0.71s mid-clause
    # gap -- longer than the longest she ever takes -- and the user heard it
    # immediately: "her pauses are very short, completely swallowed, almost non".
    mid_d = np.array([p["d"] for p in mid], dtype=float)
    punct_d = np.array([p["d"] for p in pauses if p["punct"]], dtype=float)

    # phrases: word runs split at every pause, turn gap included
    cut = {p["i"] for p in allp}
    phrases, cur = [], []
    for n, w in enumerate(words):
        cur.append(w)
        if n in cut:
            phrases.append(cur)
            cur = []
    if cur:
        phrases.append(cur)
    phrases = [p for p in phrases if len(p) >= 3]

    t, f0, ok = f0_track(y)
    db = 20.0 * np.log10(librosa.feature.rms(y=y, hop_length=HOP)[0] + 1e-9)
    tdb = np.arange(len(db)) * HOP / SR

    lengthen, slopes, decays = [], [], []
    for p in phrases:
        durs = [(w["e"] - w["s"]) / max(syllables(w["w"]), 1) for w in p]
        durs = [d for d in durs if d > 0]
        if len(durs) >= 3 and np.mean(durs[:-1]) > 0:
            lengthen.append(durs[-1] / np.mean(durs[:-1]))
        end = p[-1]["e"]
        m = ok & (t > end - FINAL_WIN) & (t <= end)
        if m.sum() >= 5:
            st = 12.0 * np.log2(f0[m] / 100.0)
            slopes.append(float(np.polyfit(t[m], st, 1)[0]))
        m2 = (tdb > end - DECAY_WIN) & (tdb <= end)
        if m2.sum() >= 5:
            decays.append(float(np.polyfit(tdb[m2], db[m2], 1)[0]))

    # Union, not sum: Whisper's stretched word spans let two adjacent turn gaps
    # describe the same silence, and summing them would over-report the exclusion.
    iv, turn_secs = sorted([(p["t"], p["t"] + p["span"]) for p in turns]), 0.0
    hi = -1.0
    for a, b in iv:
        turn_secs += max(0.0, b - max(a, hi))
        hi = max(hi, b)

    pts = formant_cloud(y)

    r = dict(
        dur=dur, words=len(words), syl=syl, phrases=len(phrases),
        artic_rate=syl / phon if phon > 0 else 0.0,
        speech_rate=syl / speech_span if speech_span > 0 else 0.0,
        pause_ratio=100.0 * float(pd.sum()) / speech_span if speech_span > 0 else 0.0,
        pause_med=float(np.median(pd)) if pd.size else 0.0,
        pause_p90=float(np.percentile(pd, 90)) if pd.size else 0.0,
        pause_per_100syl=100.0 * len(pauses) / syl if syl else 0.0,
        pause_med_mid=float(np.median(mid_d)) if mid_d.size else 0.0,
        pause_med_punct=float(np.median(punct_d)) if punct_d.size else 0.0,
        mid_clause_frac=100.0 * len(mid) / len(pauses) if pauses else 0.0,
        final_lengthen=float(np.median(lengthen)) if lengthen else 0.0,
        final_slope=float(np.median(slopes)) if slopes else 0.0,
        decay_slope=float(np.median(decays)) if decays else 0.0,
        vowel_area=vowel_area(pts),
        n_pause=len(pauses), n_turn=len(turns),
    )
    if verbose:
        print(f"  {os.path.basename(path)}: {dur:.1f}s  {len(words)}w {syl}syl "
              f"{len(phrases)}phr  {len(pauses)} pauses, {len(turns)} turn gaps "
              f"({turn_secs:.1f}s excluded)")
        for p in pauses:
            print(f"    pause {p['d']:5.2f}s at {p['t']:6.2f}  "
                  f"{'punctuated' if p['punct'] else 'mid-clause'}")
    return r


HDR = [("artic", "artic_rate", "{:6.2f}"), ("speech", "speech_rate", "{:6.2f}"),
       ("pause%", "pause_ratio", "{:6.1f}"), ("p.med", "pause_med", "{:5.2f}"),
       ("p.p90", "pause_p90", "{:5.2f}"), ("p/100s", "pause_per_100syl", "{:6.1f}"),
       ("p.mid", "pause_med_mid", "{:5.2f}"),
       ("p.pun", "pause_med_punct", "{:5.2f}"),
       ("mid%", "mid_clause_frac", "{:5.0f}"), ("lengthen", "final_lengthen", "{:8.2f}"),
       ("st/s", "final_slope", "{:6.1f}"), ("dB/s", "decay_slope", "{:6.0f}"),
       ("vowel", "vowel_area", "{:6.2f}")]


def table(rows):
    print(f"{'file':34s} " + " ".join(f"{h:>{len(f.format(0))}}" for h, _, f in HDR))
    print("-" * 118)
    for name, r in rows:
        print(f"{name:34s} " + " ".join(f.format(r[k]) for _, k, f in HDR))


def render_emma(text, path, speed=1.10):
    """The shipping voice on her words: bf_emma, lang_code 'b', speed 1.10.

    Same voice, same speed and same British frontend the assistant actually uses --
    a paired comparison on matched text, which is the only kind this metric supports.
    The half-vs-half floor below shows why: on 23 s of unmatched content her own
    pause statistics disagree with themselves by more than any plausible effect.
    """
    import soundfile as sf
    from kokoro import KPipeline
    pipe = KPipeline(lang_code="b")
    audio = np.concatenate([r.audio.numpy() for r in pipe(text, voice="bf_emma", speed=speed)])
    sf.write(path, audio, SR)
    return path


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ref = os.path.join(SAMPLES, "bella_raw_reference_s02e02.wav")
    if "--floor" in sys.argv:
        import soundfile as sf
        y, _ = librosa.load(ref, sr=SR)
        os.makedirs(CACHE, exist_ok=True)
        rows = []
        for i, (a, b) in enumerate([(0, 23.0), (23.0, 46.0)]):
            p = os.path.join(CACHE, f"bella_half{i + 1}.wav")
            sf.write(p, y[int(a * SR):int(b * SR)], SR)
            rows.append((f"bella half {i + 1} ({a:.0f}-{b:.0f}s)", measure(p)))
        table(rows)
        return rows
    if "--vs-emma" in sys.argv:
        os.makedirs(CACHE, exist_ok=True)
        text = " ".join(w["w"] for w in transcribe(ref))
        out = os.path.join(CACHE, "emma_same_text.wav")
        if not os.path.exists(out):
            render_emma(text, out)
        rows = [("bella (reference)", measure(ref)), ("bf_emma, same words", measure(out))]
        table(rows)
        print()
        print(f"{'axis':18s} {'bella':>9s} {'emma':>9s} {'gap':>9s}")
        print("-" * 50)
        for _, k, _ in HDR:
            b, e = rows[0][1][k], rows[1][1][k]
            print(f"{k:18s} {b:9.2f} {e:9.2f} {e - b:+9.2f}")
        return rows
    if "--speed-sweep" in sys.argv:
        os.makedirs(CACHE, exist_ok=True)
        text = " ".join(w["w"] for w in transcribe(ref))
        rows = [("bella (reference)", measure(ref))]
        for sp in (0.85, 0.90, 0.95, 1.00, 1.10):
            out = os.path.join(CACHE, f"emma_sp{int(sp * 100)}.wav")
            if not os.path.exists(out):
                render_emma(text, out, speed=sp)
            rows.append((f"bf_emma speed {sp:.2f}", measure(out)))
        table(rows)
        return rows
    files = args or [ref]
    rows = [(os.path.basename(f)[:34], measure(f, verbose=True)) for f in files]
    print()
    table(rows)
    return rows


if __name__ == "__main__":
    main()
