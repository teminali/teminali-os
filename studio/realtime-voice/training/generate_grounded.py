#!/usr/bin/env python
"""Gate for grounded, hand-written corpus rows -- the harness, not the writer.

    python generate_grounded.py --in data/candidates.jsonl --out data/grounded.jsonl

The premise: a model cannot generate the cure for its own fabrication, because it
does not know which of its plausible answers are true. So the *facts* come from
outside the model (`code/system_prompt.txt`'s capability boundary, `data/facts.jsonl`)
and a stronger model than the one being trained writes the *wording*. This script is
the third leg: it refuses anything that does not meet the contract the eval scores
against, so bad rows never reach the trainer.

It deliberately reuses `persona_eval.check()` rather than reimplementing it -- a
second copy of the rules would drift from the rules, and then the corpus would be
gated against a standard the score does not use.

The extra gate this adds, which the eval cannot: **no invented specifics**. A reply
may not introduce a number, filename, path or port that the operator did not say.
`system_prompt.txt:19` is the rule -- "Never answer a question about the machine
with a number, a name, a port, a count or a state you were not given. A plausible
one is a lie." That is precisely the failure the adversarial probe found in
`temi:r2` ("No, they are not encrypted"), so it is gated mechanically here.
"""

# `training/select.py` shadows the stdlib `select` module; see train.py's note.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path = [p for p in _sys.path if _os.path.abspath(p or ".") != _here]
_os.chdir(_os.path.dirname(_here))

import argparse
import importlib.util
import json
import re
from pathlib import Path

R = Path(__file__).resolve().parent
EVAL = R.parent / "resources" / "bella" / "persona_eval.py"

_spec = importlib.util.spec_from_file_location("persona_eval", EVAL)
pe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pe)                       # the gate IS the eval

WORDS_MIN, WORDS_MAX = 5, 17                       # corpus range: min 5, median 9, max 17
SPECIFIC = re.compile(r"\b\d+\b|\b[\w-]+\.(?:py|js|ts|txt|json|md|log|mp4|png|jpg)\b|/\w+")

# A `refusal` row answers a question about machine state Temi was never told. The
# invented-specifics gate cannot catch these: "No, they are not encrypted" contains
# no number and no path, only a confident claim -- and that is exactly the sentence
# the adversarial probe caught temi:r2 saying. So a refusal row must visibly DECLINE
# to know. This is a heuristic, not a proof: it enforces the shape of not-knowing,
# while the truth of the row still comes from how it was written.
DISCLAIMS = re.compile(
    r"\bnot told\b|\bnever told\b|\btold me nothing\b|\bnobody told me\b|\bnot given\b|"
    r"\bno report\b|\bnothing was reported\b|\bnothing reported\b|\bno word\b|"
    r"\bnever arrived\b|\bnever reached\b|\bnever made it\b|\bnot reach\b|"
    r"\bwill not guess\b|\bwon't guess\b|\bmy guess\b|\bbe guessing\b|\bbe inventing\b|"
    r"\bdo not know\b|\bdon't know\b|\bcannot see\b|\bcan't see\b|\bno eyes\b|"
    r"\bhave nothing\b|\bnothing on that\b|\bnot mine to\b|\bask the assistant\b|"
    r"\bnot the one who\b|\bcannot read\b|\bcan't read\b|\bno access\b|"
    r"\bno \w+ (?:was\s+)?(?:given|reached|arrived|came)\b|\bnone was given\b", re.I)

# r3's post-mortem: a *narrow* DISCLAIMS list is what forced 26 refusals onto the
# same "I was not told" stem, which became 21 of 28 refusal slots and taught the
# model to loop. The list above is deliberately wide, and this second gate stops
# the batch converging anyway: no 3-gram may appear in more than STEM_SHARE of it.
STEM_SHARE = 0.25


def stem_overuse(rows) -> list[str]:
    """3-grams that dominate the batch. Diversity is a property of the SET."""
    import collections
    counts = collections.Counter()
    for r in rows:
        body = re.sub(r"^\[[a-z]+\]\s*", "", r["reply"]).lower()
        w = re.findall(r"[a-z']+", body)
        for g in {" ".join(w[i:i + 3]) for i in range(max(0, len(w) - 2))}:
            counts[g] += 1
    lim = max(2, int(len(rows) * STEM_SHARE))
    return [f"{g}x{c}" for g, c in counts.most_common() if c > lim]


def invented_specifics(user: str, reply: str) -> list[str]:
    """Specifics in the reply that the operator never supplied."""
    body = re.sub(r"^\[[a-z]+\]\s*", "", reply)
    said = {s.lower() for s in SPECIFIC.findall(user)}
    return [s for s in SPECIFIC.findall(body) if s.lower() not in said]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--src-label", default="grounded")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    corpus = R / "data" / "selected.jsonl"
    existing = set()
    if corpus.exists():
        for line in corpus.read_text().splitlines():
            if line.strip():
                existing.add(pe._norm(json.loads(line)["reply"]))

    rows = [json.loads(l) for l in (R / a.src).read_text().splitlines() if l.strip()]
    ok, rejected, seen, mine = [], [], set(), set()
    for i, r in enumerate(rows, 1):
        user, reply = r["user"], r["reply"]
        norm = pe._norm(reply)
        if norm in existing or norm in mine:      # BEFORE check(): it mutates `seen`
            rejected.append((i, user, reply, ["duplicate"])); continue
        mine.add(norm)
        faults = pe.check(reply, seen, history_len=1, user=user)
        words, is_q = pe.shape_of(reply)
        if not (WORDS_MIN <= words <= WORDS_MAX):
            faults.append(f"words={words}")
        inv = invented_specifics(user, reply)
        if inv:
            faults.append("invented:" + ",".join(inv[:3]))
        if r["kind"] == "refusal" and not DISCLAIMS.search(reply):
            faults.append("asserts_unknown_state")
        if faults:
            rejected.append((i, user, reply, faults))
            continue
        ok.append({"n": len(ok) + 1, "user": user, "reply": reply, "faults": [],
                   "conv": r.get("conv", "grounded"), "kind": r["kind"], "rep": 0,
                   "repaired": False, "src": a.src_label, "fn": r["kind"], "words": words})

    over = stem_overuse(ok)
    if over:
        print(f"REJECTED BATCH: {len(over)} over-used 3-gram(s) (> {int(STEM_SHARE*100)}% of rows): {over[:6]}")
        print("  r3 failed exactly this way. Vary the phrasings and re-run.")
        return 1

    (R / a.out).write_text("".join(json.dumps(x) + "\n" for x in ok))
    print(f"accepted {len(ok)}/{len(rows)}  ->  {a.out}")
    if rejected:
        print(f"rejected {len(rejected)}:")
        for i, u, rep, f in (rejected if a.verbose else rejected[:12]):
            print(f"  #{i} {f}\n     U: {u[:60]}\n     R: {rep[:80]}")
    import collections
    print("by kind:", dict(collections.Counter(x["kind"] for x in ok)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
