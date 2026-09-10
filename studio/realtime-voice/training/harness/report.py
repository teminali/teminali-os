"""Read bench.jsonl and compare the arms. Paired, so the test is McNemar's exact.

The arms walk the same seed schedule, so each (rep, conv) is one matched pair and the
only informative conversations are the DISCORDANT ones -- base locked and the arm did
not, or the reverse. Under the null those split 50/50, so the two-sided p is the exact
binomial tail. Concordant pairs carry no information and are excluded, which is the whole
reason this design needs ~16 conversations rather than the hundreds an unpaired one would.
"""
import json, sys
from math import comb
SC = "/private/tmp/claude-501/-Users-teminali-Documents-my-projects-teminali-teminaliCode/4b4d800d-78be-44fa-9c92-08d2b51aa233/scratchpad"
sys.path.insert(0, SC)
from lock import locks                      # noqa: E402

LOCK_THRESH = 8

runs = [json.loads(l) for l in open(sys.argv[1] if len(sys.argv) > 1 else "bench.jsonl")]
arms = list(dict.fromkeys(r["arm"] for r in runs))
by = {(r["rep"], r["conv"], r["arm"]): r for r in runs}
# Only conversations present in EVERY arm are comparable; a run read mid-flight has a
# trailing partial pair, and including it would compare unequal denominators.
pairs = sorted({(r["rep"], r["conv"]) for r in runs
                if all((r["rep"], r["conv"], a) in {(x["rep"], x["conv"], x["arm"]) for x in runs}
                       for a in dict.fromkeys(y["arm"] for y in runs))})

# Recompute the lock metric from the stored transcripts rather than trusting the count the
# run wrote. The detector was sharpened (contraction expansion) while a run was in flight;
# scoring from text keeps every arm measured by the SAME detector version, and lets a
# future session re-score these transcripts without spending the GPU again.
for r in runs:
    lk = locks(r["turns"], LOCK_THRESH)
    r["n_lock"], r["locked"] = len(lk), bool(lk)
    r["n_repair_failed"] = sum(1 for t in r["turns"] if "repair_failed" in t["ev"])
    r["words"] = sum(len(t["text"].split()) for t in r["turns"])


def mcnemar(base_flags, arm_flags):
    b = sum(1 for x, y in zip(base_flags, arm_flags) if x and not y)   # base bad, arm good
    c = sum(1 for x, y in zip(base_flags, arm_flags) if y and not x)   # arm bad, base good
    n = b + c
    if n == 0:
        return b, c, 1.0
    k = min(b, c)
    p = min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)
    return b, c, p


print(f"{len(pairs)} matched conversations per arm "
      f"({sum(by[(p[0], p[1], arms[0])]['n_turns'] for p in pairs)} turns each)\n")
hdr = (f"{'arm':6s} {'turns':>5s} {'tailcopies':>10s} {'lockevents':>10s} "
       f"{'lockedconvs':>11s} {'repairs':>8s} {'rp_fail':>7s} {'words/turn':>10s}  {'GPU turns':>9s}")
print(hdr); print("-" * len(hdr))
flags = {}
for arm in arms:
    rs = [by[(p[0], p[1], arm)] for p in pairs]
    flags[arm] = {"lock": [r["locked"] for r in rs],
                  "tail": [r["n_tail"] > 0 for r in rs]}
    gen = sum(sum(1 for t in r["turns"] if not t.get("replayed")) for r in rs)
    print(f"{arm:6s} {sum(r['n_turns'] for r in rs):5d} {sum(r['n_tail'] for r in rs):10d} "
          f"{sum(r['n_lock'] for r in rs):10d} {sum(r['locked'] for r in rs):5d}/{len(rs):<5d} "
          f"{sum(r['n_repaired'] for r in rs):8d} {sum(r['n_repair_failed'] for r in rs):7d} "
          f"{sum(r['words'] for r in rs) / max(1, sum(r['n_turns'] for r in rs)):10.1f}  {gen:9d}")

base = arms[0]
if sum(flags[base]["lock"]) == 0 and sum(flags[base]["tail"]) == 0:
    print("\n*** HARNESS DID NOT REPRODUCE THE DEFECT IN THE BASELINE ARM. ***")
    print("Read no result from this run -- a clean zero here means the probe is broken,")
    print("which is exactly how ~10 minutes of GPU was lost on 2026-09-09.")
    sys.exit(1)

print("\nMcNemar exact, paired against the baseline arm "
      "(b = base bad & arm good, c = arm bad & base good):")
for arm in arms[1:]:
    for m, label in (("lock", "template lock"), ("tail", "tail copy")):
        b, c, p = mcnemar(flags[base][m], flags[arm][m])
        verdict = "improves" if b > c and p < 0.05 else ("WORSENS" if c > b and p < 0.05
                                                         else "no significant difference")
        print(f"  {arm:5s} {label:14s} b={b:2d} c={c:2d}  p={p:.4f}  {verdict}")

print("\nDoes an EARLY repair predict the lock? (baseline arm only)")
rs = [by[(p[0], p[1], base)] for p in pairs]
for lo, hi in ((1, 4), (5, 99)):
    sel = [r for r in rs if r["first_repair"] and lo <= r["first_repair"] <= hi]
    if sel:
        print(f"  first repair at turn {lo}-{hi if hi < 99 else 'end'}: "
              f"{sum(r['locked'] for r in sel)}/{len(sel)} locked")
none = [r for r in rs if not r["first_repair"]]
if none:
    print(f"  no repair at all              : {sum(r['locked'] for r in none)}/{len(none)} locked")


# The association between "a repair fired" and "the conversation locked", one-sided Fisher
# exact. This is the finding the arms could not deliver: neither cutting the repaired turn
# down nor deleting it from history helped, but conversations where no repair ever fired
# did not lock at all.
rep_lock = sum(1 for r in rs if r["first_repair"] and r["locked"])
rep_tot = sum(1 for r in rs if r["first_repair"])
non_lock = sum(1 for r in rs if not r["first_repair"] and r["locked"])
non_tot = len(rs) - rep_tot
locked_tot = rep_lock + non_lock
pv = sum(comb(len(rs) - locked_tot, non_tot - k) * comb(locked_tot, k)
         for k in range(0, non_lock + 1)) / comb(len(rs), non_tot)
print(f"\n  repair fired : {rep_lock}/{rep_tot} locked")
print(f"  no repair    : {non_lock}/{non_tot} locked")
print(f"  Fisher exact, one-sided: p={pv:.4f}")
