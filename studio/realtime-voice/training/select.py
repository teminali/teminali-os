#!/usr/bin/env python3
"""Length-stratified selection over the pooled corpus.

The pool is admitted data, not selected data. Every gate so far answers "may this
turn enter?"; none answers "which of the admitted turns should the LoRA actually
see?". Those are different questions, and the second one is where the harvest's
measured defect lives: its median is 21 words against her real 9, so a corpus that
is simply the union of everything admitted would train her to be WORDIER, which is
the opposite of the point. `DATASET.md` has said "selection must be
length-stratified, not top-N" since the harvest was first measured. This is that
step.

Two targets, both taken from things already decided, neither invented here:

  length    the empirical shape of source (a) -- the hand-authored turns, which are
            the only ground truth in this lane for what her voice is SUPPOSED to
            look like. Measured at import (`reference_shape`), never hardcoded, so
            it moves if source (a) does.
  function  `DATASET.md`'s composition table ("Composition, by function rather than
            by topic"). Its "wit, comfort, lateral" row is folded into "ordinary
            talk" because both are sourced from the same `rambling` conversation and
            NOTHING IN THE DATA SEPARATES THEM -- see `function_of`.

Selection is a fill over the (function x length-bin) grid. Each cell gets a quota,
and a cell that cannot meet it reports a DEFICIT rather than quietly taking a
longer turn instead. That is the whole design: the deficit report is the output
that matters. Backfilling by default would hide the one fact this step exists to
surface -- which cell the corpus is actually missing.

Three rejections during the fill, all of them reusing detectors this lane already
validated rather than inventing new judgement:

  exact     the same reply string twice. 12 exist across the pool.
  tail      `tails.copies` -- this reply ends on an earlier selected one's ending.
  recite    `recite.recites` -- this reply opens on an earlier selected one's opening.

`vet.py` runs the last two WITHIN a conversation. Nothing has ever run them ACROSS
sources, and the pool needs it: 33 tail copies and 18 template locks survive into
the 331 between conversations that never saw each other.

And a fourth, which is not a detector but an accounting rule: `--cap` bounds how
many turns one distinct user prompt may contribute. The harvest looks like 189
turns and is 25 prompts sampled about seven times each; `ordinary` is 143 turns
over FOURTEEN prompts. Without a cap the largest function bucket trains fourteen
prompts, deeply. The cap's value is a judgement, not a measurement -- see CAP.
"""
import argparse, json, os, statistics as st, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "harness"))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "resources", "bella")))

import persona_eval as pe
import tails, recite

TAIL_THRESH = 7   # tails.py's validated threshold, same as vet.py's

# The pool, in the order DATASET.md's Verification block lists it. These four files
# ARE the corpus; the count they sum to is the number every handover quotes.
#
# Never add `*-ungrounded-*` (the negative-result arm), `*-vetted` where an
# `*-admitted` exists beside it (the hand review is what makes the difference), or
# `*-repairs` (held for DPO -- a repair's output teaches the template that causes
# the defect it repairs).
SOURCES = {
    "harvest":  "harvest-bench.jsonl",
    "authored": "authored-vetted.jsonl",
    "sampled":  "sampled-grounded-vetted.jsonl",
    "instruct": "instruct-admitted.jsonl",
}

# Length bins. The boundaries are source (a)'s own shape, not round numbers: it runs
# 7-17 with a median of 9, so `<=8` is "at or under her median", `9-12` is the body
# of her range, `13-17` is her long tail, and `18+` is off the end of anything she
# has ever been hand-written to say.
BINS = [("<=8", 0, 8), ("9-12", 9, 12), ("13-17", 13, 17), ("18+", 18, 10**6)]

# DATASET.md, "Composition, by function rather than by topic". The 35% "voice and
# brevity under ordinary talk" and the 10% "wit, comfort, lateral answers" rows are
# summed here; see the module docstring and `function_of`.
FUNCTION_TARGET = {"ordinary": 0.45, "refusal": 0.20, "platform": 0.20, "handoff": 0.15}

# How many turns one distinct user prompt may contribute.
#
# A JUDGEMENT, and labelled one: no measurement in this lane says what the right
# number is, and the cap curve is smooth (162/189/213/232 turns at cap 1/2/3/4), so
# there is no elbow to point at. 2 is chosen because a second reply to the same
# prompt is paraphrase diversity -- the model saying the same thing another way,
# which is worth training -- and a third is mostly the sampler's temperature. Raise
# it only with an ablation that shows the extra turns buy anything.
CAP = 2


def function_of(row):
    """Which of DATASET.md's function buckets this turn belongs to.

    The harvest carries no `kind`, only `conv`, and it has exactly two: `grounded`
    is the fabrication-bait conversation and `rambling` is everything else.

    So `ordinary` here is DATASET.md's "voice and brevity under ordinary talk" AND
    its "wit, comfort, lateral answers" together. They are not separable with the
    labels that exist -- both are `rambling` turns, and no field distinguishes a
    lateral joke from a short acknowledgement. Reporting them as one bucket at 45%
    is honest; reporting them as two at 35/10 would be a split invented at read
    time. Splitting them for real needs a label on the turn, not a rule here.
    """
    if row["src"] == "harvest":
        return "ordinary" if row["conv"] == "rambling" else "refusal"
    return row["kind"]


def bin_of(words):
    for name, lo, hi in BINS:
        if lo <= words <= hi:
            return name
    raise ValueError(words)


def load_pool(data_dir=None):
    """The 331, each turn tagged with its source, function, word count and bin."""
    data_dir = data_dir or os.path.join(HERE, "data")
    pool = []
    for src, fname in SOURCES.items():
        path = os.path.join(data_dir, fname)
        for line in open(path):
            row = json.loads(line)
            row["src"] = src
            # pe.shape_of is the eval's own word count -- tag stripped, body split.
            # Using anything else here would measure a different corpus than the
            # instrument that scores her does.
            row["words"] = pe.shape_of(row["reply"])[0]
            row["bin"] = bin_of(row["words"])
            row["fn"] = function_of(row)
            pool.append(row)
    return pool


def reference_shape(pool):
    """The target length distribution: source (a)'s, measured, never hardcoded.

    Source (a) is 72 hand-authored turns and is the only thing in this lane that was
    written to be right rather than sampled and filtered. Its shape is the target by
    construction -- if the hand-authored set is wrong about her voice, the target is
    wrong, and that is the right place for the argument to happen.
    """
    a = [r for r in pool if r["src"] == "authored"]
    return {name: sum(1 for r in a if r["bin"] == name) / len(a) for name, _, _ in BINS}


def feasible_n(pool, shape):
    """Largest N for which every (function x bin) quota can be met exactly.

    A cell wanting share s of N and holding only `avail` turns caps N at avail/s.
    The smallest such cap over the grid is the answer, and the cell that produced it
    is the one blocking the corpus -- which is the number this whole file exists to
    print.
    """
    avail = Counter((r["fn"], r["bin"]) for r in pool)
    caps = []
    for fn, fshare in FUNCTION_TARGET.items():
        for name, _, _ in BINS:
            want = fshare * shape[name]
            if want > 0:
                caps.append((avail[(fn, name)] / want, fn, name))
    return min(caps)


def select(pool, n, shape, cap=CAP, backfill=False):
    """Fill the (function x bin) grid to quota. Returns (selected, report).

    Fill order within a cell is deterministic and diversity-first: a turn whose
    prompt has contributed nothing yet comes before one whose prompt has already
    been drawn from, then rarest conversation first, then file order. No randomness
    -- a selection you cannot reproduce is a selection you cannot argue about.
    """
    quota = {}
    for fn, fshare in FUNCTION_TARGET.items():
        for name, _, _ in BINS:
            quota[(fn, name)] = round(n * fshare * shape[name])

    by_cell = defaultdict(list)
    for r in pool:
        by_cell[(r["fn"], r["bin"])].append(r)

    conv_size = Counter(r["conv"] for r in pool)
    taken, chosen, per_prompt = [], [], Counter()
    picked = set()          # by id(): two turns can be equal dicts and still be two turns
    rejects = Counter()

    def try_take(row):
        if per_prompt[row["user"]] >= cap:
            rejects["prompt cap"] += 1
            return False
        if any(row["reply"] == t["reply"] for t in chosen):
            rejects["exact duplicate"] += 1
            return False
        if tails.copies(row["reply"], taken, TAIL_THRESH):
            rejects["tail copy"] += 1
            return False
        if recite.recites(row["reply"], taken):
            rejects["template lock"] += 1
            return False
        chosen.append(row)
        picked.add(id(row))
        taken.append(row["reply"])
        per_prompt[row["user"]] += 1
        return True

    def order(rows, shortest_first=False):
        """Diversity first, then a deterministic tiebreak.

        `shortest_first` is used only when backfilling. A substitute for a short
        turn should be the least-long thing available -- taking a 48-word reply to
        stand in for a 9-12-word one is how a corpus built to shorten her ends up
        with a mean of 13.7. Prompt diversity still outranks it: a shorter turn from
        a prompt already drawn twice is worth less than a longer one from a prompt
        the corpus has not heard yet.
        """
        return sorted(rows, key=lambda r: (per_prompt[r["user"]],
                                           r["words"] if shortest_first else 0,
                                           conv_size[r["conv"]],
                                           r["src"], r["conv"], r["n"], r["words"]))

    filled, borrowed = Counter(), Counter()
    bin_names = [name for name, _, _ in BINS]
    for fn in FUNCTION_TARGET:
        for bi, name in enumerate(bin_names):
            want = quota[(fn, name)]
            pool_cell = [r for r in by_cell[(fn, name)] if id(r) not in picked]
            for row in order(pool_cell):
                if filled[(fn, name)] >= want:
                    break
                if try_take(row):
                    filled[(fn, name)] += 1
            if backfill and filled[(fn, name)] < want:
                # Borrow from LONGER bins only. The shortage is always at the short
                # end -- a corpus is never short of long turns -- and borrowing
                # downward would make the median worse, not better.
                for donor in bin_names[bi + 1:]:
                    donors = [r for r in by_cell[(fn, donor)] if id(r) not in picked]
                    for row in order(donors, shortest_first=True):
                        if filled[(fn, name)] >= want:
                            break
                        if try_take(row):
                            filled[(fn, name)] += 1
                            borrowed[(fn, name)] += 1

    report = {"quota": quota, "filled": filled, "borrowed": borrowed,
              "rejects": rejects, "n_target": n}
    return chosen, report


def describe(chosen, pool, report):
    lines = []
    q, f, b = report["quota"], report["filled"], report["borrowed"]
    # Quotas are per-cell rounds, so they can sum to a hair more or less than N.
    lines.append(f"target N {report['n_target']}   quotas sum to {sum(q.values())}   "
                 f"selected {len(chosen)}")
    lines.append("")
    head = f"{'function':10s}" + "".join(f"{n:>12s}" for n, _, _ in BINS) + f"{'total':>9s}"
    lines.append(head)
    total_def = 0
    for fn in FUNCTION_TARGET:
        cells = []
        for name, _, _ in BINS:
            want, got, bor = q[(fn, name)], f[(fn, name)], b[(fn, name)]
            total_def += want - got
            mark = f"{got}/{want}" + (f"+{bor}" if bor else "")
            if got < want:
                mark += "!"
            cells.append(mark)
        lines.append(f"{fn:10s}" + "".join(f"{c:>12s}" for c in cells) +
                     f"{sum(f[(fn, n)] for n, _, _ in BINS):9d}")
    lines.append("")
    lines.append(f"  deficit (quota not met, by cell)   {total_def}")
    for k, v in report["rejects"].most_common():
        lines.append(f"  rejected during fill: {k:18s} {v}")
    if chosen:
        w = sorted(r["words"] for r in chosen)
        lines.append("")
        lines.append(f"  achieved length   median {st.median(w):.1f}  mean {st.mean(w):.1f}  "
                     f"range {w[0]}-{w[-1]}   (target median 9.0)")
        mix = Counter(r["fn"] for r in chosen)
        lines.append("  achieved function " + "  ".join(
            f"{k} {100*v/len(chosen):.0f}% (want {100*FUNCTION_TARGET[k]:.0f}%)"
            for k, v in sorted(mix.items())))
        lines.append("  achieved source   " + "  ".join(
            f"{k} {v}" for k, v in Counter(r["src"] for r in chosen).most_common()))
        lines.append(f"  distinct prompts  {len({r['user'] for r in chosen})} "
                     f"of {len(chosen)} turns")
    return "\n".join(lines)


# ---------------------------------------------------------------- control

def _row(src, conv, kind, n, reply, user=None):
    r = {"src": src, "conv": conv, "kind": kind, "n": n, "reply": reply,
         "user": user or f"q{conv}{n}", "faults": [], "rep": 0, "repaired": False}
    r["words"] = pe.shape_of(reply)[0]
    r["bin"] = bin_of(r["words"])
    r["fn"] = function_of(r)
    return r


def control():
    """Two-sided, like `refusal.py` and `grounding.py`.

    A selector is a thing that can lie in two directions: it can report a deficit
    that is not there (and send someone off to generate data they already have),
    or it can meet a quota by taking a turn it should have rejected. Both halves
    are checked against a synthetic pool whose right answer is known by
    construction, because on real data neither is observable.
    """
    ok = True
    shape = {"<=8": 0.5, "9-12": 0.5, "13-17": 0.0, "18+": 0.0}

    # (1) a pool that is exactly the target shape must select at ZERO deficit.
    rich = []
    n = 0
    for fn, conv, kind in [("ordinary", "rambling", None), ("refusal", "grounded", None),
                           ("platform", "plat-x", "platform"), ("handoff", "hand-x", "handoff")]:
        src = "harvest" if kind is None else "authored"
        for i in range(40):
            n += 1
            short = f"[firm] Alpha{n} bravo charlie delta echo foxtrot."          # 6 words
            mid = f"[firm] Golf{n} hotel india juliett kilo lima mike november oscar papa."  # 10
            rich.append(_row(src, conv, kind, n, short))
            n += 1
            rich.append(_row(src, conv, kind, n, mid))
    chosen, rep = select(rich, 40, shape, cap=CAP)
    deficit = sum(rep["quota"][k] - rep["filled"][k] for k in rep["quota"])
    if deficit != 0 or len(chosen) != 40:
        ok = False
        print(f"  FAIL false-positive arm: deficit {deficit}, selected {len(chosen)} of 40")
    else:
        print(f"  ok   a target-shaped pool selects 40/40 at zero deficit")

    # (2) remove one cell entirely; the deficit must land on THAT cell and no other.
    starved = [r for r in rich if not (r["fn"] == "ordinary" and r["bin"] == "<=8")]
    chosen, rep = select(starved, 40, shape, cap=CAP)
    missed = [k for k in rep["quota"] if rep["quota"][k] > rep["filled"][k]]
    want = rep["quota"][("ordinary", "<=8")]
    if missed != [("ordinary", "<=8")] or want == 0:
        ok = False
        print(f"  FAIL starved arm: deficit reported on {missed}, expected [('ordinary','<=8')]")
    else:
        print(f"  ok   starving one cell reports a deficit of {want} on that cell alone")

    # (3) backfill must close that deficit and say it borrowed.
    chosen, rep = select(starved, 40, shape, cap=CAP, backfill=True)
    if rep["borrowed"][("ordinary", "<=8")] != want:
        ok = False
        print(f"  FAIL backfill borrowed {rep['borrowed'][('ordinary','<=8')]}, expected {want}")
    else:
        print(f"  ok   --backfill closes it with {want} longer turns, and reports them as borrowed")

    # (4) the three dedup rejections must fire.
    dup = list(rich)
    twin = rich[0]
    # n=0 puts the twin next to the row it copies; at n=9001 the fill met its
    # quota long before reaching it, and the arm passed vacuously.
    dup.insert(1, _row(twin["src"], twin["conv"], twin["kind"], 0, twin["reply"], user="other"))
    _, rep = select(dup, 40, shape, cap=CAP)
    if not rep["rejects"]["exact duplicate"]:
        ok = False
        print("  FAIL an exact duplicate reply was not rejected")
    else:
        print("  ok   an exact duplicate reply is rejected across sources")

    # (5) the prompt cap must bound one prompt's contribution.
    same = []
    for i in range(60):
        same.append(_row("harvest", "rambling", None, i,
                         f"[firm] Alpha{i} bravo charlie delta echo foxtrot.", user="one question"))
    _, rep2 = select(same + rich, 40, shape, cap=2)
    if not rep2["rejects"]["prompt cap"]:
        ok = False
        print("  FAIL the prompt cap never fired on 60 turns sharing one prompt")
    else:
        print(f"  ok   one prompt is capped at {CAP}; {rep2['rejects']['prompt cap']} turns refused")

    print("\ncontrol:", "PASS" if ok else "FAIL")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-n", type=int, default=0, help="target corpus size (default: the feasible N)")
    ap.add_argument("--cap", type=int, default=CAP, help=f"max turns per distinct prompt (default {CAP})")
    ap.add_argument("--backfill", action="store_true",
                    help="let a longer bin fill a short bin's deficit, and report how much")
    ap.add_argument("--out", help="write the selection as jsonl (default: report only, write nothing)")
    ap.add_argument("--no-control", action="store_true")
    args = ap.parse_args()

    pool = load_pool()
    shape = reference_shape(pool)
    print(f"pool {len(pool)} turns, {len({r['user'] for r in pool})} distinct prompts")
    w = sorted(r["words"] for r in pool)
    print(f"  as pooled: median {st.median(w):.1f} words, mean {st.mean(w):.1f}, range {w[0]}-{w[-1]}")
    print("  reference shape, from source (a) (n=%d): %s" % (
        sum(1 for r in pool if r["src"] == "authored"),
        "  ".join(f"{k} {100*v:.1f}%" for k, v in shape.items())))

    cap_n, cap_fn, cap_bin = feasible_n(pool, shape)
    avail = Counter((r["fn"], r["bin"]) for r in pool)
    print(f"\n  binding cell: {cap_fn} / {cap_bin} holds {avail[(cap_fn, cap_bin)]} turns")
    print(f"  joint-feasible N (length shape AND function shape, no substitution): {int(cap_n)}")

    # The SECOND ceiling, and on this pool it is the one that actually bites. A
    # function bucket cannot exceed (its distinct prompts x the cap) turns however
    # much backfilling is allowed, because the cap is a property of the prompts, not
    # of the lengths. `ordinary` is 143 turns over 14 prompts: at cap 2 it can never
    # contribute more than 28, which bounds a function-balanced corpus at 28/0.45.
    print(f"\n  prompt ceiling at --cap {args.cap} (turns are not prompts):")
    ceilings = []
    for fn, share in FUNCTION_TARGET.items():
        turns = sum(1 for r in pool if r["fn"] == fn)
        prompts = len({r["user"] for r in pool if r["fn"] == fn})
        ceil = prompts * args.cap
        ceilings.append((ceil / share, fn))
        print(f"    {fn:10s} {turns:3d} turns over {prompts:3d} prompts -> at most "
              f"{ceil:3d} usable, implying N <= {int(ceil/share):4d}")
    print(f"  prompt-feasible N (function shape, any length, backfilled): "
          f"{int(min(ceilings)[0])}, bound by {min(ceilings)[1]}")

    # The third frontier point: give up the function target entirely and match only
    # the length shape. It is much larger, and it is not free -- what it buys with
    # the extra turns is a corpus whose function mix is whatever the pool happened
    # to be, which is the thing DATASET.md's composition table exists to prevent.
    bin_avail = Counter(r["bin"] for r in pool)
    length_only = int(min(bin_avail[k] / shape[k] for k, _, _ in BINS if shape[k] > 0))
    print(f"  length-feasible N (length shape alone, function mix unconstrained): {length_only}")

    n = args.n or max(int(cap_n), 1)
    print("\n--- exact fill " + "-" * 52)
    chosen, rep = select(pool, n, shape, cap=args.cap)
    print(describe(chosen, pool, rep))

    if args.backfill or not args.n:
        # The prompt ceiling, not the turn count: asking for more than `ordinary`
        # has prompts to give just manufactures a deficit the fill cannot close.
        n_bf = args.n or int(min(ceilings)[0])
        print(f"\n--- with --backfill, at N={n_bf} " + "-" * 34)
        chosen_bf, rep_bf = select(pool, n_bf, shape, cap=args.cap, backfill=True)
        print(describe(chosen_bf, pool, rep_bf))
        if args.backfill:
            chosen, rep = chosen_bf, rep_bf

    if args.out:
        with open(args.out, "w") as fh:
            for r in chosen:
                out = {k: v for k, v in r.items() if k not in ("bin", "fn", "src", "words")}
                out["src"], out["fn"], out["words"] = r["src"], r["fn"], r["words"]
                fh.write(json.dumps(out) + "\n")
        print(f"\nwrote {len(chosen)} turns to {args.out}")

    if not args.no_control:
        print("\n--- control " + "-" * 55)
        control()


if __name__ == "__main__":
    main()
