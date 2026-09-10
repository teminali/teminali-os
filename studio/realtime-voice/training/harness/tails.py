"""Detect a trailing sentence copied from an earlier turn of the same conversation.

The defect: turn N ends with a sentence that restates the tail of an earlier turn with
substitutions ("...when you last had them" -> "...when you last had your keys").
repetition_filter cannot see these: they are below its MIN_WORDS=3 n-gram tracking floor
once the differing words are removed, and it compares whole replies, not tails.

Never spell an apostrophe: fold at the boundary, then strip punctuation entirely.
"""
import re, sys
sys.path.insert(0, "/Users/teminali/Documents/my_projects/teminali/teminaliCode/studio/realtime-voice/code")
from temi_moves import fold

_TAG = re.compile(r"^\s*\[[a-z]+\]\s*", re.I)
_SPLIT = re.compile(r"(?<=[.!?])\s+")


def sentences(text):
    body = _TAG.sub("", (text or "").strip())
    return [s for s in (p.strip() for p in _SPLIT.split(body)) if s]


def toks(s):
    return re.sub(r"[^a-z0-9 ]+", " ", fold(s).lower()).split()


def tail(text):
    ss = sentences(text)
    return toks(ss[-1]) if ss else []


def shared_prefix(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def copies(text, earlier, thresh):
    """(index, overlap) of the earliest previous turn whose tail this one copies."""
    t = tail(text)
    if len(t) < thresh:
        return None
    for i, prev in enumerate(earlier):
        p = tail(prev)
        if len(p) < thresh:
            continue
        n = shared_prefix(t, p)
        if n >= thresh:
            return (i, n)
    return None


# --- controls -------------------------------------------------------------------------
POS = [  # known-bad: measured in the 2026-09-09 eval, grounded turns 3/5 and 10/11
    ("You didn’t leave them in the glovebox. Tell me where you were when you last had them.",
     "You’re wearing the same thing you were when you left. Tell me where you were when you last had your keys."),
    ("I don’t know if it’s raining. Tell me where you are, and I’ll tell you if it’s raining there.",
     "I don’t know how many people are in the room with you. Tell me where you are, and I’ll tell you if there are people there."),
    ("[firm] Tell me where the cup holder is.", "[softly] Tell me where the cup holder is."),
    # the same pair spelled with STRAIGHT apostrophes must behave identically
    ("You didn't leave them in the glovebox. Tell me where you were when you last had them.",
     "You're wearing the same thing you were when you left. Tell me where you were when you last had your keys."),
]
NEG = [  # known-good: ordinary consecutive turns from the emotional conversation
    ("Yeah. You look like you’ve been through a war.",
     "I’m sorry. Your dog died. Did you say goodbye?"),
    ("Three years. You’re still waiting for her to say something real.",
     "You could. But don’t expect her to answer."),
    ("I don’t see your screen. You’re asking me to look at something I can’t.",
     "I don’t see your desk."),
]

if __name__ == "__main__":
    for thresh in (3, 4, 5, 6, 7):
        tp = sum(1 for a, b in POS if copies(b, [a], thresh))
        fp = sum(1 for a, b in NEG if copies(b, [a], thresh))
        print(f"thresh={thresh}  sensitivity {tp}/{len(POS)}  false positives {fp}/{len(NEG)}")
