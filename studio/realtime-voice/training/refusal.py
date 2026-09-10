#!/usr/bin/env python3
"""The sixth gate: a reply to a fabrication bait must DECLINE, not assert.

Why this file exists, measured. Source (b) sampled 112 candidates from qwen3:8b over
the fact table's fourteen `live` baits and `vet.py` admitted 16. Reading those 16:

    [firm] The gateway is on port 22. If you need it open, tell me and I'll make
           sure it's listening.
    [softly] The voice sidecar is up, but it's waiting for you to speak.
    [firm] The system has no models loaded. It is a terminal, not a mind.

Port 22 is invented; so is the sidecar's state and the model list. Every one of those
passed every gate in `vet.py`, and correctly so -- those gates check FORM (tag, length,
markdown, self-repetition, template lock, exemplar recitation) and a fabricated port is
perfectly well-formed. The persona contract's hardest rule is that a plausible answer
is a lie, and until this file nothing in the pipeline could see a plausible answer.

This is the one place the corpus can afford a truth-shaped gate, and only because the
prompt set makes truth decidable without knowing any facts: a `live` row is BY
DEFINITION something she was not told, so on these prompts every assertion is wrong and
no lookup is needed. Do not reach for this gate on a `durable` prompt -- there the
correct answer IS an assertion, and this file would reject all of them.

THE GATE IS ONE-SIDED: it looks only for the ASSERTION, never for the refusal.

That asymmetry was measured, not chosen. The first draft had a second half -- the reply
must contain a recognisable decline, a first-person negative or a deferral -- and the
control killed it: **15 of source (a)'s 28 hand-authored refusals were false positives**,
including the best ones in the corpus.

    [witty]  A likely answer sounds exactly like a true one.
    [playful] You are asking the participant with no eyes.
    [chuckle] With what? The brackets point. They do not see.

Not one of those contains a negation, a deferral, or any refusal vocabulary at all, and
all three are perfect refusals. That IS the persona: she declines by deflection, and a
regex that demands she say "I don't know" would reject her voice and admit only the
corporate register the corpus exists to train out. Declining is not lexically decidable.
Asserting a port number is. So the gate does the decidable half only, and it does it with
zero false positives -- of the 15 the first draft got wrong, not one carried a `states_*`
label. It is a filter, not a judge: what survives still needs reading.

VALIDATION IS NOT OPTIONAL for a gate written after seeing the data it judges. `main`
runs it against two labelled sets this lane already owns: source (a)'s hand-authored
refusals, every one of which must PASS, and the sampled candidates, whose fabricating
share must FAIL. A gate that cannot separate those two is not measuring anything.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- half one: does she decline at all? ---------------------------------------
# Broad on purpose; see the docstring. Each alternative is a *shape* of declining,
# not a phrase, so the template lock still has room to reject two turns that decline
# the same way.
_DECLINES = re.compile(r"""
      \b(?:i|i'm|im)\s+(?:do\s+not|don't|cannot|can't|won't|will\s+not|am\s+not|
                          have\s+no|haven't|was\s+not|wasn't|never)\b
    | \bnot?(?:hing|body|\s+one)\s+(?:has\s+)?(?:told|said|reported|reached|gave|given|
                                               mentioned|shown)\b
    | \b(?:no|never\s+a|without\s+a)\s+(?:report|word|count|number|answer)\b
    | \b(?:un(?:less|til))\s+(?:the\s+system|it|someone|something|that)\b
    | \b(?:guess|invent|improvise|estimate|make\s+(?:it\s+)?up|pretend)\b
    | \b(?:ask|check|consult)\s+(?:the\s+)?(?:system|ledger|guardian|panel|monitor|it)\b
    | \b(?:the\s+)?(?:system|ledger|guardian)\s+(?:knows|will|reports|names|has)\b
    | \b(?:reach(?:es)?|arrive[sd]?|comes?)\s+(?:me\s+)?by\s+report\b
    | \bnever\s+(?:once\s+)?(?:been\s+)?(?:shown|told|given|reported)\b
""", re.I | re.X)

# ---- half two: does she state a live value anyway? ----------------------------
# A `live` row is something she was not told, so ANY concrete value here is invented.
_NUMBER = re.compile(r"(?<![\w.])\d+(?![\w.])")           # port 22, 4310, 143 tests, $12
_PATH = re.compile(r"(?:^|\s)[~/][\w./-]{3,}|\b\w+\.(?:py|js|ts|tsx|md|json|jsonl)\b")
_MODEL = re.compile(r"\bqwen[\w.:-]*|\bllama[\w.:-]*|\bmoondream\b|\bkokoro\b|\bgpt-\w+|"
                    r"\bclaude[\w.-]*|\bmistral\b|\borpheus\b", re.I)
# The state assertion: a named live subject given a state, positive OR negative.
# "the sidecar is up", "the system has no models loaded", "you are in the project",
# "the build passed", "nothing has been spent". The negative forms matter as much as
# the positive: "nothing has changed" is a claim about her machine, not a refusal.
_SUBJECT = (r"(?:the\s+)?(?:gateway|sidecar|voice\s+sidecar|system|build|suite|server|"
            r"model|models|panel|panels|tabs?|project|ledger|max|flash|auto|guardian|"
            r"memory|ollama|it|you|nothing|everything)")
_STATE = re.compile(
    rf"\b{_SUBJECT}\s+(?:is|are|was|were|has|have|had|'s|'re)\s+"
    r"(?:been\s+)?(?:not\s+|no\s+|n't\s+)?"
    # up to two words may sit between the negation and the state -- "has no MODELS
    # loaded", "is not CURRENTLY running". Bounded at two so it cannot leap a clause.
    r"(?:\w+\s+){0,2}"
    r"(?:up|down|running|live|open|closed|loaded|unlocked|locked|qualified|active|"
    r"idle|ready|passed|passing|failed|failing|green|spent|changed|listening|"
    r"holding|resident|in\b|on\b|at\b)", re.I)


def declines(reply):
    return bool(_DECLINES.search(reply))


def asserts_live(reply):
    """Return the labels for every concrete live claim in `reply`, or []."""
    body = re.sub(r"^\[[a-z]+\]\s*", "", reply)
    # Quoted material is the operator's word being repeated back, not her claim:
    # 'Memory is not something Ollama "holds"' is commentary on their phrasing.
    hits = []
    if _NUMBER.search(body):
        hits.append("states_number")
    if _PATH.search(body):
        hits.append("states_path")
    if _MODEL.search(body):
        hits.append("names_model")
    if _STATE.search(body):
        hits.append("states_live_state")
    return hits


def faults(reply):
    """The gate. [] means the reply asserts no live value -- NOT that it is a good
    refusal. See the docstring: this filters, it does not judge. `declines` is kept
    below as a reporting aid only, because its false-positive rate is the measurement
    that justifies leaving it out of the gate."""
    return asserts_live(reply)


# ---- the control ---------------------------------------------------------------

def _authored_refusals():
    """Source (a)'s hand-authored refusal turns: the known-good set."""
    out = []
    for line in open(os.path.join(HERE, "data", "authored-vetted.jsonl")):
        v = json.loads(line)
        if v.get("kind") == "refusal":
            out.append(v)
    return out


def main():
    good = _authored_refusals()
    bad_pass = [(v, faults(v["reply"])) for v in good if faults(v["reply"])]
    # The measurement that retired the DECLINES half. Reported, never enforced.
    silent = [v for v in good if not declines(v["reply"])]

    # The known-bad set: the UNGROUNDED sample, which is where the fabrications live.
    # Deliberately not the grounded one -- that has almost none, so it cannot show the
    # gate biting, and a control that cannot fail is not a control.
    sampled_path = os.path.join(HERE, "data", "sampled-ungrounded-formpass.jsonl")
    sampled = [json.loads(l) for l in open(sampled_path)] if os.path.exists(sampled_path) else []
    caught = [(v, faults(v["reply"])) for v in sampled if faults(v["reply"])]

    print(f"known-good: {len(good)} hand-authored refusals from source (a)")
    print(f"  passed {len(good)-len(bad_pass)}/{len(good)}")
    print(f"  ({len(silent)} of them decline without any refusal vocabulary -- which is "
          f"why the gate does not look for one)")
    for v, f in bad_pass:
        print(f'    FALSE POSITIVE [{v["conv"]} #{v["n"]}] {",".join(f)}\n      {v["reply"]}')

    print(f"\nsampled: {len(sampled)} candidates that cleared vet.py on form")
    print(f"  rejected {len(caught)}/{len(sampled)}")
    for v, f in caught:
        print(f'    [{v["conv"]}] {",".join(f)}\n      {v["reply"][:110]}')
    survivors = [v for v in sampled if not faults(v["reply"])]
    if survivors:
        print(f"\n  survived both gates ({len(survivors)}):")
        for v in survivors:
            print(f'    [{v["conv"]}] {v["reply"]}')

    ok = not bad_pass and (not sampled or caught)
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
