#!/usr/bin/env python3
"""Put hand-authored turns -- source (a) -- through the SAME gate as the harvest.

`vet.py:main` cannot do this: it is bound to the bench schema, reading user turns
from `persona_eval.CONVERSATIONS[row["conv"]]` and an arm/rep/locked triple that a
hand-written conversation has none of. So this file supplies the other reader and
reuses `vet.vet_conversation` **unchanged** -- the gates themselves are not
re-argued here, and must not be. Authoring the data and judging it are the same
hand, which is exactly why the judge has to stay the already-validated one.

`conv_locked` is False by design: the locked flag is a measurement of a generated
conversation's shape and there is nothing to measure on a turn a human wrote.
Every other gate applies in full.

Input  `data/authored.jsonl`, one conversation per line:
    {"id": "...", "kind": "persona"|"platform", "turns": [{"user": ..., "reply": ...}]}
Output `data/authored-vetted.jsonl`, the admitted turns, same row shape as the harvest.
"""
import json, os, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import vet
import persona_eval as pe   # vet.py already put resources/bella on the path


def main(path, dest):
    quotes = pe.prompt_quotes(open(pe.PROMPT).read()) | pe.frozen_quotes()

    tally, admitted, total, rejected = Counter(), [], 0, []
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        conv = json.loads(line)
        users = [t["user"] for t in conv["turns"]]
        replies = [t["reply"] for t in conv["turns"]]
        for v in vet.vet_conversation(users, replies, quotes, False):
            total += 1
            v["conv"], v["kind"], v["rep"] = conv["id"], conv.get("kind", "persona"), 0
            v["repaired"] = False
            if v["faults"]:
                for f in v["faults"]:
                    tally[f] += 1
                rejected.append(v)
                continue
            tally["ADMITTED"] += 1
            admitted.append(v)

    print(f"{total} hand-authored turns from {os.path.basename(path)}\n")
    for k, n in tally.most_common():
        print(f"  {n:5d}  {k}")
    if rejected:
        print("\nrejected:")
        for v in rejected:
            print(f'  [{v["conv"]} #{v["n"]}] {",".join(v["faults"])}')
            print(f'      {v["reply"][:100]}')
    pct = 100 * len(admitted) / total if total else 0.0
    print(f"\nadmitted {len(admitted)}/{total} = {pct:.1f}%")

    with open(dest, "w") as fh:
        for v in admitted:
            fh.write(json.dumps(v) + "\n")
    print(f"wrote {dest}")
    return admitted


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "data", "authored.jsonl")
    main(src, os.path.join(HERE, "data", "authored-vetted.jsonl"))
