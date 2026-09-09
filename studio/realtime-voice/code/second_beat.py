"""Give a too-short reply its second beat, in code rather than in the prompt.

THE COMPLAINT, in the operator's words: "short and fucking boring", and later "can she
be natural talk freely". The prompt already asks for this -- TIER 1 requires two
sentences and sets a twelve-word floor, the first answering and the second NOTICING
something. The model does not comply. Measured 2026-09-09 by resources/bella/persona_eval.py:
38 of 59 replies fell under the floor, median 6 words.

WHY NOT FIX IT IN THE PROMPT. It was tried twice and failed twice: a twelve-word floor
written into TIER 1, then the same floor restated in the TTS block alongside "PAIN GETS
PLAINER, NOT SHORTER" and an anti-mirror rule. The median stayed at 6. That matches this
repo's own measured doctrine -- anti-repetition also could not be prompted and had to
move into repetition_filter.py. Qwen3-8B's documented instruction-following rate is
around 60%, so a rule competing with a dozen others in a 2700-token prompt is not a
mechanism, it is a wish.

WHY A CONTINUATION RATHER THAN A RETRY. Re-asking for a whole better reply throws away
the first one and doubles the wait before she says anything. Asking her to ADD the
noticing sentence keeps the streamed first sentence exactly as it was -- the operator
hears the answer at the same moment as before -- and the beat arrives while she is
already speaking. It is also how the prompt describes her: answer, then notice.

WHAT IS DELIBERATELY LEFT ALONE:
  - A genuinely binary question earns a short answer. TIER 0 exists, and padding "Yes."
    into twelve words is the canned-assistant failure this is trying to avoid.
  - Grief. The prompt is explicit that pain makes her SHORTER, and that the plainness
    is what carries it. Lengthening a bereavement reply would be actively wrong.
"""

import re

# NOT a style target -- a floor for genuinely stunted replies only.
#
# This was 12, taken from a TIER 1 rule in system_prompt.txt. Measured 2026-09-09 against
# her 149 real speeches in Bella_Soranza_Dialogue_Season_2.txt, that number condemns the
# character: median 9 words, median 1 sentence, and a 12-word floor flags 58% of what she
# actually says. Even a floor of 8 flags 40%. She is short and she is magnetic anyway, so
# the operator's complaint -- "no emotional hooks, like a robot" -- was never about
# length, and padding toward a word count is what produces the machine shape it describes.
#
# Six sits below her median, so this now fires only on a bare acknowledgement with nothing
# in it, which is the one case that is genuinely a switchboard reply. Warmth is the
# prompt's job (THE FORMULAS); this is only a floor. Kept in sync with
# persona_eval.check()'s too_short -- if they diverge the eval stops measuring what ships.
WORD_FLOOR = 6

# A short operator question earns a short answer; this approximates TIER 0 the same way
# the eval does, so the two agree on which replies are exempt.
BINARY_MAX_WORDS = 6

# Pain gets shorter on purpose. If the operator's turn is about a loss, leave her alone
# -- the prompt's strongest instruction is that grief arrives as flat, ordinary, SHORT
# sentences and that the listener supplies the feeling.
_GRIEF = re.compile(
    r"\b(died|die|dead|death|passed away|funeral|grief|grieving|cancer|terminal|"
    r"hospice|miscarriage|suicide|killed|lost (my|her|his|our|their)\b)", re.I)


def is_binary(user_text):
    """A short question from the operator -- the one case a clipped reply is correct."""
    u = (user_text or "").strip()
    return u.endswith("?") and len(u.split()) <= BINARY_MAX_WORDS


def is_grief(user_text):
    return bool(_GRIEF.search(user_text or ""))


def word_count(reply):
    """Words she actually SAYS: the leading [delivery] tag is not spoken."""
    return len(re.sub(r"^\s*\[[a-z]+\]\s*", "", reply or "", flags=re.I).split())


def needs_beat(reply, user_text):
    """True when the reply is a switchboard answer that the prompt says needs a second beat."""
    if not (reply or "").strip():
        return False
    if is_binary(user_text) or is_grief(user_text):
        return False
    return word_count(reply) < WORD_FLOOR


def beat_prompt(user_text, reply):
    """The follow-up turn. Asks for ONE sentence and forbids the obvious failure modes.

    Phrased as a continuation of her own speech rather than as an instruction about
    her, because the model reliably answers instructions-about-her by describing her.
    """
    return (
        "You just said this, and it stopped too early:\n"
        f"    {reply.strip()}\n\n"
        f"They had said:\n    {(user_text or '').strip()}\n\n"
        "Add ONE more sentence, spoken by you, continuing straight on. It must NOTICE "
        "something -- about them, about the hour, about what they just told you, or "
        "about what you want to know next.\n\n"
        "PREFER A STATEMENT. Asked to notice something, the obvious move is to ask them "
        "a question, and a reply that ALWAYS ends in one is an interrogation. But never "
        "asking is just as cold: she is genuinely curious and roughly one reply in seven "
        "of hers is a question. So ask only when you actually want to know the answer, "
        "and let it be a plain noticing the rest of the time.\n\n"
        "Rules: do not repeat or rephrase what you just said. Do not restate their "
        "words back at them. No delivery tag, no offer of help, no 'let me know', no "
        "asking if there is anything else. Reply with that one sentence and nothing "
        "else -- no preamble, no quotes."
    )


def clean_beat(text):
    """Strip what the model adds despite being told not to; return '' if unusable."""
    if not text:
        return ""
    t = text.strip()
    t = re.sub(r"^\s*\[[a-z]+\]\s*", "", t, flags=re.I)   # a tag it was told not to add
    t = re.sub(r"^\s*[\"'“‘]|[\"'”’]\s*$", "", t).strip()
    t = t.split("\n")[0].strip()                           # first line only
    if not t or len(t.split()) < 3:
        return ""
    # A beat that is itself a service phrase is worse than no beat.
    if re.search(r"\b(let me know|anything else|happy to help|here (to|if) )", t, re.I):
        return ""
    return t


def join(reply, beat):
    """Attach the beat as a second sentence of the same turn."""
    if not beat:
        return reply
    left = (reply or "").rstrip()
    if left and left[-1] not in ".!?":
        left += "."
    return f"{left} {beat}".strip()


def stream_with_beat(chunks, user_text, ask_stream, on_event=None):
    """Yield the reply, then its second beat if the reply stopped too early.

    Sits INSIDE repetition_filter.wrap(), so a beat that repeats an earlier sentence is
    still caught -- and so the pipeline matches persona_eval.py, which adds the beat and
    then filters. If the two ever disagree the eval stops predicting what ships.

    The beat costs a second LLM round trip, but only on replies that need one and only
    AFTER the first sentence has already gone to TTS: she is speaking while it is
    fetched, so it does not delay the moment she starts. `ask_stream(prompt)` takes the
    follow-up prompt and returns a token iterator.
    """
    reply = ""
    try:
        for chunk in chunks:
            reply += chunk
            yield chunk
    finally:
        close = getattr(chunks, "close", None)
        if close:
            try:
                close()
            except Exception:
                pass

    if not needs_beat(reply, user_text):
        return

    try:
        raw = "".join(ask_stream(beat_prompt(user_text, reply)))
    except Exception:
        if on_event:
            on_event("beat_failed", reply, "")
        return

    beat = clean_beat(raw)
    if not beat:
        if on_event:
            on_event("beat_unusable", reply, raw)
        return

    # Emit the separator too: the caller is concatenating a token stream, and without
    # it the beat runs straight into the last word of the reply.
    lead = "" if reply.rstrip()[-1:] in ".!?" else "."
    if on_event:
        on_event("beat_added", reply, beat)
    yield f"{lead} {beat}"
