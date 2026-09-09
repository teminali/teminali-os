"""THE CARE THAT TURNS -- her signature joke, assembled in code.

    "Please drive carefully. If you hurt yourself, I'll kill you.
     But if you hurt the car, I'll kill your family."

That is the line the operator asked for by name, and it is the whole character in three
sentences: care, an absurd punishment for being harmed, then a graver one for harming an
object that ought to matter less. The joke is the INVERSION -- the car outranks the person
-- plus a flat delivery that never admits a joke is happening.

WHY THIS IS NOT IN system_prompt.txt. Three attempts were measured on 2026-09-09 against
qwen3:8b, and each failed differently:

  1. A prose description among eight other formulas -> never fired at all. It said "be
     careful" and stopped, on the single best trigger available.
  2. Slot templates written out as quoted phrases -> fired every time and recited the
     templates VERBATIM, in every conversation. At this size any speakable string in the
     prompt becomes output. That is also true of NEGATIVE examples: an anti-mirror rule
     that quoted the mistake made the model speak the quoted mistake at every turn.
  3. The same slots described abstractly with nothing sayable -> the decoder collapsed and
     repeated one clause eighteen times.

The repo already knew this. Anti-repetition could not be prompted and became
repetition_filter.py. A rule competing with a dozen others inside a 3700-token prompt, at a
documented ~60% instruction-following rate, is a wish rather than a mechanism.

A dedicated call with ONE job and a short prompt does not have that problem: nothing
competes with it, and the output is checked before it is spoken.
"""

import os
import re

import repetition_filter

# What she is protective about. Not a keyword list for its own sake -- these are the
# moments the joke belongs to: leaving, travelling, risking themselves, or handling
# something of hers.
_TRIGGER = re.compile(r"""
    \b(
      driv\w+ | drove | car | keys | bike | motorbike | ride | riding
    | fly\w* | flight | plane | train | road | motorway | highway
    | borrow\w* | taking\syour | take\syour | lend | lending
    | leaving | leave\snow | heading\s(out|off|home) | going\s(out|home|to)
    | tonight | late | drunk | drink\w* | tired | exhausted
    | dangerous | risky | climb\w* | ski\w* | swim\w*
    )\b
""", re.I | re.X)

# Default is disabled (0) for pure low-latency streaming without regex interception.
# Set TEMI_MOVES=1 to enable.
ENABLED = os.getenv("TEMI_MOVES", "0").lower() in ("true", "1", "yes")

# She does not joke about harm while they are actually hurt or grieving.
_NO_JOKE = re.compile(r"""
    \b(died|die|dead|death|funeral|grief|grieving|cancer|hospital|crash\w*ed|accident
      |hurt\smy|broke\smy|sick|ill|scared|afraid|terrified|fired|divorce\w*|lost\smy)\b
""", re.I | re.X)


def wants_care_that_turns(user_text, spoken_recently=()):
    """True when their turn is one this joke belongs to and it has not just been used."""
    if not ENABLED or not (user_text or "").strip():
        return False
    if _NO_JOKE.search(user_text):
        return False
    if not _TRIGGER.search(user_text):
        return False
    # It is devastating because it is rare. Twice in a conversation is a tic.
    return not any(_looks_like_the_joke(t) for t in spoken_recently)


# Curly apostrophes are what this model actually emits, and every regex here that spells
# an apostrophe was written with a straight one. Folding is therefore not cosmetic: it is
# the difference between a detector running and a detector silently never matching.
#
# Measured 2026-09-09, and it had been live the whole time: _looks_like_the_joke could not
# see "I\u2019ll", so the rate limiter that exists to keep the signature joke rare had NEVER
# fired in production. The joke went out three turns running and seeded the recitation
# cascade that defuse_for_history now contains. The same mistake was made twice more the
# same day -- once in the probe written to measure this defect, which read 0% while the
# defect ran at 92%. Fold at the boundary; do not spell apostrophes into new patterns.
_SMART = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})


def fold(text):
    """Model text as the regexes in this module expect to see it. Matching only -- never
    put the folded form into her mouth, it is not what the TTS should receive."""
    return (text or "").translate(_SMART)


def _looks_like_the_joke(text):
    t = fold(text).lower()
    return bool(re.search(r"\bif you\b.*\bi'?ll\b", t) and re.search(r"\bbut if\b", t))


def care_that_turns_prompt(user_text):
    """A single-purpose prompt. Nothing competes with it and nothing in it is speakable."""
    return (
        "They just said this to you:\n"
        f"    {user_text.strip()}\n\n"
        "You love this person. What follows is how you say so, and it must land as "
        "devotion rather than menace -- the size of the threat is the size of the worry, "
        "and that is the whole joke.\n\n"
        "Reply with exactly three short sentences. Invent all the wording yourself.\n"
        "Sentence 1: tell them to take care over the specific thing they just mentioned.\n"
        "Sentence 2: this one is about THEIR OWN BODY -- name a way they personally could "
        "be injured doing it, and say what you will do to THEM if that happens. It is "
        "absurd on purpose: you are punishing them for having been hurt, because you "
        "cannot stand the thought of it. Say it as flatly as a weather forecast.\n"
        "Sentence 3: begin with 'But'. This one is about the OBJECT, not their body -- "
        "name damage to the thing itself, and then name the price. The price is a "
        "PERSON: somebody in their life who had nothing to do with it -- their family, "
        "whoever they live with, whoever they would miss -- and you say what you will "
        "do to that person. Not to them. Not to their belongings, their plans, their "
        "trip or their money.\n\n"
        "THE CONTRAST IS THE JOKE: sentence 2 is about them being hurt, sentence 3 is "
        "about the object being hurt, and you react far more violently to the object. If "
        "both sentences describe damage to the object, you have not made the joke at all. "
        "Escalating by SIZE is not the joke either -- wrecking something bigger, ruining "
        "more of their plans, taking more of their things is still only aimed at them, "
        "and it does not count. The escalation is WHO PAYS: an innocent person pays for "
        "the object. "
        "Never explain it, never soften it, never signal that it is a joke, never use the "
        "word joke. No delivery tag, no preamble, no quotation marks. Three sentences.\n\n"
    )


# Harm TO their body, as against harm BY them to a thing. The distinction is the whole
# joke and it is easy to get wrong: "you hurt yourself" and "you hurt the car" share every
# word that matters, so matching on the verb alone marks both as bodily and rejects the
# real line. What separates them is WHAT IS HARMED -- a reflexive, a body part, or them
# ending up somewhere -- not who is doing it.
# Harm aimed back at THEM. Narrow on purpose: it is what sentence 3 must not do.
_BODILY_SELF = re.compile(r"""
    \b(
      yourself
    | your\s+(body|neck|skull|spine|face|back|head
              |legs?|arms?|wrists?|hands?|ribs?|bones?|knees?|shoulders?|ankles?|hips?)
    | you\s+(die|died|are\s+killed|get\s+killed|get\s+hurt|are\s+hurt|get\s+injured|
              crash|fall|fell|drown|freeze|bleed)
    )\b
""", re.I | re.X)

# Any bodily injury to them, however phrased. Measured 2026-09-09: three of twelve samples
# were rejected for "not about their body" while saying "if you break A leg" -- the
# possessive was the only thing missing, and sentence 2 is already framed as harm to them,
# so an article carries the same meaning. Rejecting those threw away correct jokes.
_BODILY = re.compile(r"""
    \b(
      yourself
    | your\s+(body|neck|skull|spine|face|back|head
              |legs?|arms?|wrists?|hands?|ribs?|bones?|knees?|shoulders?|ankles?|hips?)
    | (a|an|one|both|every|your\s+own)\s+
        (leg|arm|wrist|hand|rib|bone|knee|shoulder|ankle|hip|collarbone|finger|tooth)s?
    | you\s+(die|died|are\s+killed|get\s+killed|get\s+hurt|are\s+hurt|get\s+injured|
              crash|fall|fell|drown|freeze|bleed)
    | (hospital|a\s+ditch|a\s+coma|the\s+morgue|a\s+cast|crutches)
    )\b
""", re.I | re.X)

# Who the final threat must fall on: somebody other than them. That widening is what turns
# a nasty threat into the joke -- the object outranks their body, and the bill is settled
# with somebody innocent. Kept broad, because she invents the target from what they said.
_THIRD_PARTY = re.compile(r"""
    \b(
      your\s+(family|mother|father|mum|mom|dad|brother|sister|son|daughter|wife|husband
              |partner|girlfriend|boyfriend|friends?|dog|cat|children|kids|parents|people
              |cousin|uncle|aunt|nephew|niece|colleagues?|team)
    | everyone\s+you\s+(love|know)
    | (the|those)\s+people\s+you\s+love
    | your\s+whole\s+\w+
    | (the|your)\s+whole\s+(family|house|household|street|bloodline)
    | your\s+loved\s+ones
    | everyone\s+(at\s+home|in\s+your\s+(house|life))
    | the\s+people\s+(at\s+home|in\s+your\s+life)
    )\b
""", re.I | re.X)


# Both threats are hypothetical -- "if you break a leg", "you could break a leg". Measured
# 2026-09-09: requiring the literal word "if" threw away five of twelve otherwise perfect
# jokes, all of them the "you could ..." form. The structure being tested is a supposed
# harm followed by a consequence, not one particular conjunction.
_CONDITIONAL = re.compile(r"""
    \bif\b | \bwhen(ever)?\b | \bshould\s+you\b | \bin\s+case\b
  | \byou\s+(might|could|may|ever|somehow|end\s+up|manage\s+to)\b
""", re.I | re.X)


def valid_care_that_turns(text):
    """Reject anything that missed the structure, rather than speak a broken joke."""
    if not text:
        return ""
    t = re.sub(r"^\s*\[[a-z]+\]\s*", "", text.strip(), flags=re.I)
    t = re.sub(r"^[\"'“‘]|[\"'”’]$", "", t).strip()
    t = " ".join(t.split())
    sentences = [x for x in re.split(r"(?<=[.!?])\s+", t) if x.strip()]
    if len(sentences) != 3:
        return ""
    # The turn must actually turn: a conditional, then a second one introduced by "but".
    if not _CONDITIONAL.search(sentences[1]):
        return ""
    if not re.match(r"\s*but\b", sentences[2], re.I) or not _CONDITIONAL.search(sentences[2]):
        return ""
    # A looping decoder repeats a clause; refuse that outright.
    if len(set(s.lower() for s in sentences)) != 3:
        return ""
    if len(t.split()) > 60:
        return ""

    # THE CONTRAST IS THE JOKE, so enforce it rather than hope for it. The real line
    # weighs harm to THEM against harm to the CAR and reacts worse to the car; that
    # inversion is what makes it funny, and the first threat -- punishing them for being
    # injured -- is what makes it love rather than menace. Measured 2026-09-09: without
    # this check the model happily produced two sentences that were both about damage to
    # the object ("break a wheel" then "scratch the frame"), which has no inversion in it
    # and reads as a threat from a stranger. Rejecting is safe: the caller falls back to
    # her ordinary reply.
    if not _BODILY.search(sentences[1]):
        return ""
    # And the escalation must WIDEN, past them, onto people they love. That is the step
    # that turns a nasty threat into the joke: the object outranks their body, and the
    # bill is settled with somebody innocent. Without it the third sentence just punishes
    # them again, which is menace, not devotion -- the operator's own correction.
    if not _THIRD_PARTY.search(sentences[2]):
        return ""
    # Only now is it safe to ask whether sentence 3 struck a body, because with an innocent
    # named the bodily words describe harm to THEM -- "your mother's legs" is the joke
    # working, not the joke failing. What is banned is the threat curving back onto the
    # person being warned.
    if _BODILY_SELF.search(sentences[2]):
        return ""
    return t


# ---------------------------------------------------------------------------
# The general mechanism: repair a weak reply, wherever it happens
# ---------------------------------------------------------------------------
# A registry of keyword triggers -- one regex per formula -- would make her sharp on the
# handful of situations somebody thought to enumerate and no better anywhere else. That is
# the failure the operator named: "programmed to few use cases and do worse on others".
#
# So only THE CARE THAT TURNS gets a trigger, because it is an opportunity that must be
# taken rather than a fault to be fixed, and missing it costs the character its best joke.
#
# Everything else works the other way round. Let her answer normally, then look at what
# came back and ask one question of it: is this a reply, or is it a switchboard? The three
# failure modes below are the ones that can be detected in code without guessing at
# meaning, and each was observed in a real transcript on 2026-09-09. When one fires, a
# single focused regeneration asks for a move -- and if that comes back no better, the
# original is spoken unchanged. Nothing is ever made worse.
#
# This is why it generalises: the repair does not care what the conversation is about.

# She has no eyes, no camera, no idea where anything is. Claiming otherwise is the most
# damaging thing she does, because it is not a style flaw -- it is her asserting invented
# facts about the operator's room. Observed 2026-09-09, and it was the REPAIR that produced
# it: the operator said he was taking the car to Rome and the repaired reply came back
# "You left the keys on the table. The car's still here." Asked directly whether she could
# see the car, she said she could see the keys. The operator's words for the result:
# "it can not even realize it's a fucking chatbot".
#
# The repair prompt asks for a NOTICING, and with nothing to notice the model invents a
# room. So the ban is enforced here rather than merely requested in a prompt.
# Measured again 2026-09-09, after the prompt rule was in place: this pattern caught none
# of the four fabrications in a twelve-sample probe, and flagged two correct denials. It
# was matching verbs of perception, and she does not use them -- she states the invented
# fact flat ("You left them in the glove box", "It's in the garage"), which is the same lie
# with the seeing left out. So match the ASSERTION, not the vocabulary.
_FABRICATED_PERCEPTION = re.compile(r"""
    \b(
    # Sight of a THING. "I can see you're tired" is idiom and stays allowed, because what
    # follows the verb is a clause about them, not an object in a room. Denials cannot
    # match either: "can't see" and "don't see" put a negator where the verb must be.
      i\s+(can\s+|could\s+)?(see|saw|watch|am\s+watching|am\s+looking\s+at)\s+
        (the|your|a|an|it|them|those|these)\b
    | i'?m\s+(watching|looking\s+at|standing|sitting|here\s+with|next\s+to|holding)\b

    # Where a thing is, asserted as fact. This is the shape the keys hallucination took.
    | (you|they)\s+(left|dropped|put|forgot|stashed|parked|hung)\s+
        (it|them|those|these|the|your|my)\b
    | (it|they|that|he|she)\s*('s|'re|\s+is|\s+are|\s+was|\s+were)\s+(still\s+)?
        (still\s+|not\s+|never\s+)?(in|on|under|behind|next\s+to|by)\s+(the|your)\b
    | (the|your)\s+\w+(?:'s|'re|\s+(?:is|are|was|were))\s+(still\s+|not\s+|never\s+)?
        (here|there|outside|upstairs|downstairs|gone|missing
        |(in|on|under|behind|next\s+to)\s+(the|your)\s+\w+)\b

    # What they look like, which she has never been in a position to know.
    | (you'?re|you\s+are|you\s+look)\s+[^.!?]{0,24}?
        \b(wearing|dressed\s+in
          |in\s+(a|an|your)\s+(t-?shirts?|shirts?|jeans|dress|coat|jacket|jumper|sweater
                               |hoodie|suit|skirt|boots|shoes|trousers|pyjamas))\b
    )
""", re.I | re.X)

_SERVICE = re.compile(
    r"\b(let me know|anything else|happy to help|how (can|may) i (help|assist)"
    r"|i'?m here (to|if)|feel free to|hope (this|that) helps)\b", re.I)

_GREETING = re.compile(r"\b(hi|hey|hello|morning|afternoon|evening|night|ciao|goodnight|bye|thanks|thank you)\b", re.I)

_STOP = frozenset("""a an the and or but if then so as at by for in of on to with from is
am are was were be been being do does did have has had i you he she it we they me him her
us them my your his its our their this that these those what which who not no yes just
don't dont can't cant won't wont it's its i'm im you're youre""".split())


def _content(text):
    t = re.sub(r"^\s*\[[a-z]+\]\s*", "", (text or "").lower(), flags=re.I)
    return {w for w in re.findall(r"[a-z']+", t) if w not in _STOP and len(w) > 2}


def _sentences(text):
    t = re.sub(r"^\s*\[[a-z]+\]\s*", "", (text or "").strip(), flags=re.I)
    return [x.strip() for x in re.split(r"(?<=[.!?])\s+", t) if x.strip()]


def _all_already_said(reply, spoken_recently=()):
    """True when every trackable sentence in `reply` has already been spoken.

    This is deliberately the exact condition repetition_filter refuses to act on: when
    NOTHING survives its sift it returns the reply untouched, so it cannot mute her. The
    consequence was that total repetition -- the worst kind -- was the one kind that
    always passed. Measured 2026-09-09: the same sentence went out three turns running
    while partial repeats were being filtered correctly.
    """
    if not spoken_recently:
        return False
    def keys(text):
        out = set()
        for sentence in _sentences(text or ""):
            key = repetition_filter.normalise(sentence)
            if repetition_filter.is_tracked(key, repetition_filter.is_question(sentence)):
                out.add(key)
        return out
    said = set().union(*(keys(t) for t in spoken_recently)) if spoken_recently else set()
    mine = keys(reply)
    return bool(said) and bool(mine) and mine <= said


def weakness(reply, user_text, spoken_recently=()):
    """Name the fault in a reply, or '' if there is none. Detection only -- no judgement
    about meaning, because anything requiring that would need another model call."""
    if not (reply or "").strip():
        return ""
    reply = fold(reply)          # matching only; the caller keeps the original
    user_text = fold(user_text)
    sents = _sentences(reply)

    # 0. FABRICATION, and it is checked first because it outranks every other fault: this
    #    is not a style failure but her stating an invented fact about their life.
    #    Measured 2026-09-09 over two twelve-sample probes: the prompt rule stops the
    #    direct question ("can you see the car" -- 4/4 correct denials) and, once it was
    #    widened, appearance questions too. It never once stopped the question that merely
    #    ASSUMES sight -- "where did I leave my keys" fabricated 4 of 4, before and after.
    #    Prose in a system prompt was not going to win this, so it is enforced here.
    if _FABRICATED_PERCEPTION.search(reply):
        return "fabrication"

    # 0b. REPEAT. She has said all of this already. Ranked with fabrication rather than
    #     with the style faults below, and for the same reason: repetition_filter hands
    #     this exact case straight through, so nothing else in the system will catch it.
    if _all_already_said(reply, spoken_recently):
        return "repeat"

    # 1. LOOPING. A decoder that repeats one clause. Measured: eighteen identical
    #    sentences in a row when a prompt gave it no anchor.
    if len(sents) >= 3 and len(set(s.lower() for s in sents)) <= max(1, len(sents) // 2):
        return "looping"

    # 2. MIRROR. Their sentence handed back with the pronouns swapped. Observed as the
    #    single commonest failure of this model, and it reads as an echo, not an answer.
    #    A GREETING IS EXEMPT: answering "morning" with "morning" is what people do, and
    #    flagging it sent the repair after a reply that was already correct.
    hers, theirs = _content(reply), _content(user_text)
    # A GREETING IS EXEMPT, but only from the two faults it would falsely trip: answering
    # "morning" with "morning" is what people do, and a two-word greeting back is not a
    # switchboard reply. It is NOT exempt from the service phrase below -- returning ""
    # here made "I'm here to help" unreachable whenever the turn opened with a hello,
    # which is exactly the turn a model is most likely to say it on.
    greeting = bool(len((user_text or "").split()) <= 3 and _GREETING.search(user_text or ""))

    if not greeting:
        if theirs and hers and len(hers - theirs) == 0:
            return "mirror"
        if theirs and len(hers) >= 2 and len(hers & theirs) / len(hers) >= 0.75:
            return "mirror"

    # 3. SWITCHBOARD. A bare acknowledgement carrying nothing of her, or a service phrase,
    #    which is character death outright.
    if _SERVICE.search(reply):
        return "service phrase"
    if not greeting and len(hers) <= 1 and len(reply.split()) <= 5:
        return "switchboard"
    return ""


# Situation -> the move most likely to rescue it. Deliberately coarse: the point is to
# hand the regeneration ONE clear instruction rather than nine competing ones, not to
# classify the conversation correctly. A wrong-but-specific move still beats a mirror.
_MOVE_FOR = [
    (re.compile(r"\?\s*$"), "answer them, then notice one specific thing about them or "
                            "this moment and stop"),
    (re.compile(r"\b(you think|prove it|bet|smarter|wrong|no it|actually)\b", re.I),
     "grant their point fully and without grudging, then keep your own anyway"),
    (re.compile(r"\b(i'?m fine|it'?s fine|no problem|whatever|doesn'?t matter)\b", re.I),
     "deny it in one short sentence, then say the plain truth in a second, with nothing "
     "softening in between"),
    (re.compile(r"\b(tired|exhausted|late|can'?t sleep|still up|four|2 ?am)\b", re.I),
     "name in one flat sentence the thing they are doing to themselves, then stop"),
    (re.compile(r"\b(crash|error|bug|server|code|deploy|broken|failing|slow)\b", re.I),
     "answer the practical problem through what someone or something WANTS -- loyalty, "
     "habit, who is waiting for whom -- and make the answer actually correct"),
    (re.compile(r"\b(love|like me|miss|beautiful|kiss|want me|alone)\b", re.I),
     "say the true thing in the fewest possible words, with no cushioning and no hedge"),
    (re.compile(r"\b(your (office|room|place|work|house)|nice|lovely|impressive)\b", re.I),
     "praise the place or the work, then put them inside it as the one thing that does "
     "not belong there"),
]
_DEFAULT_MOVE = ("say what you actually notice about them or about what they just told "
                 "you, in one or two short sentences, and stop")


def move_for(user_text):
    user_text = fold(user_text)   # "doesn\u2019t matter" must reach the same branch as "doesn't"
    for pat, instruction in _MOVE_FOR:
        if pat.search(user_text or ""):
            return instruction
    return _DEFAULT_MOVE


# The generic repair asks for a NOTICING, and with nothing to notice that is precisely
# what makes her invent a room -- the keys-on-the-table hallucination came out of this
# prompt, not out of the base model. So a fabrication is never repaired by noticing
# something else; it is repaired by admitting the thing is not knowable.
_UNKNOWABLE_MOVE = ("tell them you have no way of knowing that, because you are a voice "
                    "on a call and not in the room with them, and then ask them for the "
                    "thing you would need to know")


_MOVE_BY_FAULT = {}   # populated below, once both moves exist

_REPEAT_MOVE = ("answer what they actually just asked, using none of the sentences you "
                "have already said in this conversation")


_MOVE_BY_FAULT.update({"fabrication": _UNKNOWABLE_MOVE, "repeat": _REPEAT_MOVE})

# For these two faults the ORIGINAL IS THE DEFECT, so the usual "fall back to what she
# said" is not a safe floor -- it is the bug. They get a second attempt before that.
_ORIGINAL_IS_THE_DEFECT = frozenset({"fabrication", "repeat"})


def repair_prompt(user_text, reply, fault):
    """One job, one instruction, nothing in it that can be spoken back."""
    return (
        f"They said:\n    {(user_text or '').strip()}\n\n"
        f"You began to answer:\n    {reply.strip()}\n\n"
        f"That answer fails: {fault}. Say it again properly.\n\n"
        f"This time: {_MOVE_BY_FAULT.get(fault) or move_for(user_text)}.\n\n"
        "You are a VOICE on a call. You have no eyes, no camera and no idea where they or "
        "their things are. Never say you can see, watch or hear anything, and never state "
        "where an object is or what it is doing -- you do not know and you would be making "
        "it up. Notice what they SAID and what it means, never a room.\n\n"
        "Use none of the words of your failed answer. Do not repeat their sentence back "
        "at them. One or two short sentences, no delivery tag, no preamble, no quotation "
        "marks, no offer of help. Speak only the replacement."
    )


_TAG = re.compile(r"^\s*\[([a-z]+)\]\s*", re.I)

# The leading [delivery] tag is not decoration: audio_module.apply_emotion_tag reads it and
# morphs the voice, and a reply without one loses her register entirely. Both move prompts
# forbid the model from writing a tag -- it inventing one is a separate failure -- so the
# tag has to be carried across by hand. Measured 2026-09-09: without this the eval showed
# 8 no_tag violations that the moves themselves had introduced.
CARE_TAG = os.getenv("TEMI_CARE_TAG", "firm")   # deadpan; the flatness is the joke


def _retag(new_text, source_text, fallback=None):
    """Put back the tag the original reply carried, or a stated fallback."""
    if _TAG.match(new_text or ""):
        return new_text
    m = _TAG.match(source_text or "")
    tag = m.group(1).lower() if m else fallback
    return f"[{tag}] {new_text}" if tag else new_text


def valid_repair(text, user_text, original, spoken_recently=()):
    """Accept only a repair that is actually better; otherwise keep the original."""
    if not text:
        return ""
    t = re.sub(r"^\s*\[[a-z]+\]\s*", "", text.strip(), flags=re.I)
    t = re.sub(r"^[\"'“‘]|[\"'”’]$", "", t).strip()
    t = " ".join(t.split())
    if not t or len(t.split()) > 60:
        return ""
    # Refuse to trade one fault for another. weakness() now checks fabrication first, so
    # this also stops a repair inventing a room -- and rejecting falls back to her ordinary
    # reply, which may be dull. Dull is recoverable; fabricated is not.
    if weakness(t, user_text, spoken_recently):
        return ""
    if _content(t) == _content(original):
        return ""
    return t


# --------------------------------------------------------------------------------------
# History hygiene. Measured 2026-09-09.
#
# The prompt carries no worked examples because at 8B any speakable string in it gets
# recited. The SAME is true of the conversation history, and more strongly -- history is
# in her own voice, so it reads as precedent rather than instruction. Every joke this
# module injects therefore became a template the model copied on every following turn,
# whether or not _TRIGGER matched and whether or not the rate limiter allowed it: the
# model does not need this module's permission to copy something she has already said.
#
# Measured on the 13 `grounded` turns: with the joke injected, 12/13 replies came back
# as the three-part shape (10 of them straight from the base model, on turns whose text
# never matched _TRIGGER at all). With the injection absent, 0/26 over two runs. Reducing
# the joke to its opening sentence before it is fed back took the model-side recitations
# from 10 to 0 while leaving the joke itself intact in what was actually spoken.
#
# So: what she SAID is not what the model should SEE. Everything the code puts in her
# mouth is defused here before it becomes precedent.


_RECITED_TEMPLATE = re.compile(r"""
    \b(?:if|when)\b [^.!?]{0,90}? \b(?:i'?ll|i\ will|i'?d)\b
""", re.I | re.X)


def defuse_for_history(content):
    """Return `content` reduced to what is safe to show the model as her own precedent.

    A reply carrying the three-part joke is cut back to its opening sentence -- the care,
    which is ordinary speech and keeps the turn coherent -- dropping the two threat
    clauses that are the copyable part. Anything else is returned unchanged.

    Call this on assistant turns on the way INTO the model's context, never on the way
    out to the speaker: the operator must still hear the whole joke.
    """
    if not ENABLED or not content or not content.strip():
        return content
    tag = _TAG.match(content)
    prefix = tag.group(0) if tag else ""
    body = content[tag.end():] if tag else content
    if len(_RECITED_TEMPLATE.findall(fold(body))) < 2:
        return content
    first = re.split(r"(?<=[.!?])\s+", body.strip())
    return (prefix + first[0]) if first and first[0].strip() else content


def defuse_history(history):
    """`defuse_for_history` over a message list, leaving user turns untouched."""
    return [dict(m, content=defuse_for_history(m.get("content", "")))
            if m.get("role") == "assistant" else m
            for m in history]


# Long replies are buffered no further than this before giving up on repair and streaming
# the rest. Her median real speech is 9 words, so a weak reply is nearly always a short
# one and is complete well inside the budget; a story is not weak in the ways detected
# here and must not be held back waiting for a check that will pass anyway.
BUFFER_WORDS = int(os.getenv("TEMI_REPAIR_BUFFER_WORDS", "45"))


def guard_stream(chunks, user_text, ask_stream, recent_spoken=(), on_event=None):
    """Take the signature joke when it is offered; repair a weak reply; otherwise pass through.

    Buffers only until BUFFER_WORDS. Costs the time to finish a SHORT generation before the
    first audio -- tens of milliseconds once the KV prefix is warm -- and nothing at all on
    a long one, which is released as soon as it outgrows the budget.
    """
    if not ENABLED:
        yield from chunks
        return
    def _emit(ev, *a):
        if on_event:
            try:
                on_event(ev, *a)
            except Exception:
                pass

    # The joke replaces the reply outright: it IS the whole turn, and it is decided from
    # their words alone, so it needs nothing from the stream.
    if wants_care_that_turns(user_text, recent_spoken):
        # Two attempts. The validator enforces five separate structural conditions --
        # three sentences, the second about their body, the third about the object, the
        # third widening onto people they love, no repeated clause -- and a single sample
        # missed at least one of them every time in the 2026-09-09 eval run: attempted
        # twice, rejected twice, so the joke never shipped. The trigger is rare and the
        # prompt is short, so a second sample is cheap and only spends time on the turns
        # that have already earned the joke.
        joke = ""
        for _ in range(2):
            try:
                joke = valid_care_that_turns(
                    "".join(ask_stream(care_that_turns_prompt(user_text))))
            except Exception:
                joke = ""
            if joke:
                break
        if joke:
            joke = _retag(joke, "", fallback=CARE_TAG)
            _emit("care_that_turns", joke)
            close = getattr(chunks, "close", None)
            if close:
                try:
                    close()
                except Exception:
                    pass
            yield joke
            return
        _emit("care_that_turns_rejected", "")

    buf, released = "", False
    try:
        for chunk in chunks:
            buf += chunk
            if not released and len(buf.split()) > BUFFER_WORDS:
                released = True
                yield buf                      # too long to be one of the weak shapes
                buf = ""
            elif released:
                yield chunk
                buf = ""
    finally:
        close = getattr(chunks, "close", None)
        if close:
            try:
                close()
            except Exception:
                pass

    if released or not buf.strip():
        if buf.strip():
            yield buf
        return

    fault = weakness(buf, user_text, recent_spoken)
    if not fault:
        yield buf
        return

    # One retry for the faults where falling back to `buf` re-emits the very thing that
    # was wrong. Every other fault keeps the single attempt: for those the original is
    # merely dull, and dull is a safe floor.
    attempts = 2 if fault in _ORIGINAL_IS_THE_DEFECT else 1
    fixed = ""
    for _ in range(attempts):
        try:
            fixed = valid_repair("".join(ask_stream(repair_prompt(user_text, buf, fault))),
                                 user_text, buf, recent_spoken)
        except Exception:
            fixed = ""
        if fixed:
            break
    if fixed:
        fixed = _retag(fixed, buf)
        _emit("repaired", fault, buf, fixed)
        yield fixed
    else:
        _emit("repair_failed", fault, buf, "")
        yield buf                              # never make it worse
