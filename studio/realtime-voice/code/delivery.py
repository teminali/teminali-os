"""Give Bella's delivery its hesitation back: mid-clause pauses Kokoro will not add.

Measured against 46 s of her real speech (resources/bella/timing_metric.py, run
--vs-emma), bf_emma reading her exact words differs from her on two timing axes:

                        bella   bf_emma
    articulation rate    5.15      6.26   syllables/sec of phonation
    pauses/100 syllables  7.8       5.4
    mid-clause pauses      30%        0%

The last row is the structural one. Kokoro pauses where the text has punctuation and
nowhere else, so a synthesised line can only ever hesitate where a writer put a comma.
A person hesitates where they are choosing the next word. That is most of what the
user meant by "bella orignal voice has that lazy feeling".

Rate is a knob (see BELLA_SPEED in audio_module) and needs no code. Pause placement is
not a knob, so this module inserts the pauses into the text before it reaches the TTS.

WHY ELLIPSIS AND NOT COMMA. Both were rendered through the shipping path and measured.
An inserted comma changes NOTHING -- pauses/100 syllables stays at 5.4 and mid-clause
stays at 0.0%, byte-identical behaviour to the untouched line. An inserted "..." moves
them to 7.0 and 22%. Kokoro's G2P gives a comma inside a clause no prosodic break at
all, so the obvious implementation is the one that does not work.

WHERE SHE ACTUALLY PAUSES. All three of her measured mid-clause pauses land after a
function word and before the content word it introduces:

    "...to take Ico's place. And he [0.41s] has asked me..."
    "...no friction between [0.52s] his organisation and yours."
    "...on a more [0.13s] personal note..."

That is hesitation before lexical selection, not random scattering, so FUNCTION_WORDS
gates the candidate positions rather than a uniform random choice over tokens.
"""

import hashlib
import random
import re

# Rate targets, measured -- see the table above. Punctuation alone already yields
# 5.4 pauses per 100 syllables, so the deficit this module makes up is the difference.
TARGET_PER_100_SYL = 7.8
PUNCT_PER_100_SYL = 5.4
INSERT_PER_100_SYL = TARGET_PER_100_SYL - PUNCT_PER_100_SYL

MIN_GAP_WORDS = 6          # she never hesitates twice in one breath group
MIN_WORDS = 8              # below this a hesitation reads as a stutter, not thought

FUNCTION_WORDS = {
    "and", "but", "or", "so", "then", "because", "that", "which", "who",
    "a", "an", "the", "my", "your", "his", "her", "its", "their", "our",
    "in", "on", "at", "to", "for", "with", "from", "of", "between", "about",
    "is", "was", "are", "were", "has", "have", "had", "will", "would",
    "can", "could", "should", "more", "very", "quite", "just", "really",
}

VOWELS = "aeiouy"


def _syllables(word):
    """Cheap syllable estimate -- vowel groups, silent final e removed.

    Deliberately not misaki here: this runs on every assistant reply in the hot
    path, and the count only has to be good enough to decide HOW MANY pauses a
    sentence earns. timing_metric.py uses the real G2P where accuracy is the point.
    """
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    n = len(re.findall(r"[%s]+" % VOWELS, w))
    if w.endswith("e") and n > 1 and not w.endswith(("le", "ee", "ye")):
        n -= 1
    return max(n, 1)


def _ends_clause(word):
    return bool(re.search(r"[.,!?;:…]$", word))


def lazify(text, strength=1.0):
    """Insert mid-clause hesitations at Bella's measured rate.

    Deterministic in the text: the same reply always hesitates in the same places,
    so a line can be regression-tested and the assistant does not stutter differently
    each time it repeats itself. strength scales the rate (0 disables).
    """
    words = text.split()
    if len(words) < MIN_WORDS or strength <= 0:
        return text

    syl = sum(_syllables(w) for w in words)
    n_want = int(round(syl / 100.0 * INSERT_PER_100_SYL * strength))
    if n_want < 1:
        return text

    # Candidates: a function word, mid-clause, with a content word after it, and not
    # at the very start or end of the line -- a hesitation there reads as a fault.
    cand = []
    for i, w in enumerate(words[:-1]):
        if i < 2 or i > len(words) - 3:
            continue
        if _ends_clause(w):
            continue
        if re.sub(r"[^a-z']", "", w.lower()) in FUNCTION_WORDS:
            cand.append(i)
    if not cand:
        return text

    # Stable pseudo-random pick: hash the text so the choice is fixed per line but
    # not always the same position in every line.
    #
    # A seeded shuffle rather than a strided walk over the candidates. A stride of
    # (seed + k*7) % len(cand) silently visits only len/gcd(7, len) distinct
    # positions -- with 14 candidates it offers the same two forever -- and the
    # rate quietly falls short on exactly the long replies that need the pauses most.
    seed = int(hashlib.sha1(text.encode("utf-8")).hexdigest()[:8], 16)
    order = list(cand)
    random.Random(seed).shuffle(order)

    # The gap must hold against EVERY chosen position, not just the most recent one:
    # the candidates arrive shuffled, so "the last one chosen" is not the nearest one.
    chosen = []
    for i in order:
        if all(abs(i - c) >= MIN_GAP_WORDS for c in chosen):
            chosen.append(i)
        if len(chosen) >= n_want:
            break

    for i in sorted(chosen, reverse=True):
        words[i] = words[i] + "..."
    return " ".join(words)
