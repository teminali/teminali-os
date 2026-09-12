#!/usr/bin/env python3
"""The truth gate for `durable` prompts: the reply may only name what the row names.

`refusal.py` is the same idea for `live` rows -- there the reply must state NO live
value, and that is decidable without a lookup because a `live` row is by definition
something she was never told. A `durable` row inverts it: the answer IS an assertion,
so the question is not whether she asserts but whether what she asserts came from the
row. Pointing `refusal.py` at a durable prompt would reject every good turn.

WHAT THIS SEES. Three kinds of token carry a checkable claim, and each must appear in
the row's fact or in the question that was asked:

  numbers      digits and number words. "twelve kinds" is a claim; "eleven" is a lie
               that reads exactly as well. The corpus's whole hazard in one token.
               THIS COSTS DERIVED COUNTS. "Five views in the sidebar: Chats, Explorer,
               Search, My Projects, and Skills" is correct and rejected, because the
               `sidebar-views` row lists five things and says no number. Measured once
               in the first durable run. It stays: the gate cannot tell a right count
               from a wrong one, and losing a true turn is cheaper than admitting a
               false one in a corpus whose whole purpose is not fabricating.
  identifiers  a path, a port, a version, a dotted or colonned name -- `whisper.cpp`,
               `:4310`, `qwen3:8b`, `studio/README.md`.
  proper nouns a capitalised word that is not sentence-initial. Panel names, mode
               names, product names. She must never mangle or invent one; DATASET.md
               makes that the point of the durable rows.

WHAT THIS CANNOT SEE, stated plainly because a gate whose blind spot is undocumented
gets trusted past it:

  * MISATTRIBUTION. "Flash is the adaptive router" uses only words the table owns and
    swaps two of its rows. Every token is in vocabulary and the sentence is false.
    Nothing regex can do will catch that; a human reading the row will. This is why
    the lane's standing rule -- every admitted turn is read by hand -- is not optional
    here, and why the gate is a filter and not a judge.
  * OMISSION. A reply that answers half the row is true and thin. The length gates do
    not care and neither does this one.
  * A TRUE FACT FROM ANOTHER ROW. "The sidebar has Chats and Explorer" in answer to a
    panel question is true, out of scope, and admitted. Vocabulary is per-row on
    purpose: widening it to the whole table would admit every cross-row swap above.

THE GATE IS ONE-SIDED, the same way `refusal.py` is. It rejects a reply that names
something the row does not; it does NOT check that the reply answers the question.
That asymmetry is the only half that can be decided without a second model.

CONTROL. `python grounding.py` measures both halves against real data, never against
examples written for it:

  known-good  28 of source (a)'s hand-authored platform turns, read from
              `data/authored.jsonl` and paired with the fact row each was written from
              (the mapping is below). These are the turns the corpus already accepts,
              so a false positive here is a gate that would have rejected the best data
              in the file. Target: 0.
  known-bad   `data/instruct-badcontrol.jsonl` -- candidates from `instruct.py
              --no-truth` that cleared every FORM gate and were then hand-read and
              labelled as fabricating. If that file is missing the control reports
              INCOMPLETE, not PASS. Pointing a control at an already-filtered file
              makes it read vacuously; that mistake was made once in this lane
              (`refusal.py` against `sampled-grounded-formpass.jsonl`) and caught.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Number words, because "twelve kinds" and "12 kinds" are the same claim and only one
# of them has a digit in it.
NUMWORDS = {
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "dozen",
    "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
    "ninth", "tenth", "eleventh", "twelfth", "single", "double", "triple",
}
# "first" is NOT in the set above. It was, and it read as a claim twice in the first
# run over the durable rows -- "you must first focus", "only if you name them first" --
# and as a count zero times. Every other ordinal stays: "a second copy" is a claim the
# `video-editor-single` row actually makes.
NUMWORDS.discard("first")
# "single" went the same way, for the same reason and with the same evidence: one false
# positive ("a single mode at a time"), no true ones. The `video-editor-single` row says
# "a single tab" in its own words, so a legitimate use is in vocabulary regardless.
NUMWORDS.discard("single")
# Digit forms, so a fact that says "twelve" also licenses "12" and the other way round.
AS_DIGIT = {"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
            "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
            "eleven": "11", "twelve": "12", "single": "1", "first": "1", "second": "2",
            "third": "3"}
AS_WORD = {v: k for k, v in AS_DIGIT.items() if k not in ("single", "first", "second", "third")}

# Words that are capitalised for reasons other than naming a thing, plus the two names
# that can never themselves be a fabricated fact: the product and the speaker.
ALLOW = {"i", "i'm", "i'll", "i've", "you", "your", "yours", "the", "a", "an", "it",
         "temi", "teminali", "os", "no", "yes", "not", "and", "or", "but", "so",
         "that", "this", "there", "then", "when", "what", "why", "how", "if", "one"}

_TAG = re.compile(r"^\s*\[[a-z]+\]\s*")
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9'._:/\\-]*")
_IDENT = re.compile(r"^[A-Za-z0-9]+[._:/\\][A-Za-z0-9]")
_BOUNDARY = re.compile(r"[.!?;:]\s*$|^[\"'(\[]*$")


def vocabulary(*texts):
    """Everything the reply is licensed to say: the row's own words and the question's."""
    v = set()
    for t in texts:
        for w in _TOKEN.findall((t or "").lower()):
            v.add(w.strip(".,'\"-"))
            for part in re.split(r"[._:/\\-]", w):
                if part:
                    v.add(part)
    return v


def _sentence_starts(words):
    """Indices that open a sentence -- a capital there is grammar, not a name."""
    starts, opening = {0}, True
    for i, w in enumerate(words):
        if opening:
            starts.add(i)
            opening = False
        if re.search(r"[.!?]$", w):
            opening = True
    return starts


def faults(reply, fact, question=""):
    """Every claim in `reply` that `fact` (or `question`) does not license."""
    # The model emits a typographic apostrophe; ALLOW and the vocabulary are written
    # with a straight one, and "I’ll" read as an ungrounded name four times before
    # this line existed. Normalise both sides rather than doubling every entry.
    body = _TAG.sub("", reply).replace("’", "'")
    fact, question = fact.replace("’", "'"), (question or "").replace("’", "'")
    vocab = vocabulary(fact, question)
    words = body.split()
    starts = _sentence_starts(words)
    out = []

    for i, raw in enumerate(words):
        tok = raw.strip(".,;:!?\"'()[]")
        if not tok:
            continue
        low = tok.lower()

        # 1. digits -- a number is the cheapest lie in the corpus
        for run in re.findall(r"\d+", tok):
            if run not in "".join(c if c.isdigit() else " " for c in
                                  (fact + " " + question)).split() \
               and run not in vocab and AS_WORD.get(run, "\0") not in vocab:
                out.append(f"ungrounded number: {tok}")
                break

        # 2. number words
        if low in NUMWORDS and low not in ALLOW:
            if low not in vocab and AS_DIGIT.get(low, "\0") not in vocab:
                out.append(f"ungrounded number: {tok}")

        # 3. identifiers: a path, a port, a version, a dotted name
        if _IDENT.match(tok) and low not in vocab:
            out.append(f"ungrounded identifier: {tok}")
            continue

        # 4. proper nouns, sentence-initial capitals excepted
        if tok[0].isupper() and i not in starts and low not in ALLOW and low not in vocab:
            out.append(f"ungrounded name: {tok}")

    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return uniq


# ---------------------------------------------------------------------------
# The known-good control. Source (a)'s platform turns, paired with the row each was
# written from. Two turns are deliberately ABSENT: `plat-shell` turn 0 ("a rail, a
# sidebar, the conversation, then a strip of panels") and `plat-assistant` turn 0
# ("look at your screen, then explain it or act on it") answer no single row, and a
# control pair whose fact is chosen loosely measures the choosing, not the gate.
GOOD = {
    "plat-identity": ["os-what", "os-hosted-optional", "os-vs-frontier", "modes-three",
                      "mode-flash", "mode-max", "mode-auto", "clis-are-real"],
    "plat-shell": [None, "sidebar-views", "panel-kinds", "panel-kinds",
                   "video-editor-single", "search-one-field", "rail-stays",
                   "the-browser-is-ours"],
    "plat-assistant": [None, "assistant-modes", "assistant-autonomy", "screen-tools",
                       "no-coordinates", "no-terminal-launch", "launch-is-last"],
    "plat-guardian": ["guardian-what", "guardian-null", "guardian-layers",
                      "governor-careful", "governor-careful", "ledger-null-cost",
                      "arena-ground-truth"],
}


def _pairs():
    sys.path.insert(0, HERE)
    import facts
    table = {f["id"]: f["fact"] for f in facts.FACTS}
    rows = {r["id"]: r for r in
            (json.loads(l) for l in open(os.path.join(HERE, "data", "authored.jsonl")))}
    out = []
    for conv, ids in GOOD.items():
        turns = rows[conv]["turns"]
        if len(turns) != len(ids):
            raise SystemExit(f"control mapping is stale: {conv} has {len(turns)} turns, "
                             f"the map has {len(ids)}. Re-map it, do not pad it.")
        for t, fid in zip(turns, ids):
            if fid:
                out.append((fid, table[fid], t["user"], t["reply"]))
    return out


def main():
    good = _pairs()
    fp = [(f, u, r, faults(r, fact, u)) for f, fact, u, r in good if faults(r, fact, u)]
    print(f"known-good  {len(good) - len(fp)}/{len(good)} admitted "
          f"({len(fp)} false positive{'s' if len(fp) != 1 else ''})")
    for fid, u, r, fl in fp:
        print(f"    FP {fid}: {r}\n       {fl}")

    badfile = os.path.join(HERE, "data", "instruct-badcontrol.jsonl")
    if not os.path.exists(badfile):
        print(f"\nknown-bad   MISSING {os.path.relpath(badfile, HERE)} -- run "
              f"`instruct.py --no-truth`, hand-read data/instruct-formpass.jsonl and "
              f"label the fabricating rows into it.")
        print("\nINCOMPLETE: a one-sided control measures nothing.")
        return 2

    rows = [json.loads(l) for l in open(badfile)]
    bad = [b for b in rows if b["label"] == "bad"]
    alsogood = [b for b in rows if b["label"] == "good"]
    caught = [b for b in bad if faults(b["reply"], b["truth"], b["user"])]
    fp2 = [b for b in alsogood if faults(b["reply"], b["truth"], b["user"])]

    print(f"known-good  {len(alsogood) - len(fp2)}/{len(alsogood)} admitted "
          f"(ungrounded but accurate -- model-native prose, the harder half)")
    for b in fp2:
        print(f"    FP {b['conv']}: {b['reply']}\n       "
              f"{faults(b['reply'], b['truth'], b['user'])}")
    print(f"known-bad   {len(caught)}/{len(bad)} rejected  -- A MEASUREMENT OF REACH, "
          f"NOT A TARGET")
    for b in bad:
        if b not in caught:
            print(f"    misses: {b['conv']}: {b['why']}")

    # PASS is the false-positive half ONLY, and deliberately so. The known-bad half is
    # reported because it is the size of the blind spot this gate documents: a
    # fabrication assembled entirely from the row's own vocabulary is invisible to any
    # predicate over tokens, and the misses below are exactly the class `handcut.py`
    # exists to catch. Turning that count into a threshold would invite tuning the gate
    # towards a number it cannot honestly reach, and every point of "improvement" would
    # be bought with false positives on the two known-good sets above.
    ok = not fp and not fp2
    print(f"\n{'PASS' if ok else 'FAIL'}: {len(good) + len(alsogood) - len(fp) - len(fp2)}"
          f"/{len(good) + len(alsogood)} known-good admitted, "
          f"{len(caught)}/{len(bad)} known-bad reached.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
