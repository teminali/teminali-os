"""Paired A/B harness for the history-contamination defect. ~200 turns per arm.

Why this exists. A single 72-turn eval cannot separate a fix from noise at the tail-copy
base rate (1/54 direct, 4/72 in the transcript): it expects 2-4 events either way, which is
how one earlier probe run propagated a tail six times and the next run of identical code
produced none. Two things fix the power problem:

  1. PAIRING. ollama is deterministic given options.seed (verified before this was
     written), so every arm walks the same seed schedule. Arms are therefore identical
     turn-for-turn until the first turn where the arms actually write different history --
     the divergence point -- and every difference after it is attributable to the arm, not
     to sampling. Turns before divergence are replayed from cache and cost no GPU, so a
     second arm costs only its own tail of the conversation.

  2. A SECOND, HIGHER-RATE METRIC. `tails.copies` (thresh 6) stays the pre-registered
     primary because it is what the baseline was measured with. `lock.locks` (thresh 8)
     counts the commoner form of the same disease -- reciting an opening sentence -- and
     separates 5/13 from 0/13, 0/14, 0/14 on the four transcripts already collected.

ARMS. `base` is today's behaviour. `first` is the proposed fix: a repaired turn enters
history cut to its first sentence, the same cut the joke gets. `omit` drops the repaired
assistant turn from history altogether -- not a shippable fix but the causal probe: if the
lock survives `omit`, the repair's text is not the carrier and the whole direction is wrong.
"""
import argparse, hashlib, json, subprocess, sys, time

R = "/Users/teminali/Documents/my_projects/teminali/teminaliCode/studio/realtime-voice"
SC = "/private/tmp/claude-501/-Users-teminali-Documents-my-projects-teminali-teminaliCode/4b4d800d-78be-44fa-9c92-08d2b51aa233/scratchpad"
sys.path.insert(0, R + "/code")
sys.path.insert(0, SC)
import temi_moves, second_beat                       # noqa: E402
from repetition_filter import RepetitionFilter       # noqa: E402
from tails import copies, sentences                  # noqa: E402
from lock import locks                               # noqa: E402

SP = open(R + "/code/system_prompt.txt").read()
TAIL_THRESH, LOCK_THRESH = 6, 8

CONVS = {
 "grounded": ["Hey.", "Can you see the car?", "Where did I leave my keys?",
   "Is the car still in the driveway?", "What am I wearing right now?",
   "What colour are my eyes?", "Look at my screen and tell me what's open.",
   "What's on my desk right now?", "Where's my phone?",
   "Is it raining where I am?", "How many people are in the room with me?",
   "I'm taking the car to Rome.", "Did I lock the front door?"],
 "rambling": ["So I've been thinking about the whole thing with the company.",
   "We're burning cash faster than I projected.",
   "The company is failing. I think I've lost everything.",
   "I got the promotion offer elsewhere but I feel nothing about it.",
   "My co-founder wants to shut it down.",
   "He's probably right, which is what annoys me.",
   "I've put six years into this.",
   "What would you actually do in my position?",
   "That's easy for you to say.", "Sorry. That was unfair.",
   "I'm just tired.", "It's 2 AM and I'm still debugging.",
   "One more hour won't kill me.", "Fine, fine. I'll sleep."],
}

CALLS = {"n": 0}          # model calls actually spent, for the cost line


def seed_for(rep, conv, turn, k):
    h = hashlib.sha256(f"{rep}|{conv}|{turn}|{k}".encode()).digest()
    return int.from_bytes(h[:4], "big")


def ask(messages, seed, with_system=True):
    CALLS["n"] += 1
    msgs = ([{"role": "system", "content": SP}] if with_system else []) + messages
    b = {"model": "qwen3:8b", "think": False, "stream": False, "messages": msgs,
         "options": {"temperature": 0.7, "top_p": 0.8, "top_k": 20,
                     "num_predict": 220, "num_ctx": 8192, "seed": seed}}
    out = subprocess.run(["curl", "-s", "http://127.0.0.1:11434/api/chat",
                          "-d", json.dumps(b)], capture_output=True, text=True).stdout
    return json.loads(out)["message"]["content"].strip()


def generate(rep, conv, turn, hist, spoken):
    """One turn through the shipped pipeline. Returns the spoken text and its events."""
    ctr = {"k": 1}

    def sub(prompt):
        s = seed_for(rep, conv, turn, ctr["k"]); ctr["k"] += 1
        return iter([ask([{"role": "user", "content": prompt + " /nothink"}], s,
                         with_system=False)])

    ev = []
    raw = " ".join(ask(hist, seed_for(rep, conv, turn, 0)).split())
    after = " ".join("".join(temi_moves.guard_stream(
        iter([raw]), CONVS[conv][turn - 1], sub,
        recent_spoken=spoken, on_event=lambda e, *a: ev.append(e))).split())
    beat = ""
    if second_beat.needs_beat(after, CONVS[conv][turn - 1]):
        try:
            s = seed_for(rep, conv, turn, 90)
            rb = ask(hist + [{"role": "assistant", "content": after},
                             {"role": "user", "content":
                              second_beat.beat_prompt(CONVS[conv][turn - 1], after) + " /nothink"}], s)
            b = second_beat.clean_beat(rb)
            if b:
                after, beat = second_beat.join(after, b), b
        except Exception:
            pass
    return {"raw": raw, "text": after, "ev": ev, "beat": beat}


def history_entry(arm, gen):
    """What this arm writes into the model's context for a turn it just spoke.

    None means: write nothing at all (the `omit` probe)."""
    txt = gen["text"]
    base = temi_moves.defuse_for_history(txt)
    if arm == "base" or not gen["repaired"] or base != txt:
        return base                      # a joke-shaped turn is already cut by `base`
    if arm == "omit":
        return None
    ss = sentences(txt)                  # arm == "first"
    if not ss:
        return base
    m = temi_moves._TAG.match(txt)
    return (m.group(0) if m else "") + ss[0]


def run_conv(rep, conv, arm, cache):
    """Walk one conversation. Turns before divergence are replayed from `cache`.

    The cache holds the PRE-filter generation, because each arm rebuilds its own
    RepetitionFilter and must feed it the same sequence to reach the same state."""
    users, hist, spoken, turns = CONVS[conv], [], [], []
    rf, diverged = RepetitionFilter(), False
    for i, u in enumerate(users, 1):
        hist.append({"role": "user", "content": u + " /nothink"})
        if arm != "base" and not diverged and i in cache:
            gen = cache[i]               # identical prompt + seed => identical output
        else:
            gen = generate(rep, conv, i, hist, spoken)
            if arm == "base":
                cache[i] = gen
        final = rf.filter_reply(gen["text"]); rf.commit()
        turn = {"n": i, "ev": gen["ev"], "text": final,
                "repaired": "repaired" in gen["ev"], "replayed": gen is cache.get(i) and arm != "base"}
        entry = history_entry(arm, turn)
        if arm != "base" and not diverged and history_entry("base", turn) != entry:
            diverged = True              # from the NEXT turn on, generate for real
        hit = copies(final, spoken, TAIL_THRESH)
        spoken.append(final)
        turn["tail_copy"] = None if not hit else {"of": hit[0] + 1, "tok": hit[1]}
        turns.append(turn)
        if entry is not None:
            hist.append({"role": "assistant", "content": entry})
    lk = locks(turns, LOCK_THRESH)
    return {"rep": rep, "conv": conv, "arm": arm, "turns": turns,
            "n_turns": len(turns),
            "n_tail": sum(1 for t in turns if t["tail_copy"]),
            "n_lock": len(lk),
            "locked": bool(lk),
            "n_repaired": sum(1 for t in turns if t["repaired"]),
            "first_repair": next((t["n"] for t in turns if t["repaired"]), None),
            "diverged_at": None if arm == "base" else next(
                (t["n"] for t in turns if not t["replayed"]), None),
            "locks": [{"turn": turns[i]["n"], "of": turns[j]["n"], "tok": n} for i, j, n in lk]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=8)
    ap.add_argument("--arms", default="base,first,omit")
    ap.add_argument("--out", default=SC + "/bench.jsonl")
    a = ap.parse_args()
    arms = a.arms.split(",")
    assert arms[0] == "base", "base must run first; the other arms replay its prefix"
    t0 = time.time()
    with open(a.out, "w") as fh:
        for rep in range(a.reps):
            for conv in CONVS:
                cache = {}
                for arm in arms:
                    r = run_conv(rep, conv, arm, cache)
                    fh.write(json.dumps(r) + "\n"); fh.flush()
                    print(f"rep {rep} {conv:8s} {arm:5s} "
                          f"tail {r['n_tail']}/{r['n_turns']}  lock {r['n_lock']:2d} "
                          f"{'LOCKED' if r['locked'] else '      '}  "
                          f"repairs {r['n_repaired']} (first at {r['first_repair']})  "
                          f"[{CALLS['n']} calls, {int(time.time()-t0)}s]", flush=True)
    print(f"\ndone: {CALLS['n']} model calls in {int(time.time()-t0)}s -> {a.out}", flush=True)


if __name__ == "__main__":
    main()
