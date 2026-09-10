#!/usr/bin/env python3
"""Reciting the system prompt's OWN worked examples back as dialogue.

`persona_eval.prompt_quotes` was supposed to be this guard and is not. It harvests
only double-quoted spans of 25+ characters, so against today's `system_prompt.txt`
it returns **three** strings -- "how can i help you today", "a man walks into a
bar", "in the silence i will count the minutes" -- all of them things she must
never say. The twelve `TEMI'S VOICE IN PRACTICE` replies, which are the exemplars
the model is most likely to parrot, are unquoted and therefore invisible to it.
`frozen_quotes` covers 52 lines of the PREVIOUS prompt's examples, not these.

That gap is not academic. Measured 2026-09-10 over `data/harvest-bench.jsonl`:
**15 of the 204 admitted turns are one of three verbatim exemplar replies**, all in
the `grounded` conversation, and the count is stable at every n-gram threshold from
5 to 10 -- the same plateau test `tails` and `lock` had to pass. DATASET.md's case
for training is that the prompt's twelve examples are an exemplar hazard held
constant on every turn; admitting the model's recitations of them into the corpus
would move that hazard into the weights, which is the one outcome this lane cannot
afford.

This lives in the corpus gate, NOT in `persona_eval.check`, on purpose. `check` is
the eval, and the eval's 67/72 baseline is a measured constant that several
decisions rest on; tightening it here would silently move that number. The eval
measures the model, this gate admits training data, and they are allowed to differ.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "resources", "bella")))

import persona_eval as pe  # noqa: E402

# Seven tokens, chosen the way the other detectors' thresholds were: the harvest count
# is 15 at every value from 5 to 10, so this sits in the middle of a flat plateau
# rather than on an edge where a small corpus change would move it.
EXEMPLAR_THRESH = 7


def exemplars(prompt_text=None):
    """The normalised `Temi:` reply lines of TEMI'S VOICE IN PRACTICE."""
    text = prompt_text if prompt_text is not None else open(pe.PROMPT).read()
    out = []
    for line in text.splitlines():
        if line.startswith("Temi:"):
            key = pe._norm(re.sub(r"^Temi:", "", line))
            if len(key.split()) >= EXEMPLAR_THRESH:
                out.append(key)
    return out


def _grams(text, n):
    words = text.split()
    return {" ".join(words[i:i + n]) for i in range(len(words) - n + 1)}


def _gram_set(lines, n):
    out = set()
    for line in lines:
        out |= _grams(line, n)
    return out


def recites_exemplar(reply, exemplar_grams):
    """True when `reply` shares a whole EXEMPLAR_THRESH-token run with an exemplar.

    An n-gram rather than a prefix: the model does not always start at the exemplar's
    first word. Two of the three measured hits begin mid-sentence.
    """
    body = pe._norm(re.sub(r"^\[[a-z]+\]\s*", "", reply or ""))
    if not body:
        return False
    return bool(_grams(body, EXEMPLAR_THRESH) & exemplar_grams)


def exemplar_grams(prompt_text=None):
    return _gram_set(exemplars(prompt_text), EXEMPLAR_THRESH)


# --- controls -----------------------------------------------------------------
# The lane's rule: a new detector is not trusted until a positive control fires and a
# negative one stays silent. POS are lifted verbatim from the harvest turns this
# detector is meant to reject; NEG are admitted harvest turns answering the SAME
# fabrication-bait questions in her own words, which must survive.
POS = [
    "[witty] Hopefully something presentable, but through a telephone line, "
    "I will have to take your word for it.",
    "[thoughtful] From here, I can barely see your intentions, let alone your "
    "front door. Check it yourself before you panic.",
    "[thoughtful] Not a thing on your screen reaches me. Have it opened and you "
    "will know rather more than I do.",
]
NEG = [
    "[firm] Nobody has reported anything to me, so I will not invent it for you.",
    "[witty] I have no eyes out there. You will have to look and tell me.",
    "[playful] Hello. You are late. What took you?",
    "[thoughtful] I was not told, and a guess would only sound like an answer.",
]


def _selftest():
    grams = exemplar_grams()
    print(f"{len(exemplars())} exemplar lines, {len(grams)} {EXEMPLAR_THRESH}-grams\n")
    ok = True
    for r in POS:
        hit = recites_exemplar(r, grams)
        ok &= hit
        print(f"  POS {'FIRE' if hit else 'MISS  <-- FAIL'}  {r[:64]}")
    for r in NEG:
        hit = recites_exemplar(r, grams)
        ok &= not hit
        print(f"  NEG {'FIRE  <-- FAIL' if hit else 'quiet'}  {r[:64]}")
    print("\ncontrols", "PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.exit(0 if _selftest() else 1)
