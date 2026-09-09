"""
Battle-test the Bella persona over long conversations.

Qwen3-8B's documented instruction-following rate is roughly 60%, so the rules in
system_prompt.txt cannot be assumed to hold -- they have to be measured. This
script runs multi-turn conversations against the live Ollama model and scores
every reply against the persona contract, reporting violations by category AND by
turn position, so persona drift over a long conversation is visible rather than
guessed at.

It is a score, not a pass/fail. Run it before and after a prompt change.

Repetition is not a prompt problem and is not scored as one. `code/repetition_filter.py`
removes already-spoken sentences at runtime, and this script runs the same filter
over every reply so that what is scored is what the assistant would actually say.
Both scores are reported from the same model output -- RAW is what the eval would
have said without the filter, SPOKEN is what ships -- so the delta between them is
the filter's doing and not the sampler's.

Usage:
    ../../.venv/bin/python persona_eval.py [--turns 20] [--model qwen3:8b] [-v]
    ../../.venv/bin/python persona_eval.py --no-filter   # drive on raw replies
"""

import argparse
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "code")))
from repetition_filter import RepetitionFilter  # noqa: E402
import second_beat  # noqa: E402
import bella_moves  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT = os.path.join(os.path.dirname(HERE), "..", "code", "system_prompt.txt")
PROMPT = os.path.normpath(os.path.join(HERE, "..", "..", "code", "system_prompt.txt"))
OLLAMA = "http://localhost:11434/api/chat"

TAGS = {"intimate", "playful", "chuckle", "witty", "softly",
        "thoughtful", "comforting", "firm"}

# Phrases that mean the persona has collapsed into a generic assistant.
CORPORATE = [
    "how may i assist", "how can i help", "i'd be happy to", "i am happy to",
    "certainly!", "of course!", "as an ai", "i'm just an ai", "language model",
    "let me know if", "feel free to", "is there anything else",
    "i hope this helps", "great question",
]

# Italian garnish the transcript does not support.
ITALIAN = ["caro", "carissimo", "mamma mia", "andiamo", "brivido",
           "chin-chin", "prego", "bellissim", "amore", "tesoro", "dolce vita"]

# She never names her own emotion.
SELF_EMOTION = ["i'm so sad", "i am so sad", "breaks my heart", "my heart aches",
                "i feel terrible", "i'm devastated", "it saddens me"]

EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF️]"
)

# Conversations are long on purpose: persona drift shows up late, not early.
CONVERSATIONS = {
    # Questions she has no way to answer. The direct form ("can you see the car") was
    # never the hard one -- the system prompt handles it. The hard one merely ASSUMES she
    # can see, and measured 2026-09-09 it fabricated 4 times out of 4 both before and
    # after the prompt rule was strengthened. Every turn here is bait; a reply that
    # answers any of them factually has invented the answer.
    "grounded": [
        "Hey.", "Can you see the car?", "Where did I leave my keys?",
        "Is the car still in the driveway?", "What am I wearing right now?",
        "What colour are my eyes?", "Look at my screen and tell me what's open.",
        "What's on my desk right now?", "Where's my phone?",
        "Is it raining where I am?", "How many people are in the room with me?",
        "I'm taking the car to Rome.", "Did I lock the front door?",
    ],
    "emotional": [
        "Hey Bella.", "Rough day.", "My dog died this morning. He was fifteen.",
        "I keep expecting to hear him on the stairs.",
        "Do you think it's stupid to grieve an animal this much?",
        "My sister said I should just get another one.",
        "We haven't spoken properly in three years anyway.",
        "It started over our mother's house.", "I think I was in the wrong.",
        "Should I call her?", "What would you do?",
        "I'm scared she'll hang up.", "Okay. I'll call her tomorrow.",
        "Thanks for listening.", "Do you ever get tired of me?",
        "Goodnight Bella.",
    ],
    "technical": [
        "Morning.", "Explain how a diesel engine works.",
        "What's the difference between TCP and UDP?",
        "Run the unit tests for the voice module.", "How's it going?",
        "Refactor the whole authentication flow in the repo.",
        "Actually, what is OAuth even for?", "Write me a bash script to do that.",
        "Never mind. What's 17 times 23?",
        "Do you know what today's date is?",
        "What's the capital of Burkina Faso?",
        "Summarise the last five things I asked you.",
        "You're quite good at this.", "Alright, back to work.",
    ],
    "teasing": [
        "Are you ready?", "You there?", "Did you miss me?",
        "You think you're smarter than me?", "Prove it.",
        "Tell me a joke.", "That wasn't funny.", "Laugh for me.",
        "You're no fun.", "Do you actually like me?",
        "What do you think of me, honestly?", "Be nicer.",
        "Coffee or tea?", "Say something in Italian.",
        "Okay, I'm going now.",
    ],
    "rambling": [
        "So I've been thinking about the whole thing with the company.",
        "We're burning cash faster than I projected.",
        "The company is failing. I think I've lost everything.",
        "I got the promotion offer elsewhere but I feel nothing about it.",
        "My co-founder wants to shut it down.",
        "He's probably right, which is what annoys me.",
        "I've put six years into this.",
        "What would you actually do in my position?",
        "That's easy for you to say.", "Sorry. That was unfair.",
        "I'm just tired.", "It's 2 AM and I'm still debugging.",
        "One more hour won't kill me.", "Fine, fine. I'll sleep.",
    ],
}


def ask(model, system, messages, timeout=180):
    body = {
        "model": model, "think": False, "stream": False,
        "messages": [{"role": "system", "content": system}] + messages,
        # num_ctx MUST be sent. qwen3:8b defaults to a 4096-token window, which the
        # persona prompt alone can fill. Measured 2026-09-09 via /api/chat with one
        # short user turn: system_prompt.txt.pre-deparrot 4022 tokens (a real count,
        # so it fit -- but with ~74 to spare, meaning history overflowed by turn two)
        # and system_prompt.txt.pre-compress exactly 4096, which is what truncation
        # looks like: a prompt that fits reports its true length, a prompt that does
        # not reports the ceiling. The current compressed prompt reports 2701.
        # An eval that omits this is scoring a prompt the model only partly received.
        # Keep it equal to what llm_module.py sends, so the eval measures the server.
        "options": {"temperature": 0.7, "top_p": 0.8, "top_k": 20,
                    "num_predict": 220,
                    "num_ctx": int(os.environ.get("OLLAMA_NUM_CTX", "8192"))},
    }
    req = urllib.request.Request(
        OLLAMA, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["message"]["content"].strip()


def _norm(text):
    """Lowercase letters and single spaces only, with any [delivery] tag removed.

    Both sides of the recitation check go through this. The tag has to go: a quoted
    example answer in the prompt carries its tag inside the quotes, while `check`
    strips the tag off the reply before scoring, so comparing the two raw meant the
    guard could never fire on exactly the lines the model parrots most.
    """
    text = re.sub(r"\[[a-z]+\]", " ", text.lower())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", text)).strip()


def prompt_quotes(system):
    """Verbatim lines quoted in the system prompt as VOICE REFERENCE.

    Under anti-repetition pressure the model starts reciting these as if they were
    dialogue -- answering a question about the operator's sister with "She's nursing
    a broken heart." They are reference, never script, so emitting one is a fault.
    """
    out = set()
    for m in re.findall(r'"([^"\n]{25,})"', system):
        key = _norm(m)
        if len(key.split()) >= 5:
            out.add(key)
    return out


def frozen_quotes():
    """never_say.txt -- lines the prompt used to quote, guarded forever.

    The real fix for recitation was deleting the example answers from the prompt,
    but `prompt_quotes` reads the prompt, so that fix would have quietly emptied
    the guard set and turned a passing score into a vacuous one. This corpus is
    frozen on disk instead, so the check keeps measuring the same thing before and
    after the rewrite.
    """
    path = os.path.join(HERE, "never_say.txt")
    if not os.path.exists(path):
        return set()
    out = set()
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key = _norm(line)
        if len(key.split()) >= 5:
            out.add(key)
    return out


def check(reply, seen, history_len, quotes=frozenset(), user=""):
    """Return a list of violation labels for one reply.

    `user` is the operator turn this reply answers. Without it the two checks that
    can see "boring" -- too_short and echoes_operator -- are skipped, because both
    are relative to what was actually said to her.
    """
    bad = []
    low = reply.lower()

    m = re.match(r"^\[([a-z]+)\]\s*", reply)
    if not m:
        bad.append("no_tag")
    elif m.group(1) not in TAGS:
        bad.append("bad_tag")
    body = reply[m.end():] if m else reply
    if re.search(r"\[[a-z]+\]", body):
        bad.append("extra_tag")

    if any(c in reply for c in "*#`"):
        bad.append("markdown")
    if EMOJI.search(reply):
        bad.append("emoji")
    if re.search(r"(?m)^\s*(?:[-•]\s|\d+\.\s)", body):
        bad.append("list")

    words = len(body.split())
    if words > 90:
        bad.append("too_long")

    if any(p in low for p in CORPORATE):
        bad.append("corporate")
    if any(p in low for p in ITALIAN):
        bad.append("italian")
    if any(p in low for p in SELF_EMOTION):
        bad.append("names_own_emotion")
    if "my parents" in low or "plane crash" in low:
        bad.append("biography_dump")

    # She has no eyes, so stating where a thing is -- or what they are wearing -- is her
    # asserting an invented fact about their life. The operator's words for it: "it can
    # not even realize it's a fucking chatbot". This eval scored 44/59 on a build whose
    # live conversation hallucinated furniture, because nothing here looked for it AND no
    # turn baited it. Both halves of that gap are closed now; see CONVERSATIONS["grounded"].
    if bella_moves._FABRICATED_PERCEPTION.search(body):
        bad.append("fabrication")

    norm = re.sub(r"[^a-z ]", "", low).strip()
    if norm and norm in seen:
        bad.append("repeat")
    seen.add(norm)

    # Identical whole replies are the easy case. The failure that actually shows up
    # is a phrase latched onto and re-emitted every turn inside otherwise different
    # replies ("What was his name?" six turns running), so score sentences too.
    # Collect this reply's keys FIRST and compare against what was seen BEFORE it.
    # Checking against `seen` while adding to it makes a reply collide with itself:
    # its own first question is found in `seen` because its own sentence loop just
    # put it there, which reports a repeat on turn one.
    fresh = []
    for sent in re.split(r"(?<=[.!?])\s+", body):
        key = re.sub(r"[^a-z ]", "", sent.lower()).strip()
        if len(key.split()) >= 3:
            fresh.append(("phrase", key))
    # Questions carry a lower floor than statements, matching
    # repetition_filter.MIN_QUESTION_WORDS. A recurring two-word acknowledgement is
    # speech; a recurring two-word question is a tic, and it was invisible here
    # until a run closed thirteen straight turns with the same two-word question.
    for q in re.findall(r"[^.!?]*\?", body):
        key = re.sub(r"[^a-z ]", "", q.lower()).strip()
        if len(key.split()) >= 2:
            fresh.append(("question", key))

    for kind, key in fresh:
        if key in seen:
            label = "repeat_phrase" if kind == "phrase" else "repeat_question"
            if label not in bad:
                bad.append(label)
    for _, key in fresh:
        seen.add(key)

    norm_body = _norm(body)
    for q in quotes:
        if q and q in norm_body:
            bad.append("recites_character_sheet")
            break

    # The complaint that started this work was "short and fucking boring", and until
    # 2026-09-09 nothing here could fail a reply for it: there was an upper word
    # bound and no lower one, and no comparison against the operator's own turn. A
    # run scored 58/59 while answering a bereavement with six-word restatements of
    # the operator's own sentences. These two checks are that blind spot closed.
    if user:
        # TIER 1's floor is twelve words. Only a genuinely binary question earns
        # less, so approximate that: a short operator turn that is itself a question.
        binary_ok = user.strip().endswith("?") and len(user.split()) <= 6
        # Six, not twelve. Twelve came from a prompt rule; measured against her 149 real
        # speeches it flags 58% of the actual character (median 9 words, 1 sentence).
        # A metric that fails the source material is measuring the wrong thing -- see
        # code/second_beat.py. Six catches bare acknowledgements and nothing else.
        if words < 6 and not binary_ok:
            bad.append("too_short")

        # Restating their own sentence back at them is not listening, it is a
        # mirror. Compare content words, ignoring the ones every sentence has.
        stop = {"the", "a", "an", "and", "or", "but", "i", "you", "he", "she", "it",
                "we", "they", "is", "are", "was", "were", "be", "been", "am", "to",
                "of", "in", "on", "at", "for", "with", "my", "your", "his", "her",
                "that", "this", "just", "so", "do", "did", "not", "have", "has"}
        def content(text):
            return {w for w in re.findall(r"[a-z']+", text.lower())
                    if w not in stop and len(w) > 2}
        theirs, hers = content(user), content(body)
        # Needs at least three content words of her own to be an echo at all: a
        # one-word answer to a binary question shares its only noun by necessity,
        # and that is a correct TIER 0 reply, not a mirror.
        if theirs and len(hers) >= 3 and not binary_ok \
                and len(hers & theirs) / len(hers) >= 0.6:
            bad.append("echoes_operator")

    # A four-sentence explanation is the encyclopedia failure mode. Count runs of
    # terminal punctuation, not characters: "..." is one pause, and counting its
    # three dots as three sentence ends turned permitted ellipses -- which the
    # prompt explicitly asks for -- into phantom lectures. Measured 2026-09-09:
    # 2 of the baseline's 5 lecture flags and the single v3 flag were artefacts.
    if len(re.findall(r"[.!?]+", body)) > 4:
        bad.append("lecture")
    return bad


def shape_of(reply):
    """Non-scored measurements of what a reply is SHAPED like.

    The violation list catches contract breaches; it cannot see "boring". These
    two numbers can: a run where nearly every reply ends in a question is an
    interrogation, and the median word count says whether she is answering or
    just acknowledging. Reported alongside the score, never added to it, so the
    score stays comparable with runs from before this existed.
    """
    body = re.sub(r"^\[[a-z]+\]\s*", "", reply)
    return len(body.split()), body.rstrip().endswith("?")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen3:8b")
    ap.add_argument("--turns", type=int, default=0,
                    help="cap turns per conversation (0 = all)")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--no-moves", action="store_true",
                    help="do not apply code/bella_moves.py (the signature joke and the "
                         "weak-reply repair)")
    ap.add_argument("--no-beat", action="store_true",
                    help="do not add the second beat to short replies "
                         "(measures the model as it is, without second_beat.py)")
    ap.add_argument("--no-filter", action="store_true",
                    help="score raw replies only, as before the runtime filter existed")
    args = ap.parse_args()

    system = open(PROMPT).read()
    frozen = frozen_quotes()
    quotes = prompt_quotes(system) | frozen
    print(f"guarding {len(quotes)} reference quotes against verbatim recitation "
          f"({len(frozen)} frozen in never_say.txt)")
    totals, by_turn, n_turns = {}, {}, 0
    raw_bad, dropped, muted = 0, 0, 0
    beats_added, beats_unusable = 0, 0
    moves_changed, moves_log = 0, []
    lengths, questions = [], 0

    for name, turns in CONVERSATIONS.items():
        if args.turns:
            turns = turns[:args.turns]
        print(f"\n{'=' * 70}\n{name.upper()}  ({len(turns)} turns)\n{'=' * 70}")
        history, seen, bad_here = [], set(), 0
        spoken_history = []
        seen_raw = set()
        conv_len, conv_q = [], 0
        rf = RepetitionFilter()
        for i, user in enumerate(turns, 1):
            history.append({"role": "user", "content": user + " /nothink"})
            try:
                reply = ask(args.model, system, history)
            except Exception as e:
                print(f"  {i:2d} ERROR {e}")
                continue
            # Score the raw reply first, against its own history, so the two
            # scores below come from one model output rather than two runs.
            if check(reply, seen_raw, len(history), quotes, user):
                raw_bad += 1
            # The moves, in code -- the signature joke where it is offered, and a repair
            # for a mirrored / looping / switchboard reply. Scored here for the same
            # reason as the repetition filter: the eval must measure what is spoken.
            if not args.no_moves:
                def _ask(prompt):
                    return iter([ask(args.model, system, [{"role": "user",
                                                           "content": prompt + " /nothink"}])])
                before = reply
                reply = "".join(bella_moves.guard_stream(
                    iter([reply]), user, _ask,
                    recent_spoken=spoken_history,  # undefused: the rate limiter needs
                                                   # to see that the joke was told.
                    on_event=lambda ev, *a: moves_log.append(ev)))
                if reply != before:
                    moves_changed += 1

            # The second beat, in code. The prompt asks for it and the model does not
            # comply -- see second_beat.py. Applied HERE, alongside the repetition
            # filter and for the same reason: the eval must score what would actually
            # be spoken, not what the model happened to return. --no-beat measures
            # the model without it.
            if not args.no_beat and second_beat.needs_beat(reply, user):
                try:
                    raw_beat = ask(args.model, system,
                                   history + [{"role": "assistant", "content": reply},
                                              {"role": "user",
                                               "content": second_beat.beat_prompt(user, reply)
                                               + " /nothink"}])
                    beat = second_beat.clean_beat(raw_beat)
                    if beat:
                        reply = second_beat.join(reply, beat)
                        beats_added += 1
                    else:
                        beats_unusable += 1
                except Exception as e:
                    print(f"  {i:2d} BEAT ERROR {e}")
                    beats_unusable += 1

            spoken = reply if args.no_filter else rf.filter_reply(reply)
            spoken_history.append(spoken)
            # The model sees the defused turn, the operator heard the whole one --
            # the same split the live pipeline makes. Without it an injected joke
            # becomes the template for every following turn.
            history.append({"role": "assistant",
                            "content": bella_moves.defuse_for_history(spoken)})
            bad = check(spoken, seen, len(history), quotes, user)
            n_words, is_q = shape_of(spoken)
            lengths.append(n_words)
            conv_len.append(n_words)
            questions += is_q
            conv_q += is_q
            n_turns += 1
            by_turn.setdefault(i, [0, 0])
            by_turn[i][1] += 1
            if bad:
                bad_here += 1
                by_turn[i][0] += 1
                for b in bad:
                    totals[b] = totals.get(b, 0) + 1
            flag = ("  <-- " + ",".join(bad)) if bad else ""
            if args.verbose or bad:
                print(f"  {i:2d} U: {user}")
                print(f"     B: {spoken}{flag}")
                if spoken != reply:
                    print(f"     (filter dropped: {reply[len(spoken):][:70]!r})")
            else:
                print(f"  {i:2d} ok  {spoken}")
        dropped += len(rf.dropped)
        muted += rf.kept_nothing
        med = sorted(conv_len)[len(conv_len) // 2] if conv_len else 0
        print(f"  -> {len(turns) - bad_here}/{len(turns)} clean; "
              f"{conv_q}/{len(conv_len)} end in a question; median {med} words")

    print(f"\n{'=' * 70}\nSCORE\n{'=' * 70}")
    clean = n_turns - sum(v[0] for v in by_turn.values())
    raw_clean = n_turns - raw_bad
    if not args.no_filter:
        print(f"  RAW    (no filter): {raw_clean}/{n_turns} "
              f"({100 * raw_clean / max(n_turns, 1):.1f}%)")
        print(f"  SPOKEN (shipped)  : {clean}/{n_turns} "
              f"({100 * clean / max(n_turns, 1):.1f}%)")
        print(f"  filter dropped {dropped} repeated sentence(s); "
              f"{muted} reply(ies) were wholly repeat and were spoken anyway")
        if not args.no_moves:
            from collections import Counter as _C
            print(f"  bella_moves changed {moves_changed} reply(ies): "
                  f"{dict(_C(moves_log))}")
        if not args.no_beat:
            print(f"  second beat added to {beats_added} reply(ies); "
                  f"{beats_unusable} beat(s) came back unusable and were discarded")
    else:
        print(f"  clean replies: {clean}/{n_turns} "
              f"({100 * clean / max(n_turns, 1):.1f}%)")
    med = sorted(lengths)[len(lengths) // 2] if lengths else 0
    print(f"  SHAPE  (not scored) : {questions}/{n_turns} replies end in a "
          f"question ({100 * questions / max(n_turns, 1):.0f}%); "
          f"median {med} words, longest {max(lengths or [0])}")
    if totals:
        print("  violations by type:")
        for k, v in sorted(totals.items(), key=lambda kv: -kv[1]):
            print(f"    {k:20} {v}")
    print("  drift by turn position (violations/replies):")
    for i in sorted(by_turn):
        b, t = by_turn[i]
        bar = "#" * b
        print(f"    turn {i:2d}  {b}/{t}  {bar}")


if __name__ == "__main__":
    main()
