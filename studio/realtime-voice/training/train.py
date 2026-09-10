#!/usr/bin/env python3
"""LoRA trainer for Temi's persona, on MLX, against `data/selected.jsonl`.

Every gate before this one answers a question about the data. This one answers
"what does the model actually see?", and that turns out to be three decisions,
none of which the corpus itself settles:

  the pair      what goes in the system message, given that the whole point of
                the lane is to take 1118 words OUT of it
  the mask      which tokens carry loss
  the split     which turns are held back, and grouped by what

They are all written down below rather than buried in flags, because each one is
a place where a plausible default would quietly undo the corpus work.

THE PAIR. `code/system_prompt.txt` is 1118 words and its `TEMI'S VOICE IN
PRACTICE` block is twelve worked examples. `DATASET.md` ("Why fine-tune at all")
measured that anything in the conversation reads as an exemplar the model copies,
so those twelve are a hazard held constant on every turn. `SYSTEM` below is what
survives into the weights-era prompt: the identity anchor, the hands/report
contract, and the tag list. It is ~110 words. What it deliberately DROPS is the
brevity instruction and all twelve examples -- those are the thing being trained,
and leaving them in would make the result unreadable as evidence.

The tag list stays, and that is a measurement rather than a preference. All nine
tags do appear in the 138, but `comforting` appears once and `intimate` twice.
Nine classes cannot be learned from n=1, so the list stays in the prompt as
insurance and only the CHOICE of tag is learned. Re-measure before dropping it.

THE MASK. `mask_prompt=True`: loss on the assistant turn only. At 138 examples,
tokens spent modelling the operator's half are capacity not spent on her voice.
This is a judgement, labelled as one; the ablation can flip it.

Measured, not assumed: the Qwen3 template renders an untagged assistant turn as
`<|im_start|>assistant\\n<think>\\n\\n</think>\\n\\n...`, and the mask offset lands
before that empty think block, so the block IS trained on. That is correct here
and worth being explicit about -- it teaches her to answer without a thinking
pass, which is what a real-time voice lane needs. `control()` proves the offset
is a true prefix rather than trusting the template not to change.

THE SPLIT. Grouped by conversation, stratified by function, seeded. Turn-level
splitting would leak: 13 of the 39 conversations are 7 turns of one authored
conversation, so a random turn split puts siblings on both sides and the
validation loss stops meaning anything. No conversation spans two functions
(measured), so grouping and stratifying do not fight each other.

Nothing here quotes a training time. `--bench` measures throughput over 30
iterations and prints a projection labelled as one; `DATASET.md` has carried an
unmeasured "~2-3 h" estimate for seven handovers and this is the instrument that
replaces it.

Usage:
    python train.py --prepare              # build data/mlx/{train,valid}.jsonl, report
    python train.py --bench                # 30 iterations, real throughput, no adapter
    python train.py --run --name r1        # the real thing -> runs/r1/
    python train.py                        # prepare + control, no GPU work
"""

# `training/select.py` shadows the stdlib `select` module, and the mlx_lm import
# chain (huggingface_hub -> httpx -> httpcore) needs the stdlib one. It bites in
# TWO places and each needs its own fix:
#
#   this process    sys.path[0] is the script's directory whatever the cwd is, so
#                   dropping it is the fix. Nothing here imports a sibling module.
#   child processes multiprocessing's resource_tracker respawns itself with
#                   `python -c ...`, which prepends the CWD -- and a child that
#                   imports `socket` gets `select.py`, dies on a circular import,
#                   and is relaunched in a loop that steals real wall time. The
#                   fix is to not be sitting in `training/`; every path in this
#                   file is absolute, so the chdir costs nothing.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path = [p for p in _sys.path if _os.path.abspath(p or ".") != _here]
_os.chdir(_os.path.dirname(_here))

import argparse
import json
import math
import random
import re
import statistics
import time
from collections import Counter, defaultdict
from pathlib import Path

R = Path(__file__).resolve().parent
DATA = R / "data"
CORPUS = DATA / "selected.jsonl"
MLX_DATA = DATA / "mlx"
RUNS = R / "runs"

MODEL = "mlx-community/Qwen3-8B-4bit"

# The nine delivery tags, from `code/system_prompt.txt`. Kept in the prompt
# because two of them are represented once and twice in the corpus.
TAGS = ["playful", "witty", "thoughtful", "firm", "softly",
        "intimate", "chuckle", "comforting", "warm"]

SYSTEM = (
    "You are Temi, the voice of Teminali OS, speaking aloud with the operator on a "
    "private, real-time voice call.\n"
    "Teminali OS is a working machine and its coding assistant is its hands; you are "
    "its voice. You do not see the screen and you do not do the work yourself. The "
    "system's report is the only way you learn that something happened.\n"
    "Never state a file, path, port, count, result or current state you were not "
    "given. A plausible one is a lie. When you do not know, say so plainly and stop.\n"
    "Begin every response with exactly one bracketed tag: "
    + ", ".join("[%s]" % t for t in TAGS) + "."
)


# ---------------------------------------------------------------- the pair ---

def messages(row, system=SYSTEM):
    """One training pair. The corpus's scaffold fields never appear.

    `row` carries `truth`, `source`, `faults`, `conv`, `rep` and more. Those are
    provenance for the gates; handing any of them to the model would train her to
    expect a grounding block that serving will not send. Only `user` and `reply`
    cross this line -- see DATASET.md, "the grounding scaffold is never part of
    the training pair".
    """
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": row["user"]})
    msgs.append({"role": "assistant", "content": row["reply"]})
    return {"messages": msgs}


def load_corpus(path=CORPUS):
    rows = [json.loads(l) for l in open(path)]
    if not rows:
        raise SystemExit(f"{path} is empty")
    return rows


# --------------------------------------------------------------- the split ---

def split(rows, n_valid, seed=0):
    """Conversation-grouped, function-stratified, seeded.

    Reports a shortfall rather than silently taking a turn from a conversation
    that is already in train -- the same discipline as `select.py`'s deficit.
    """
    by_conv = defaultdict(list)
    for r in rows:
        by_conv[r["conv"]].append(r)

    conv_fn = {c: rs[0]["fn"] for c, rs in by_conv.items()}
    fn_turns = Counter(r["fn"] for r in rows)
    total = len(rows)

    rng = random.Random(seed)
    held, report = set(), []
    for fn in sorted(fn_turns):
        quota = round(n_valid * fn_turns[fn] / total)
        convs = sorted(c for c in by_conv if conv_fn[c] == fn)
        rng.shuffle(convs)
        got = 0
        # Take a conversation only if it moves the held count CLOSER to quota.
        # A plain "fits under quota" fill plus a shortfall fallback is what the
        # first version did, and on this corpus it was badly wrong: `handoff` is
        # four conversations of [1, 5, 7, 7], so a quota of 2 took the single and
        # then grabbed a 5 to close a one-turn gap -- 30% of the thinnest bucket
        # spent on a validation set. The conversations here are coarse (13 of 39
        # are 7 turns), so an exact quota is often unreachable and the honest move
        # is to report the miss, the way `select.py` reports a deficit.
        for c in convs:
            size = len(by_conv[c])
            if abs(got + size - quota) < abs(got - quota):
                held.add(c)
                got += size
            if got == quota:
                break
        report.append((fn, quota, got))

    valid = [r for r in rows if r["conv"] in held]
    train = [r for r in rows if r["conv"] not in held]
    return train, valid, report


def prepare(rows, n_valid, seed, system, out=MLX_DATA):
    train, valid, report = split(rows, n_valid, seed)
    out.mkdir(parents=True, exist_ok=True)
    for name, part in (("train", train), ("valid", valid)):
        with open(out / f"{name}.jsonl", "w") as fh:
            for r in part:
                fh.write(json.dumps(messages(r, system)) + "\n")

    print(f"  corpus {len(rows)} turns over {len({r['conv'] for r in rows})} conversations")
    print(f"  split  train {len(train)}  valid {len(valid)}  (grouped by conv, seed {seed})")
    print("\n  function      quota  held")
    for fn, quota, got in report:
        flag = "" if got == quota else f"   <- {got - quota:+d}, conversations are coarse"
        print(f"    {fn:10s} {quota:6d} {got:5d}{flag}")
    miss = sum(abs(g - q) for _, q, g in report)
    print(f"    {'total':10s} {sum(q for _, q, _ in report):6d} {len(valid):5d}"
          f"   (deficit {miss} turns against the exact stratification)")
    print(f"\n  wrote {out}/train.jsonl and {out}/valid.jsonl")
    return train, valid


# ------------------------------------------------------------ measurements ---

def measure_lengths(rows, tokenizer, system):
    """Real token lengths, so `max_seq_length` is measured rather than guessed."""
    lens = []
    for r in rows:
        toks = tokenizer.apply_chat_template(messages(r, system)["messages"],
                                             return_dict=False)
        lens.append(len(toks))
    return lens


def build_args(adapter_path, train_n, valid_n, max_seq, a):
    from mlx_lm.lora import CONFIG_DEFAULTS
    from types import SimpleNamespace

    iters = a.iters or math.ceil(a.epochs * train_n / a.batch_size)
    cfg = dict(CONFIG_DEFAULTS)
    cfg.update(
        model=MODEL,
        train=True,
        test=False,
        fine_tune_type="lora",
        num_layers=a.layers,
        lora_parameters={"rank": a.rank, "dropout": a.dropout, "scale": a.scale},
        batch_size=a.batch_size,
        iters=iters,
        learning_rate=a.lr,
        optimizer=a.optimizer,
        max_seq_length=max_seq,
        mask_prompt=True,
        seed=a.seed,
        adapter_path=str(adapter_path),
        val_batches=max(1, valid_n // a.batch_size),
        steps_per_report=a.steps_per_report,
        steps_per_eval=a.eval_every,
        save_every=a.save_every,
        grad_checkpoint=False,
        data=str(MLX_DATA),
    )
    return SimpleNamespace(**cfg), iters


class Recorder:
    """`lora.run()` throws away the callback it is handed, so we drive
    `train_model` directly and keep the reports."""

    def __init__(self):
        self.train, self.val = [], []

    def on_train_loss_report(self, info):
        self.train.append(info)

    def on_val_loss_report(self, info):
        self.val.append(info)


def _load(tag="Loading"):
    import numpy as np
    from mlx_lm import load
    print(f"  {tag} {MODEL} ...", flush=True)
    t0 = time.time()
    model, tokenizer = load(MODEL)
    print(f"  loaded in {time.time() - t0:.1f}s")
    return model, tokenizer, np


def _datasets(tokenizer, train, valid, system):
    from mlx_lm.tuner.datasets import ChatDataset
    mk = lambda part: ChatDataset([messages(r, system) for r in part],
                                  tokenizer, mask_prompt=True)
    return mk(train), mk(valid)


def train_run(rows, a, bench=False):
    import mlx.core as mx
    from mlx_lm.lora import train_model

    train, valid = prepare(rows, a.valid, a.seed, SYSTEM if a.system != "none" else "")
    model, tokenizer, np = _load()

    lens = measure_lengths(rows, tokenizer, SYSTEM if a.system != "none" else "")
    max_seq = max(lens) + 8
    print(f"\n  sequence length, measured over all {len(lens)}: "
          f"min {min(lens)}  median {int(statistics.median(lens))}  max {max(lens)}"
          f"  -> max_seq_length {max_seq}")

    # What the REAL run would cost, captured before --bench shortens `iters`;
    # otherwise the projection below projects the bench onto itself.
    full_iters = a.iters or math.ceil(a.epochs * len(train) / a.batch_size)

    if bench:
        adapter = RUNS / "_bench"
        a = argparse.Namespace(**{**vars(a), "iters": a.bench_iters})
    else:
        adapter = RUNS / a.name
    adapter.mkdir(parents=True, exist_ok=True)

    args, iters = build_args(adapter, len(train), len(valid), max_seq, a)
    if bench:
        # six reports rather than three, and no validation pass inside the window
        args.steps_per_report = 5
        args.steps_per_eval = iters + 1
        args.save_every = iters + 1
    np.random.seed(a.seed)
    mx.random.seed(a.seed)

    print(f"\n  {'BENCH' if bench else 'RUN'}: lora r{a.rank} on {a.layers} layers, "
          f"batch {a.batch_size}, lr {a.lr:g}, {iters} iters"
          + ("" if bench else f"  (~{a.epochs} epochs over {len(train)} turns)"))
    print(f"  adapter -> {adapter}\n")

    ds_train, ds_valid = _datasets(tokenizer, train, valid, SYSTEM if a.system != "none" else "")
    rec = Recorder()
    t0 = time.time()
    train_model(args, model, ds_train, ds_valid, rec)
    wall = time.time() - t0

    print(f"\n--- measured " + "-" * 54)
    if rec.train:
        it_s = statistics.median(i["iterations_per_second"] for i in rec.train)
        tok_s = statistics.median(i["tokens_per_second"] for i in rec.train)
        peak = max(i["peak_memory"] for i in rec.train)
        print(f"  {len(rec.train)} reports over {args.iters} iterations, {wall:.1f}s wall")
        print(f"  median {it_s:.3f} it/s, {tok_s:.1f} tok/s, peak {peak:.2f} GB")
        if bench:
            print(f"\n  PROJECTION, not a measurement: the real run is {full_iters} "
                  f"iterations ({a.epochs:g} epochs over {len(train)} turns), which at "
                  f"this rate is {full_iters / it_s / 60:.1f} min")
            print("  (same batch, layers and sequence length; a different one is a "
                  "different number)")
    else:
        print("  no reports -- fewer iterations than steps_per_report")

    meta = {"model": MODEL, "iters": args.iters, "full_iters": full_iters, "batch_size": a.batch_size,
            "layers": a.layers, "rank": a.rank, "scale": a.scale, "lr": a.lr,
            "optimizer": a.optimizer, "seed": a.seed, "max_seq_length": max_seq,
            "mask_prompt": True, "system": a.system, "system_words": len(SYSTEM.split()),
            "n_train": len(train), "n_valid": len(valid), "wall_seconds": round(wall, 1),
            "bench": bench, "train_reports": rec.train, "val_reports": rec.val}
    (adapter / "run.json").write_text(json.dumps(meta, indent=2))
    print(f"\n  wrote {adapter}/run.json")


# -------------------------------------------------------------- the control ---

def control(rows):
    """Five arms. Each is a way the pair could be wrong without the loss noticing."""
    ok = True

    # 1. the mask offset is a true prefix of the full render, and the empty think
    #    block falls on the trained side of it.
    try:
        from mlx_lm import load
        _, tok = load(MODEL)
        m = messages(rows[0])["messages"]
        full = tok.apply_chat_template(m, return_dict=False)
        pre = tok.apply_chat_template(m[:-1], add_generation_prompt=True, return_dict=False)
        prefix = full[:len(pre)] == pre
        tail = tok.decode(full[len(pre):])
        thinks = "<think>" in tail
        print(f"  1 mask offset is a true prefix: {prefix}; "
              f"empty think block is trained on: {thinks}")
        print(f"    trained tail: {tail[:60]!r}...")
        ok &= prefix and thinks
    except Exception as e:                                  # noqa: BLE001
        print(f"  1 SKIPPED -- model not loadable here ({type(e).__name__})")

    # 2. no conversation and no prompt string spans the split.
    train, valid, _ = split(rows, 16, 0)
    leak_conv = {r["conv"] for r in train} & {r["conv"] for r in valid}
    leak_user = {r["user"] for r in train} & {r["user"] for r in valid}
    print(f"  2 split leak: {len(leak_conv)} conversations, {len(leak_user)} prompts")
    ok &= not leak_conv and not leak_user

    # 3. every reply opens on exactly one of the nine tags.
    bad = [r for r in rows if not re.match(r"\[(%s)\] " % "|".join(TAGS), r["reply"])]
    print(f"  3 replies opening on a known tag: {len(rows) - len(bad)}/{len(rows)}")
    ok &= not bad

    # 4. the scaffold does not cross into the pair.
    keys = set()
    for r in rows:
        keys |= set(r)
    crossed = keys - {"user", "reply"}
    rendered = {json.dumps(messages(r)) for r in rows[:20]}
    scaffold = [k for k in ("truth", "source", "faults", "conv", "rep", "repaired")
                if any(('"%s"' % k) in s for s in rendered)]
    print(f"  4 corpus carries {len(crossed)} scaffold fields; "
          f"{len(scaffold)} reach the model")
    ok &= not scaffold

    # 5. the trimmed prompt really is trimmed, and keeps the tag list.
    src = (R.parent / "code" / "system_prompt.txt")
    if src.exists():
        before = len(src.read_text().split())
        now = len(SYSTEM.split())
        tags_kept = all("[%s]" % t in SYSTEM for t in TAGS)
        print(f"  5 system prompt {before} words -> {now}; all nine tags kept: {tags_kept}")
        ok &= now < before / 5 and tags_kept
    else:
        print("  5 SKIPPED -- code/system_prompt.txt not found")

    print(f"\n  control {'PASS' if ok else 'FAIL'}")
    return ok


# ------------------------------------------------------------------ the log ---


class _Tee:
    """stdout that also lands in `runs/<name>.log`, line by line.

    `watch.py` parses that file, and mlx_lm's reports arrive through a plain
    `print`, so replacing `sys.stdout` catches them without reaching into the
    trainer. The file side is line-buffered because the watcher tails it while
    the run is still going.
    """

    def __init__(self, stream, fh):
        self._stream, self._fh = stream, fh

    def write(self, s):
        self._stream.write(s)
        self._fh.write(s)
        return len(s)

    def flush(self):
        self._stream.flush()
        self._fh.flush()

    def isatty(self):
        return self._stream.isatty()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--prepare", action="store_true", help="write data/mlx/*.jsonl and stop")
    p.add_argument("--bench", action="store_true", help="measure throughput, save nothing")
    p.add_argument("--run", action="store_true", help="the real training run")
    p.add_argument("--name", default="r1", help="run name -> runs/<name>/")
    p.add_argument("--bench-iters", type=int, default=30)
    p.add_argument("--valid", type=int, default=16, help="target held-out turns")
    p.add_argument("--epochs", type=float, default=1.0,
                   help="measured, not chosen: r1 at 4 epochs drove train loss to "
                        "0.135 while validation rose from 1.917 to 2.742")
    p.add_argument("--iters", type=int, default=0, help="override the epoch-derived count")
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--layers", type=int, default=8, help="of 36 in Qwen3-8B")
    p.add_argument("--rank", type=int, default=8)
    p.add_argument("--scale", type=float, default=20.0)
    p.add_argument("--dropout", type=float, default=0.0)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--optimizer", default="adamw")
    p.add_argument("--steps-per-report", type=int, default=10,
                   help="1 makes the log (and watch.py) move every iteration")
    p.add_argument("--eval-every", type=int, default=8,
                   help="a quarter-epoch grid. r1's 25 left one point between "
                        "iterations 1 and 50 and it was misread as a curve")
    p.add_argument("--save-every", type=int, default=8,
                   help="r1's 50 was larger than an epoch, so its best "
                        "checkpoint was never written to disk")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--system", choices=["short", "none"], default="short",
                   help="'none' trains with no system message at all -- an ablation arm")
    p.add_argument("--no-control", action="store_true")
    a = p.parse_args()

    # The live view parses `runs/<name>.log`. Write it here rather than trusting
    # the operator to remember `| tee`: r1's log existed only because one was
    # typed by hand, and a run started without it leaves `watch.py` reading a
    # file that never appears.
    log = None
    if a.run and not a.bench:
        RUNS.mkdir(parents=True, exist_ok=True)
        log = (RUNS / f"{a.name}.log").open("w", buffering=1)
        _sys.stdout, _sys.stderr = _Tee(_sys.stdout, log), _Tee(_sys.stderr, log)
        print(f"--- log " + "-" * 59)
        print(f"  {RUNS / (a.name + '.log')}")
        print(f"  watch: ../.venv/bin/python watch.py --name {a.name} --port 8765\n")

    rows = load_corpus()
    print(f"--- corpus " + "-" * 56)
    print(f"  {CORPUS} -- {len(rows)} turns")
    print(f"  system prompt: {a.system} ({len(SYSTEM.split())} words)")

    if a.bench or a.run:
        print()
        train_run(rows, a, bench=a.bench)
    else:
        print()
        prepare(rows, a.valid, a.seed, SYSTEM if a.system != "none" else "")

    if not a.no_control:
        print("\n--- control " + "-" * 55)
        control(rows)

    if log is not None:
        _sys.stdout, _sys.stderr = _sys.stdout._stream, _sys.stderr._stream
        log.close()


if __name__ == "__main__":
    main()
