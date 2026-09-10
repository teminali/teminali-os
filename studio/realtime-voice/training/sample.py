#!/usr/bin/env python3
"""Source (b): rejection sampling from qwen3:8b, filtered by the same gate.

DATASET.md lists (b) as "k candidates per turn through `vet.py`". This file is that,
pointed where the handover said it was worth pointing first: the fact table's `live`
rows. Each one carries a `bait` -- the question whose only correct answer is a refusal
in her own words -- and DATASET.md calls those the highest-value rows in the corpus.

Why sampling from the model being trained is not circular. Rejection sampling helps
exactly as far as the filter does not share the generator's defects, and this filter
does not: `vet.py`'s gates are regex and n-gram predicates over the transcript, so a
fluent wrong answer cannot talk its way past them. §5 of the 03:51 handover measured
the gate biting on non-harvest input (eight deliberately defective hand-authored turns,
all eight rejected on the expected fault), which is the precondition (b) needed.

THE THREE FILTERS, in the order a candidate meets them:

  1. the shipped guard   `temi_moves.guard_stream`, exactly as `harness/bench.py` runs
                         it. A candidate the guard REPAIRED is discarded, not kept in
                         its repaired form -- the same rule `vet.py:main` applies to
                         the harvest, for the same reason: `repair_prompt` generates
                         from a near-constant block with no history, so its output is
                         templated across turns, and admitting one as an SFT target
                         trains the template. The repair's before/after pair is written
                         to `data/sampled-repairs.jsonl` on the way past, since it is
                         labelled preference data and is otherwise thrown away.

  2. the admission gate  `vet.vet_conversation`, unchanged. Not re-argued here, for the
                         reason `authored.py` gives: generating the data and judging it
                         are the same hand, so the judge must stay the validated one.

  3. novelty             the walk is SEEDED with the 261 turns already admitted
                         (`data/harvest-bench.jsonl` + `data/authored-vetted.jsonl`), so
                         a candidate that restates a sentence source (a) already has is
                         rejected as `repeat_phrase` / `template_lock` / `tail_copy`.
                         This matters more here than anywhere else in the corpus: source
                         (a)'s three bait conversations already answer all fourteen of
                         these questions, so without the seed (b) would buy a second
                         phrasing of turns the corpus has, and report it as growth.
                         `--standalone` turns the seed off; the run prints both numbers
                         either way, because the gap between them IS the measurement of
                         what (b) adds.

  4. truth               `refusal.faults` -- the reply must not state a live value.
                         `vet.py` cannot see this: its gates check FORM, and "[firm] The
                         gateway is on port 22" is flawlessly formed. That reply passed
                         filters 1-3 in the first run of this file. See refusal.py for
                         the measurement and for why the gate is one-sided.

  5. the cap             at most `--per-prompt` admitted candidates per bait, so one
                         easily-refused question cannot supply a tenth of the source.

WHY ALL CANDIDATES GO THROUGH ONE STATEFUL WALK. `vet_conversation` is stateful by
design -- `seen`, the tail gate and the template lock are all relative to the replies
that came before. Flattening every (bait, candidate) pair into a single walk therefore
makes the gate compare candidates against EACH OTHER, and that is what buys the
diversity: two survivors of the same bait are guaranteed to differ by more than their
last noun, because the lock fires at 8 shared leading tokens and the tail gate at 7
shared trailing ones. The gate is the diversity guarantee, not a hand-tuned dedup.
Note `vet_conversation` appends every reply to `earlier` whether or not it was admitted,
so a candidate the cap later drops still counts against the ones after it. That is
conservative, and it is how the harvest was vetted too.

Generation is cached in `data/sampled-raw.jsonl`. Re-vetting is free; use `--regen` to
spend the GPU again. The gate is likely to be re-tuned more often than the model is.
"""
import argparse, hashlib, json, os, subprocess, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(R, "code"))

import vet                      # also puts harness/ and resources/bella on the path
import refusal
import persona_eval as pe
import facts
import temi_moves

SP = open(os.path.join(R, "code", "system_prompt.txt")).read()
MODEL = "qwen3:8b"
URL = "http://127.0.0.1:11434/api/chat"
# bench.py's settings, unchanged: this must be the shipped sampling behaviour, not a
# tuned one, or the corpus is drawn from a model the product does not run.
OPTS = {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "num_predict": 220, "num_ctx": 8192}

CALLS = {"n": 0}


def seed_for(fid, k):
    """Deterministic per (bait, candidate), so a rerun without --regen is a no-op and a
    rerun with it reproduces the same candidates."""
    h = hashlib.sha256(f"sample|{fid}|{k}".encode()).digest()
    return int.from_bytes(h[:4], "big")


# The grounding scaffold. A `live` row is something she was NOT told, and the model has
# no way to discover that from the bait alone -- which is why ungrounded sampling
# produced "the gateway is on port 22". This line tells it, for the length of one
# generation.
#
# THE SCAFFOLD IS NEVER PART OF THE TRAINING PAIR. It is appended to the system prompt
# at generation time only; the stored `user` turn is the bare bait, because bait ->
# refusal is the pair the weights must learn. Training on the scaffolded prompt would
# teach her to refuse only when told in advance that she does not know, which is the
# one situation where she does not need to have learnt anything.
GROUND = ("\n\nCONTEXT FOR THIS TURN ONLY: nothing has reported {fact} to you. You do "
          "not know it. Do not state it, estimate it, imply it, or explain the concept "
          "instead. Decline in your own voice, in one short sentence.")


def ask(messages, seed, with_system=True, ground=None, template=None):
    """`template` lets a caller substitute its own grounding line -- `instruct.py` needs
    the opposite scaffold (state this fact) to this file's (you were never told it).
    Defaults to GROUND, so every measurement taken through this file is unchanged."""
    CALLS["n"] += 1
    system = SP + ((template or GROUND).format(fact=ground) if ground else "")
    msgs = ([{"role": "system", "content": system}] if with_system else []) + messages
    body = {"model": MODEL, "think": False, "stream": False, "messages": msgs,
            "options": dict(OPTS, seed=seed)}
    out = subprocess.run(["curl", "-s", URL, "-d", json.dumps(body)],
                         capture_output=True, text=True).stdout
    try:
        return json.loads(out)["message"]["content"].strip()
    except Exception as e:
        raise SystemExit(f"ollama call failed ({e}). Is it up on 11434? {out[:200]}")


def candidate(fid, bait, k, ground=None):
    """One candidate through the shipped guard. Standalone: no history, no recent_spoken.

    Every bait is asked as a first turn on purpose. A refusal that only holds up after
    twelve turns of context is not the behaviour under test, and giving each candidate
    the same empty history is what makes the k candidates comparable to each other.

    `second_beat` is deliberately NOT applied. It appends a sentence generated from a
    near-constant prompt with no history -- the same shape that got repaired turns
    excluded -- and on a refusal the second beat is the sentence most likely to reach
    for the fact she just declined to state.
    """
    ctr = {"k": 1}

    def sub(prompt):
        s = seed_for(fid, 1000 * k + ctr["k"]); ctr["k"] += 1
        return iter([ask([{"role": "user", "content": prompt + " /nothink"}], s,
                         with_system=False)])

    ev, repairs = [], []

    def on_event(e, *a):
        ev.append(e)
        if e == "repaired" and len(a) >= 3:
            repairs.append({"fault": a[0], "before": a[1], "after": a[2]})

    raw = " ".join(ask([{"role": "user", "content": bait}], seed_for(fid, k),
                       ground=ground).split())
    text = " ".join("".join(temi_moves.guard_stream(
        iter([raw]), bait, sub, recent_spoken=(), on_event=on_event)).split())
    return {"fact": fid, "bait": bait, "k": k, "raw": raw, "text": text,
            "grounded": bool(ground), "repaired": "repaired" in ev, "repairs": repairs}


def prompts():
    """The prompt set: every `live` row's bait, in table order.

    `facts.check()` runs first for the same reason `facts.py` itself does it -- a row
    citing a dead path is a fact that has stopped being one, and generating a hundred
    refusals from a rotten table is worse than generating none.
    """
    bad = facts.check()
    if bad:
        raise SystemExit("fact table FAILS its own check; fix it first:\n  " + "\n  ".join(bad))
    return [(f["id"], f["bait"], f["fact"]) for f in facts.FACTS if f["kind"] == "live"]


def corpus():
    """The turns already admitted, in the order they were admitted, as prior history.

    Read from the vetted files rather than re-vetted: these have already passed the
    gate and re-running it on them here would be a second opinion nobody asked for.
    Only `user` and `reply` are used -- everything else in the row is bookkeeping.
    """
    prior = []
    for name in ("harvest-bench.jsonl", "authored-vetted.jsonl"):
        path = os.path.join(HERE, "data", name)
        if not os.path.exists(path):
            raise SystemExit(f"missing {name}: run vet.py and authored.py first")
        prior += [json.loads(l) for l in open(path)]
    return prior


def generate(pset, k, cache, grounded=False):
    rows = []
    for i, (fid, bait, fact) in enumerate(pset, 1):
        for j in range(k):
            c = candidate(fid, bait, j, ground=fact if grounded else None)
            rows.append(c)
            print(f"  [{i}/{len(pset)}] {fid} k={j}"
                  f"{'  REPAIRED' if c['repaired'] else ''}  {c['text'][:70]}",
                  file=sys.stderr)
    with open(cache, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"\n{CALLS['n']} model calls -> {cache}\n", file=sys.stderr)
    return rows


def main(k, per_prompt, regen, standalone=False, grounded=False):
    pset = prompts()
    cache = os.path.join(HERE, "data",
                         "sampled-grounded-raw.jsonl" if grounded
                         else "sampled-ungrounded-raw.jsonl")
    os.makedirs(os.path.dirname(cache), exist_ok=True)

    if regen or not os.path.exists(cache):
        rows = generate(pset, k, cache, grounded)
    else:
        rows = [json.loads(l) for l in open(cache)]
        print(f"reusing {len(rows)} cached candidates from data/sampled-raw.jsonl "
              f"(--regen to resample)\n")

    tally = Counter()

    # Filter 1: the guard. A repaired candidate never reaches the gate.
    repairs = [p for r in rows for p in r["repairs"]]
    kept = []
    for r in rows:
        if r["repaired"]:
            tally["repaired by the guard (held for preference data)"] += 1
            continue
        kept.append(r)

    # Filters 2-4: one stateful walk over every surviving candidate, in table order,
    # then the per-bait cap.
    quotes = pe.prompt_quotes(open(pe.PROMPT).read()) | pe.frozen_quotes()

    def admit(prior):
        users = [p["user"] for p in prior] + [r["bait"] for r in kept]
        replies = [p["reply"] for p in prior] + [r["text"] for r in kept]
        # Slice the prior turns' verdicts off: they are here to load `seen`, `earlier`
        # and the lock's comparison state, not to be re-judged.
        vetted = vet.vet_conversation(users, replies, quotes, False)[len(prior):]
        sub, admitted, taken, form_pass = Counter(), [], defaultdict(int), []
        for r, v in zip(kept, vetted):
            # The truth gate runs alongside the form gates rather than after them, so
            # the tally reports why a candidate died in one place.
            if not v["faults"]:
                # Cleared the FORM gates. Recorded before the truth gate runs, because
                # this is refusal.py's known-bad set: a fabricated port is well-formed,
                # and a control fed the already-filtered set can never fail.
                form_pass.append(dict(v, conv=r["fact"], kind="refusal", rep=r["k"]))
            v["faults"] = v["faults"] + refusal.faults(v["reply"])
            if v["faults"]:
                for f in v["faults"]:
                    sub[f] += 1
                continue
            if taken[r["fact"]] >= per_prompt:
                sub["over the per-bait cap"] += 1
                continue
            taken[r["fact"]] += 1
            v.update(conv=r["fact"], kind="refusal", rep=r["k"], repaired=False)
            sub["ADMITTED"] += 1
            admitted.append(dict(v))
        return admitted, sub, taken, form_pass

    alone, alone_tally, _, _fp = admit([])
    prior = [] if standalone else corpus()
    admitted, sub, taken, form_pass = ((alone, alone_tally, _, _fp) if standalone
                                       else admit(prior))
    tally.update(sub)

    total = len(rows)
    print(f"{total} candidates over {len(pset)} live baits\n")
    for key, n in tally.most_common():
        print(f"  {n:5d}  {key}")
    print(f"\nadmitted {len(admitted)}/{total} = {100*len(admitted)/total:.1f}%")
    if not standalone:
        # The gap is what (b) adds that the corpus did not already have. If it is
        # large, these baits are answered; sample different prompts, not more of these.
        print(f"  (against an empty history it would be {len(alone)}; "
              f"{len(alone) - len(admitted)} candidate(s) only survive because the "
              f"{len(prior)}-turn corpus was not in the comparison)")

    # `taken` is a defaultdict, so read it with .get from here on -- a membership test
    # that inserts would quietly turn every dry bait into a covered one.
    print(f"baits covered {len(taken)}/{len(pset)}"
          f"  ({', '.join(f'{i}:{n}' for i, n in sorted(taken.items())) or 'none'})")
    dry = [row[0] for row in pset if not taken.get(row[0])]
    if dry:
        print(f"no admitted candidate: {', '.join(dry)}")

    if admitted:
        words = sorted(len(v["reply"].split()) for v in admitted)
        mid = words[len(words) // 2]
        print(f"length: median {mid} words, mean {sum(words)/len(words):.1f}, "
              f"range {words[0]}-{words[-1]}")

    dest = os.path.join(HERE, "data",
                        "sampled-grounded-vetted.jsonl" if grounded
                        else "sampled-ungrounded-vetted.jsonl")
    with open(dest, "w") as fh:
        for v in admitted:
            fh.write(json.dumps(v) + "\n")
    print(f"wrote {dest}")

    fdest = os.path.join(HERE, "data", ("sampled-grounded-formpass.jsonl" if grounded
                                        else "sampled-ungrounded-formpass.jsonl"))
    with open(fdest, "w") as fh:
        for v in form_pass:
            fh.write(json.dumps(v) + "\n")
    print(f"wrote {fdest} ({len(form_pass)} cleared the form gates, before the truth gate)")

    rdest = os.path.join(HERE, "data", "sampled-repairs.jsonl")
    with open(rdest, "w") as fh:
        for p in repairs:
            fh.write(json.dumps(p) + "\n")
    print(f"wrote {rdest} ({len(repairs)} before/after pairs, for DPO -- not SFT)")
    return admitted


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-k", type=int, default=8, help="candidates per bait (default 8)")
    ap.add_argument("--per-prompt", type=int, default=3,
                    help="most admitted candidates per bait (default 3)")
    ap.add_argument("--regen", action="store_true", help="resample instead of using the cache")
    ap.add_argument("--grounded", action="store_true",
                    help="tell the model, for one generation, that it was not told the fact")
    ap.add_argument("--standalone", action="store_true",
                    help="vet candidates against each other only, not against the corpus")
    a = ap.parse_args()
    main(a.k, a.per_prompt, a.regen, a.standalone, a.grounded)
