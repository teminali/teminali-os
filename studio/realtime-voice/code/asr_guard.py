"""Drop Whisper's silence hallucinations without going deaf to real short replies.

THE FAILURE. Observed 2026-09-09: the operator said nothing, and a user turn reading
"Thank you." appeared in the transcript; Bella dutifully answered "You're welcome."
"Thank you." is one of Whisper's canonical outputs on near-silence, alongside
"Thanks for watching!" and a bare "you" -- artifacts of its training data, emitted
when the decoder is handed audio with no speech in it.

WHY NOT JUST BLOCK THE PHRASE. Because "thank you" is also a perfectly ordinary thing
to say to a voice assistant, and a filter that swallows it makes her deaf at exactly
the moment she should be gracious. Text alone cannot separate the two cases.

WHY NOT WHISPER'S OWN THRESHOLDS. faster-whisper has `no_speech_threshold` and
`log_prob_threshold` for precisely this, and they are the right place to fix it. But
RealtimeSTT calls `model.transcribe()` with a fixed argument list
(audio_recorder.py:199 and :209) that passes neither, and exposes no way to set them.
Reaching them means patching a vendored dependency, so the guard lives here instead.

THE RULE. Suppress only when BOTH hold:
  1. the transcript is nothing but a known silence artifact, and
  2. the audio that produced it carries no real speech energy.
Either alone is not enough. This deliberately errs toward letting a hallucination
through rather than ever discarding something the operator actually said.

ON THE THRESHOLD. `SILENCE_PEAK_DBFS` is NOT a measured value -- there was no labelled
recording of the silence that produced the observed "Thank you." to fit it against. It
is set where only near-digital-silence can fall below it, so it fires rarely and never
on a normal microphone. Every finalisation logs its measured peak and RMS through
`describe()`, so the real distribution can be read out of the logs and the threshold
replaced with a fitted one. Do not raise it on intuition; read the logs first.
"""

import os
import re

import numpy as np

# Tuned to drop ambient room noise and low-energy mic bleed on Whisper artifacts.
SILENCE_PEAK_DBFS = float(os.getenv("ASR_SILENCE_PEAK_DBFS", "-32.0"))
SILENCE_RMS_DBFS = float(os.getenv("ASR_SILENCE_RMS_DBFS", "-42.0"))

# Whisper's stock utterances on speechless or low-energy ambient audio.
SILENCE_ARTIFACTS = frozenset({
    "thank you", "thanks", "thank you very much", "thanks for watching",
    "thank you for watching", "thanks for watching!", "please subscribe",
    "subscribe to my channel", "you", "bye", "bye bye", "okay", "ok", "so",
    "oh", "um", "uh", "mm", "hmm", "yeah", "the", "i", "a", "and",
    "silence", "music", "applause", "blank_audio", "sorry", "i'm sorry",
    "im sorry", "dude", "what", "hello", "hey", "i'm moving now", "you know",
})

_STRIP = re.compile(r"[^a-z0-9 ]+")


def _dbfs(x):
    return -np.inf if x <= 0 else 20.0 * np.log10(x)


def describe(audio, sample_rate=16000):
    """Measured speech evidence for one recording. Cheap; safe on None or empty."""
    if audio is None:
        return {"peak_dbfs": None, "rms_dbfs": None, "dur_s": 0.0, "known": False}
    a = np.asarray(audio, dtype=np.float32).ravel()
    if a.size == 0:
        return {"peak_dbfs": None, "rms_dbfs": None, "dur_s": 0.0, "known": False}
    # int16 buffers arrive from some capture paths; normalise before measuring.
    if np.max(np.abs(a)) > 1.5:
        a = a / 32768.0
    return {
        "peak_dbfs": float(_dbfs(float(np.max(np.abs(a))))),
        "rms_dbfs": float(_dbfs(float(np.sqrt(np.mean(np.square(a)))))),
        "dur_s": float(a.size) / float(sample_rate or 16000),
        "known": True,
    }


def normalise(text):
    """Lowercase, drop punctuation, collapse whitespace. '...Thank you!' -> 'thank you'."""
    return _STRIP.sub(" ", (text or "").lower()).strip()


def is_silence_artifact(text):
    """True when the WHOLE transcript is one of Whisper's speechless-audio stock phrases."""
    return normalise(text) in SILENCE_ARTIFACTS


def is_hallucination(text, evidence):
    """(suppress, reason). Requires both a stock phrase AND audio with no speech in it."""
    if not is_silence_artifact(text):
        return False, ""
    if not evidence or not evidence.get("known"):
        # No audio to corroborate with. Let it through: a real "thank you" matters more
        # than a phantom one, and without the audio the two are indistinguishable.
        return False, "artifact phrase but no audio to corroborate"
    peak, rms = evidence.get("peak_dbfs"), evidence.get("rms_dbfs")
    if peak is None or rms is None:
        return False, "artifact phrase but no level measured"
    if peak <= SILENCE_PEAK_DBFS or rms <= SILENCE_RMS_DBFS:
        return True, (f"silence artifact {normalise(text)!r} over low-energy audio "
                      f"(peak {peak:.1f} dBFS <= {SILENCE_PEAK_DBFS} or "
                      f"rms {rms:.1f} <= {SILENCE_RMS_DBFS})")
    return False, (f"artifact phrase but audio has speech energy "
                   f"(peak {peak:.1f} dBFS, rms {rms:.1f})")


# ---------------------------------------------------------------------------
# Echo: she hears herself through the speakers and answers it
# ---------------------------------------------------------------------------
# Observed 2026-09-09. An entire conversation ran with no operator in it:
#
#   she said   "...afraid of what you're about to say"
#   heard as   "What I'm about to say. What makes you think of something to say to you?"
#   she said   "You're waiting for me to ask."
#   heard as   "I'm waiting for you to ask, then ask."
#
# The returning audio is LOUD -- peaks of -4 to -10 dBFS -- so the silence guard above
# cannot touch it and never should: that is real speech energy, just not the operator's.
# Chromium's `echoCancellation: true` is already set (static/app.js:90) and is not
# coping, which is what happens on speakers rather than headphones.
#
# So match on the WORDS instead. Deliberately NOT half-duplex muting, which would kill
# barge-in -- interrupting her is the point of the app.
#
# ASR mangles echo (pronouns flip, clauses merge), so exact matching is useless. The
# test is content-word overlap, which survives "You're waiting for me to ask" coming
# back as "I'm waiting for you to ask, then ask."

import time as _time
from collections import deque

ECHO_WINDOW_S = float(os.getenv("ASR_ECHO_WINDOW_S", "20.0"))
ECHO_OVERLAP = float(os.getenv("ASR_ECHO_OVERLAP", "0.60"))
# Below this many content words, leave it alone. Measured against the real loop: the
# echo "I'm waiting for you to ask, then ask." carries just two content words
# {waiting, ask} and matched her line at 100%, so a floor of 4 missed it entirely.
# Two is the lowest safe floor -- at one, any single word she happened to use would
# start eating real answers.
ECHO_MIN_WORDS = int(os.getenv("ASR_ECHO_MIN_WORDS", "2"))

# WHAT THIS DOES NOT CATCH, measured on the same conversation. When the ASR mangles the
# echo badly enough it invents content words she never said: "...afraid of what you're
# about to say" came back as "What I'm about to say. What makes you think of something
# to say to you?", which overlaps her line by only 40% because {makes, think, something}
# are the transcriber's. Lowering the threshold to reach it would start swallowing real
# speech, so it is deliberately left to escape.
#
# AND THE COST OF WHAT IT DOES CATCH: an operator who answers by repeating her words
# ("Should I book the flight?" -> "yes book the flight") scores 100% overlap and will be
# dropped. That is a real false positive and it is the accepted trade -- losing the odd
# short confirmation beats an entire conversation with no operator in it. Set
# ASR_ECHO_OVERLAP=1.1 to disable the check outright.
#
# Neither limitation exists on headphones. This is a mitigation for a missing acoustic
# echo canceller, not a substitute for one.

# Pronouns and auxiliaries are exactly what the echo mangles and what every English
# sentence shares; comparing on them would both miss real echoes and flag real speech.
_STOPWORDS = frozenset("""
a an the and or but if then so as at by for in of on to with from is am are was were
be been being do does did have has had i you he she it we they me him her us them my
your his its our their this that these those what which who whom whose not no yes
""".split())

_spoken = deque(maxlen=12)


def _content_words(text):
    return {w for w in normalise(text).split() if w not in _STOPWORDS and len(w) > 1}


def note_spoken(text):
    """Record a line the assistant is about to speak, so it can be recognised coming back."""
    words = _content_words(text)
    if words:
        _spoken.append((_time.monotonic(), words))


def reset_spoken():
    """Forget spoken history -- call when a conversation is cleared."""
    _spoken.clear()


def is_echo(text, now=None):
    """(suppress, reason). True when the transcript is the assistant's own recent words."""
    heard = _content_words(text)
    if len(heard) < ECHO_MIN_WORDS:
        return False, ""
    now = _time.monotonic() if now is None else now
    best, best_frac = None, 0.0
    for spoken_at, said in _spoken:
        if now - spoken_at > ECHO_WINDOW_S or not said:
            continue
        # Fraction of what was HEARD that she had just said. Asymmetric on purpose:
        # the transcript is usually a fragment of a longer utterance of hers, so
        # dividing by her line instead would dilute a genuine match.
        frac = len(heard & said) / len(heard)
        if frac > best_frac:
            best, best_frac = said, frac
    if best_frac >= ECHO_OVERLAP:
        return True, (f"echo of her own speech: {best_frac:.0%} of heard content words "
                      f"were just spoken ({sorted(heard & best)[:6]})")
    return False, ""
