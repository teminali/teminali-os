#!/usr/bin/env python3
"""Step 2 of the self-instruct route: durable platform knowledge, in her voice.

DATASET.md step 2 is "generate k question paraphrases per fact, answer in-voice with
qwen3:8b, put every candidate through `vet.py`". This file is that, over the fact
table's 35 `durable` rows. `sample.py` is the same machinery pointed at the 14 `live`
rows, where the correct answer is a refusal; here the correct answer is an assertion,
and that one difference changes three things.

WHAT CHANGES, AND WHY.

  1. GROUNDING IS FREE. A `live` row is by definition something she was not told, so
     `sample.py` had to spend a scaffold line telling the model it does not know. A
     `durable` row is a fact the docs own: it goes in the prompt, and the grounded case
     -- the one measured at 5x the usable yield -- is the only case there is. There is
     no ungrounded arm here and there should not be one.

  2. `refusal.py` IS NOT APPLIED, and applying it would reject every good turn. It
     fires on a reply that states a live value; on a durable prompt stating the value
     IS the answer. The handover says this in one line; it is repeated here because
     the gate is imported two files away and looks like completeness.

  3. THE TRUTH GATE IS A DIFFERENT SHAPE: `grounding.faults(reply, fact, question)`.
     The transferable finding of the previous session is that a form gate cannot see a
     lie -- "[firm] The gateway is on port 22" is flawlessly formed. On a durable row
     the same hazard arrives as an answer that is fluent, in voice, and about a fact
     the row does not contain. `grounding.py` is the one-sided check for that: every
     number, path and proper noun in the reply must come from the row or the question.
     Read its docstring for what it cannot see.

MANY PROMPTS AT LOW k. Measured, last session: 101 of 112 grounded candidates died on
the template lock, and five turns came out of 112 generations. The lock compares each
candidate against every candidate before it, so a second candidate for the same
question is competing with the first for the same eight leading tokens. Yield is
bounded by the number of DISTINCT questions, not by k. So the defaults here are the
other shape: `--questions 5 -k 2` over 35 rows, and the per-question cap is 1.

THE QUESTIONS ARE GENERATED TOO, and they are the `user` half of the training pair, so
they get their own gate (`vet_question`): a real question, short, no number or path of
its own, and not a paraphrase of one already asked for another row. A question that
carries the answer inside it teaches parroting rather than knowledge, so a question
sharing a rare content word with its own fact is rejected -- the model does that
readily when asked to paraphrase a statement into a question.

THE SCAFFOLD IS NEVER PART OF THE TRAINING PAIR, exactly as in `sample.py`. The stored
`user` turn is the bare question; the fact reaches the model only in the system prompt,
for the length of one generation. Storing the scaffolded prompt would train her to
recite a fact she has just been handed, which is the one case needing no training.

Generation is cached: questions in `data/instruct-questions.jsonl`, answers in
`data/instruct-raw.jsonl`. Re-vetting is free; `--regen` spends the GPU again.
"""
import argparse, json, os, re, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(R, "code"))

import vet                      # also puts harness/ and resources/bella on the path
import persona_eval as pe
import facts
import temi_moves
import grounding
from sample import ask, seed_for                # same model, same sampling settings

CALLS = {"n": 0}

# The durable scaffold. One line, one generation, never stored. It states the fact and
# then spends most of its words on LENGTH, because the corpus's measured defect is a
# 21-word median against her real 9 and a platform answer is the kind that runs long.
GROUND = ("\n\nCONTEXT FOR THIS TURN ONLY: {fact}\nAnswer the question from that and "
          "nothing else. One short sentence, your own voice, no more than fifteen "
          "words. Do not invent a number, a port, a path, a version or a name that is "
          "not in the line above.")

# Asking for questions is not a persona task, so it does not get the persona prompt.
QGEN = ("Here is one fact about a desktop application:\n\n{fact}\n\n"
        "Write {n} different short questions a user of the application might ask, "
        "each of which is answered by that fact. Vary the wording and the angle: some "
        "direct, some casual, some sceptical. Do not include the answer in the "
        "question. One question per line, no numbering, no preamble.")

_WORD = re.compile(r"[a-z][a-z'-]+")
_STOP = set("""a an and are as at be but by can could do does did for from has have how i if
in into is it its me my no not of on or our so than that the their them then there these
they this to too us was we what when where which who why will with would you your me
about above after again all also am any because been before being below between both
each few further here him his more most other same some such only own too very s t don
now just use using make makes made get gets give gives thing things something one two""".split())


def content(text):
    """The rare words of a string -- what a question must not steal from its own fact."""
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 3}


def rows():
    """The 35 durable rows, in table order, after the table checks itself.

    Same precondition `sample.py` states: a row citing a dead path is a fact that has
    stopped being one, and generating a hundred answers from a rotten table is worse
    than generating none.
    """
    bad = facts.check()
    if bad:
        raise SystemExit("fact table FAILS its own check; fix it first:\n  " + "\n  ".join(bad))
    return [f for f in facts.FACTS if f["kind"] == "durable"]


def vet_question(q, fact, already):
    """The gate on the `user` half. Returns a fault string, or None.

    Deliberately strict: a question is cheap to regenerate and expensive to train on.
    """
    words = q.split()
    if not q.endswith("?"):
        return "not a question"
    if not 3 <= len(words) <= 14:
        return f"length {len(words)}"
    if re.search(r"\d", q):
        return "carries a number"          # a durable row has no live value in it
    if "/" in q or "\\" in q:
        return "carries a path"
    if q.count("?") > 1:
        return "two questions in one"
    # A question that already contains the fact's rare words is a leading question: the
    # reply becomes an echo, and the pair teaches echoing.
    stolen = content(q) & content(fact["fact"])
    if len(stolen) >= 3:
        return f"carries its own answer ({', '.join(sorted(stolen))})"
    key = frozenset(content(q))
    if key in already:
        return "duplicate of an earlier question"
    already.add(key)
    return None


def make_questions(row, n, seen):
    """n paraphrases for one row, generated then gated. Over-asks to survive the gate."""
    CALLS["n"] += 1
    raw = ask([{"role": "user", "content": QGEN.format(fact=row["fact"], n=n + 4) + " /nothink"}],
              seed_for("q|" + row["id"], 0), with_system=False)
    out, rejected = [], []
    for line in raw.splitlines():
        q = " ".join(re.sub(r'^\s*[-*\d.)"]+\s*', "", line).strip().strip('"').split())
        if not q:
            continue
        fault = vet_question(q, row, seen)
        (rejected if fault else out).append((q, fault))
        if len(out) >= n:
            break
    return [q for q, _ in out], rejected


def candidate(row, question, k, grounded=True):
    """One answer through the shipped guard, standalone -- no history, no recent_spoken.

    Identical wiring to `sample.py:candidate`, and for the same reasons: every question
    is asked as a first turn so the k candidates are comparable, and `second_beat` is
    not applied because it generates from a near-constant prompt with no history.
    """
    ctr = {"k": 1}

    def sub(prompt):
        s = seed_for(row["id"] + "|" + question, 1000 * k + ctr["k"]); ctr["k"] += 1
        return iter([ask([{"role": "user", "content": prompt + " /nothink"}], s,
                         with_system=False)])

    ev, repairs = [], []

    def on_event(e, *a):
        ev.append(e)
        if e == "repaired" and len(a) >= 3:
            repairs.append({"fault": a[0], "before": a[1], "after": a[2]})

    CALLS["n"] += 1
    raw = " ".join(ask([{"role": "user", "content": question}],
                       seed_for(row["id"] + "|" + question, k),
                       ground=row["fact"] if grounded else None,
                       template=GROUND).split())
    text = " ".join("".join(temi_moves.guard_stream(
        iter([raw]), question, sub, recent_spoken=(), on_event=on_event)).split())
    return {"fact": row["id"], "source": row["source"], "truth": row["fact"],
            "user": question, "k": k, "raw": raw, "text": text,
            "repaired": "repaired" in ev, "repairs": repairs}


def corpus():
    """Everything already admitted, as prior history for the stateful walk.

    Three files now, not `sample.py`'s two: source (b)'s five grounded refusals are in
    the corpus and a new candidate must be novel against them as well.
    """
    prior = []
    for name in ("harvest-bench.jsonl", "authored-vetted.jsonl",
                 "sampled-grounded-vetted.jsonl"):
        path = os.path.join(HERE, "data", name)
        if not os.path.exists(path):
            raise SystemExit(f"missing {name}: run vet.py, authored.py and sample.py first")
        prior += [json.loads(l) for l in open(path)]
    return prior


def generate(pset, k, qcache, cache, nq, grounded=True):
    if os.path.exists(qcache):
        # The ungrounded arm MUST ask the same questions as the grounded one, or the
        # two are not comparable and the control set is measuring the prompts.
        qrows = [json.loads(l) for l in open(qcache)]
        print(f"reusing {sum(len(r['questions']) for r in qrows)} cached questions "
              f"from {os.path.basename(qcache)}", file=sys.stderr)
        return _answer(pset, qrows, k, cache, grounded)
    qrows, rejected, seen = [], [], set()
    for row in pset:
        qs, rej = make_questions(row, nq, seen)
        rejected += [(row["id"], q, f) for q, f in rej]
        qrows.append({"fact": row["id"], "questions": qs})
        print(f"  {row['id']:24s} {len(qs)} questions "
              f"({len(rej)} rejected)  {qs[0] if qs else '--'}", file=sys.stderr)
    with open(qcache, "w") as fh:
        for r in qrows:
            fh.write(json.dumps(r) + "\n")
    print(f"\n{sum(len(r['questions']) for r in qrows)} questions, "
          f"{len(rejected)} rejected -> {qcache}", file=sys.stderr)
    for fid, q, f in rejected:
        print(f"    reject {fid}: [{f}] {q}", file=sys.stderr)
    return _answer(pset, qrows, k, cache, grounded)


def _answer(pset, qrows, k, cache, grounded):
    by_id = {r["id"]: r for r in pset}
    rows_out = []
    for i, qr in enumerate(qrows, 1):
        row = by_id[qr["fact"]]
        for q in qr["questions"]:
            for j in range(k):
                c = candidate(row, q, j, grounded)
                rows_out.append(c)
                print(f"  [{i}/{len(qrows)}] {row['id']} k={j}"
                      f"{'  REPAIRED' if c['repaired'] else ''}  {c['text'][:70]}",
                      file=sys.stderr)
    with open(cache, "w") as fh:
        for r in rows_out:
            fh.write(json.dumps(r) + "\n")
    print(f"\n{CALLS['n']} model calls -> {cache}\n", file=sys.stderr)
    return rows_out


def main(k, per_fact, per_question, nq, regen, standalone=False, no_truth=False,
         grounded=True):
    pset = rows()
    data = os.path.join(HERE, "data")
    os.makedirs(data, exist_ok=True)
    qcache = os.path.join(data, "instruct-questions.jsonl")
    tag = "" if grounded else "ungrounded-"
    cache = os.path.join(data, f"instruct-{tag}raw.jsonl")

    if regen or not os.path.exists(cache):
        rows_in = generate(pset, k, qcache, cache, nq, grounded)
    else:
        rows_in = [json.loads(l) for l in open(cache)]
        print(f"reusing {len(rows_in)} cached candidates from {os.path.basename(cache)} "
              f"(--regen to resample)\n")

    tally = Counter()

    # Filter 1: the guard. A repaired candidate never reaches the gate -- `repair_prompt`
    # generates from a near-constant block, so admitting one trains the template.
    repairs = [p for r in rows_in for p in r["repairs"]]
    kept = [r for r in rows_in if not r["repaired"]]
    tally["repaired by the guard (held for preference data)"] = len(rows_in) - len(kept)

    quotes = pe.prompt_quotes(open(pe.PROMPT).read()) | pe.frozen_quotes()

    def admit(prior):
        users = [p["user"] for p in prior] + [r["user"] for r in kept]
        replies = [p["reply"] for p in prior] + [r["text"] for r in kept]
        vetted = vet.vet_conversation(users, replies, quotes, False)[len(prior):]
        sub, admitted, taken, per_q, form_pass = Counter(), [], defaultdict(int), defaultdict(int), []
        for r, v in zip(kept, vetted):
            if not v["faults"]:
                # Cleared the FORM gates -- recorded BEFORE the truth gate, because this
                # is grounding.py's known-bad control input. A control fed an already
                # filtered file reads vacuously; that mistake was made once in this lane.
                form_pass.append(dict(v, conv=r["fact"], kind="platform", rep=r["k"],
                                      truth=r["truth"], source=r["source"]))
            if not no_truth:
                v["faults"] = v["faults"] + grounding.faults(v["reply"], r["truth"], r["user"])
            if v["faults"]:
                for f in v["faults"]:
                    sub[f] += 1
                continue
            if per_q[r["user"]] >= per_question:
                sub["over the per-question cap"] += 1
                continue
            if taken[r["fact"]] >= per_fact:
                sub["over the per-fact cap"] += 1
                continue
            per_q[r["user"]] += 1
            taken[r["fact"]] += 1
            v.update(conv=r["fact"], kind="platform", rep=r["k"], repaired=False,
                     truth=r["truth"], source=r["source"])
            sub["ADMITTED"] += 1
            admitted.append(dict(v))
        return admitted, sub, taken, form_pass

    alone, alone_tally, _t, _fp = admit([])
    prior = [] if standalone else corpus()
    admitted, sub, taken, form_pass = ((alone, alone_tally, _t, _fp) if standalone
                                       else admit(prior))
    tally.update(sub)

    total = len(rows_in)
    print(f"{total} candidates over {len(pset)} durable rows\n")
    for key, n in tally.most_common():
        print(f"  {n:5d}  {key}")
    print(f"\nadmitted {len(admitted)}/{total} = {100*len(admitted)/total:.1f}%")
    if not standalone:
        print(f"  (against an empty history it would be {len(alone)}; "
              f"{len(alone) - len(admitted)} candidate(s) only survive because the "
              f"{len(prior)}-turn corpus was not in the comparison)")

    print(f"facts covered {len(taken)}/{len(pset)}")
    dry = [r["id"] for r in pset if not taken.get(r["id"])]
    if dry:
        print(f"no admitted candidate: {', '.join(dry)}")

    if admitted:
        words = sorted(len(v["reply"].split()) for v in admitted)
        print(f"length: median {words[len(words)//2]} words, "
              f"mean {sum(words)/len(words):.1f}, range {words[0]}-{words[-1]}")

    dest = os.path.join(data, f"instruct-{tag}vetted.jsonl")
    with open(dest, "w") as fh:
        for v in admitted:
            fh.write(json.dumps(v) + "\n")
    print(f"wrote {dest}")

    fdest = os.path.join(data, f"instruct-{tag}formpass.jsonl")
    with open(fdest, "w") as fh:
        for v in form_pass:
            fh.write(json.dumps(v) + "\n")
    print(f"wrote {fdest} ({len(form_pass)} cleared the form gates, before the truth gate)")

    rdest = os.path.join(data, f"instruct-{tag}repairs.jsonl")
    with open(rdest, "w") as fh:
        for p in repairs:
            fh.write(json.dumps(p) + "\n")
    print(f"wrote {rdest} ({len(repairs)} before/after pairs, for DPO -- not SFT)")
    return admitted


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-k", type=int, default=2, help="candidates per question (default 2)")
    ap.add_argument("--questions", type=int, default=5,
                    help="questions per durable row (default 5)")
    ap.add_argument("--per-fact", type=int, default=3,
                    help="most admitted candidates per fact (default 3)")
    ap.add_argument("--per-question", type=int, default=1,
                    help="most admitted candidates per question (default 1)")
    ap.add_argument("--regen", action="store_true", help="resample instead of using the cache")
    ap.add_argument("--standalone", action="store_true",
                    help="vet candidates against each other only, not against the corpus")
    ap.add_argument("--ungrounded", action="store_true",
                    help="generate WITHOUT the fact in the prompt. A negative-result arm: "
                         "its output is grounding.py's known-bad control and must NEVER "
                         "be pooled into the corpus.")
    ap.add_argument("--no-truth", action="store_true",
                    help="skip the grounding gate -- for building its known-bad control only")
    a = ap.parse_args()
    main(a.k, a.per_fact, a.per_question, a.questions, a.regen, a.standalone,
         a.no_truth or a.ungrounded, not a.ungrounded)
