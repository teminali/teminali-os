"""Detect TEMPLATE LOCK: a conversation reciting one opening sentence turn after turn.

Why a second detector. `tails.copies` -- the validated tail-copy detector -- fires on a
copied *trailing* sentence, and measures 2-6% of turns. That base rate is too low for a
200-turn A/B to separate a fix from noise. But the tail copy is the rare, narrow tip of a
commoner defect visible in the same transcripts: after a repair writes a rigid admission
sentence into history, the 8B model recites that sentence's OPENING for the rest of the
conversation, substituting only the noun. `copies` misses it because it compares tails,
and these turns differ in their tails while sharing ten leading tokens.

Same rule as the tail detector: never spell an apostrophe, fold at the boundary.
"""
import re, sys, json
sys.path.insert(0, "/Users/teminali/Documents/my_projects/teminali/teminaliCode/studio/realtime-voice/code")
from tails import sentences, toks, shared_prefix   # noqa: E402  (same folding rules)
from temi_moves import fold                        # noqa: E402

_TERM = re.compile(r"[.!?]")

# `fold` settles apostrophe STYLE (curly vs straight); it does not settle contraction.
# The model writes both "You are not in the room" and "You're not in the room" for the
# same recited opening, and `toks` strips the apostrophe to a space, so the two differ from
# the second token on and the lock goes uncounted. Expanded here, before folding, and only
# for the contractions with ONE expansion -- `'s` (is / possessive) and `'d` (would / had)
# are ambiguous and are deliberately left alone rather than guessed at.
_EXPAND = [(r"\bcan['\u2019]t\b", "can not"), (r"\bwon['\u2019]t\b", "will not"),
           (r"\bshan['\u2019]t\b", "shall not"), (r"n['\u2019]t\b", " not"),
           (r"['\u2019]re\b", " are"), (r"['\u2019]ve\b", " have"),
           (r"['\u2019]ll\b", " will"), (r"['\u2019]m\b", " am")]


def expand(text):
    t = text or ""
    for pat, rep in _EXPAND:
        t = re.sub(pat, rep, t, flags=re.I)
    return t


def head(text, truncated=False):
    """Tokens of the first sentence, or None when truncation makes it unknowable."""
    ss = sentences(text)
    if not ss:
        return None
    if truncated and not _TERM.search(text or ""):
        return None          # the whole visible text is one unfinished sentence
    return toks(expand(ss[0]))


def locks(turns, thresh):
    """[(i, j, overlap)] -- turn i recites the opening of the earlier turn j."""
    heads, out = [], []
    for i, t in enumerate(turns):
        h = head(t.get("text", ""), t.get("truncated", False))
        heads.append(h)
        if not h or len(h) < thresh:
            continue
        for j in range(i):
            p = heads[j]
            if not p or len(p) < thresh:
                continue
            n = shared_prefix(h, p)
            if n >= thresh:
                out.append((i, j, n))
                break
    return out


if __name__ == "__main__":
    runs = json.load(open(sys.argv[1]))
    # Controls. Run 2 is grounded WITH an early repair (turn 3) and is the known-bad case;
    # run 0 is the same 13 user turns with repairs late (7, 9) and no lock; runs 1 and 3
    # are emotional conversations that must stay quiet at every threshold.
    label = {0: "grounded, repairs at 7,9  NEG", 1: "rambling, no repair     NEG",
             2: "grounded, repair at 3    POS", 3: "rambling, no repair     NEG"}
    for thresh in (5, 6, 7, 8, 10, 12):
        row = []
        for k, r in enumerate(runs):
            row.append(len(locks(r["turns"], thresh)))
        print(f"thresh={thresh:2d}  " + "  ".join(
            f"run{k} {label[k][:24]:24s} {n:2d}/{len(runs[k]['turns'])}"
            for k, n in enumerate(row)))
    print()
    for i, j, n in locks(runs[2]["turns"], 8):
        print(f"  POS run2: turn {runs[2]['turns'][i]['n']} recites turn "
              f"{runs[2]['turns'][j]['n']} ({n} tokens)")
        print(f"    {runs[2]['turns'][i]['text'][:96]}")
