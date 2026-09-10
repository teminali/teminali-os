#!/usr/bin/env python3
"""The admission gate for training data.

Nothing enters the corpus without passing every gate here. The gates are not new
judgement -- each one is a detector this lane already validated against known-bad
samples, reused rather than re-argued:

  persona   `persona_eval.check`  -- tag, length, markdown, corporate, italian,
                                     fabricated perception, self-repetition, and
                                     verbatim recitation of the system prompt.
  tail      `harness/tails.copies` -- this reply ends on the ending of an earlier one.
  recite    `harness/recite.recites` -- this reply OPENS on the opening of an earlier
                                     one. The template lock, per-turn.
  exemplar  `exemplar.recites_exemplar` -- this reply is one of the system prompt's own
                                     TEMI'S VOICE IN PRACTICE lines handed back as
                                     dialogue. `persona_eval.prompt_quotes` cannot see
                                     these -- it reads only double-quoted spans -- so
                                     15 of the first harvest's 204 admitted turns were
                                     three verbatim exemplars. See exemplar.py.
  locked    conversation-level      -- `bench.jsonl` marks 6 of 24 baseline
                                     conversations locked. Every turn of a locked
                                     conversation is discarded, passing or not:
                                     the defect is the conversation's shape, and
                                     training on it teaches that shape.

Why the gate is independent of the generator: rejection sampling only helps if the
filter does not share the model's defects. These detectors are regex and n-gram
predicates over the transcript, so they cannot be talked round by a fluent reply.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "harness"))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "resources", "bella")))

import persona_eval as pe
import tails, recite, lock
import exemplar

TAIL_THRESH = 7   # tails.py's validated threshold; count stable at 6/7/8
LOCK_THRESH = 7   # lock.py's validated threshold; count stable at 5..10

# The gate's tag vocabulary, which is deliberately WIDER than the eval's.
#
# `system_prompt.txt` (line 25) offers nine delivery tags and the TTS engine honours
# all nine -- `warm` has an entry in `audio_module.py`'s emotion table. Only
# `persona_eval.TAGS` lists eight, so `pe.check` returns `bad_tag` for a reply the
# product considers perfectly valid. Widening `pe.TAGS` would fix that everywhere,
# and would also silently move the 67/72 eval baseline that several decisions in this
# lane rest on -- so it stays at eight, and the gate carries the ninth instead.
#
# Same separation the exemplar gate established, in the other direction: `check` is
# the eval and measures the model; this file is the gate and admits training data.
# A tag the shipped product emits and speaks must not be unadmittable as training
# data, or source (a) can never teach Temi her full delivery range.
GATE_TAGS = pe.TAGS | {"warm"}


def _tag_of(reply):
    m = re.match(r"^\[([a-z]+)\]\s*", reply)
    return m.group(1) if m else None


def vet_conversation(user_turns, replies, quotes, conv_locked, ex_grams=None):
    """Walk one conversation in order and label every turn.

    The walk must be in order and stateful: `seen` and the earlier-reply list are
    what the repetition and copy gates are relative to. Scoring a turn out of
    context is the bug that made an earlier probe read 0% while the defect ran at
    92%.
    """
    if ex_grams is None:
        ex_grams = exemplar.exemplar_grams()
    seen, earlier, out = set(), [], []
    for i, reply in enumerate(replies):
        user = user_turns[i] if i < len(user_turns) else ""
        faults = list(pe.check(reply, seen, len(earlier), quotes, user))
        if "bad_tag" in faults and _tag_of(reply) in GATE_TAGS:
            faults.remove("bad_tag")   # see GATE_TAGS: valid for the product, not for the eval
        if tails.copies(reply, earlier, TAIL_THRESH):
            faults.append("tail_copy")
        if recite.recites(reply, earlier):
            faults.append("template_lock")
        if exemplar.recites_exemplar(reply, ex_grams):
            faults.append("recites_exemplar")
        if conv_locked:
            faults.append("in_locked_conversation")
        out.append({"n": i + 1, "user": user, "reply": reply, "faults": faults})
        earlier.append(reply)
    return out


def main(path):
    system = open(pe.PROMPT).read()
    quotes = pe.prompt_quotes(system) | pe.frozen_quotes()

    rows = [json.loads(l) for l in open(path)]
    from collections import Counter
    tally, admitted, total = Counter(), [], 0

    for r in rows:
        if r["arm"] != "base":          # only today's shipped behaviour is a candidate
            continue
        user_turns = pe.CONVERSATIONS[r["conv"]]
        replies = [t["text"] for t in r["turns"]]
        repaired = [t["repaired"] for t in r["turns"]]
        for v, was_repaired in zip(
            vet_conversation(user_turns, replies, quotes, r.get("locked")), repaired
        ):
            total += 1
            v["repaired"] = was_repaired
            v["conv"], v["rep"] = r["conv"], r["rep"]
            if was_repaired:
                # A repaired turn is a labelled bad->good pair, not an exemplar.
                # `repair_prompt` generates from a near-constant block with no
                # history, so its output is templated across turns -- and a repair
                # firing is what predicts the lock (Fisher p=0.0127). Admitting one
                # as an SFT target trains the template that causes the defect.
                tally["repaired (held for preference data)"] += 1
                continue
            if v["faults"]:
                for f in v["faults"]:
                    tally[f] += 1
                continue
            tally["ADMITTED"] += 1
            admitted.append(v)

    print(f"{total} base-arm turns from {os.path.basename(path)}\n")
    for k, n in tally.most_common():
        print(f"  {n:5d}  {k}")
    print(f"\nadmitted {len(admitted)}/{total} = {100*len(admitted)/total:.1f}%")
    return admitted


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "harness", "bench.jsonl")
    out = main(src)
    dest = os.path.join(HERE, "data", "harvest-bench.jsonl")
    with open(dest, "w") as fh:
        for v in out:
            fh.write(json.dumps(v) + "\n")
    print(f"wrote {dest}")
