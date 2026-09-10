"""Drop sentences the assistant has already spoken in this conversation.

Repetition is the dominant persona failure at 8B: a phrase gets latched onto and
re-emitted every turn -- "What was his name?" six turns running -- inside replies
that are otherwise different, so it survives every whole-reply dedupe.

It cannot be fixed in the system prompt. That was measured twice: explicit
anti-repetition rules did not move the persona_eval score, and a runtime
"already said" context block scored 13/16 both with and without it. Worse, the
anti-repetition pressure pushed the model into reciting its own character sheet
at the operator. So it is fixed here instead, after generation, where it is
deterministic and costs no tokens.

The normalisation below is deliberately identical to the one in
`resources/bella/persona_eval.py::check`, so a sentence this filter drops is
exactly a sentence the eval would have flagged repeat_phrase / repeat_question.
Change one and you must change the other, or the eval stops measuring the
shipped behaviour.

Two modes, one memory:

- `filter_reply(text)` for a complete reply (the eval, and any non-streaming
  caller).
- `wrap(chunks)` for the live pipeline, which sees a token stream. It buffers to
  sentence boundaries and yields only the sentences that survive, so what the
  operator hears and what the UI displays stay the same text.

The streaming mode is two-stage, and it has to be. The pipeline starts
generations speculatively on partial transcripts and throws them away when the
next partial arrives, so a sentence that came out of the generator was not
necessarily said out loud. Remembering it anyway would suppress it from the real
reply seconds later -- the assistant would silently swallow her own first
sentence. So emitted sentences are held provisionally and only become memory
when the caller confirms the turn was delivered (`commit`), or are dropped when
it was not (`abandon`).
"""

import re
from collections import deque

# A sentence shorter than this is never tracked. Short fragments ("I see.",
# "Of course.") recur naturally in speech and are not the failure mode; the
# eval's checker uses the same floor.
MIN_WORDS = 3

# Questions get a lower floor, because the reasoning above does not hold for them.
# A two-word acknowledgement recurring is speech; a two-word question recurring is
# a tic, and it is the loudest one there is -- measured 2026-09-09, a persona_eval
# run closed thirteen consecutive turns with "What's new?" and neither this filter
# nor the checker saw it, because "whats new" is two words and both floors were 3.
MIN_QUESTION_WORDS = 2

# How many sentence keys to remember. A conversation that runs past this is
# long enough that a re-used sentence no longer reads as a tic.
MEMORY = 400

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_LEADING_TAG = re.compile(r"^\s*\[[a-zA-Z]+\]\s*")
# Ends the match AT the punctuation and leaves the following whitespace in the
# buffer, so the separator rides out with the next sentence instead of being
# swallowed. The quick-answer boundary in speech_pipeline_manager strips a
# trailing space off the first sentence, so a space kept here is a space lost:
# "Hello. What's new?" reaches TTS as "Hello.What's new?".
_SENTENCE_END = re.compile(r"[.!?][\"')\]]*(?=\s)")


def normalise(sentence: str) -> str:
    """Reduce a sentence to its comparison key.

    Identical to persona_eval.check: lowercase, drop everything that is not a
    letter or a space, strip. The leading emotion tag is removed first so that
    "[playful] What was his name?" and "[softly] What was his name?" collide --
    they are the same spoken sentence wearing different delivery.

    Known gap, accepted deliberately: a stage direction the pipeline later strips
    ("*smiles* What was his name?") still contributes "smiles" to the key, so it
    will not collide with the bare sentence. Stripping it here would buy one more
    catch at the cost of parity with the checker, and a reply carrying markdown is
    already failing the eval on its own count.
    """
    return re.sub(r"[^a-z ]", "", _LEADING_TAG.sub("", sentence).lower()).strip()


def is_tracked(key: str, question: bool = False) -> bool:
    """True if a key is long enough to count as a repeatable sentence.

    `question` lowers the floor to MIN_QUESTION_WORDS. Callers pass it from the
    raw sentence, before `normalise` strips the mark.
    """
    return len(key.split()) >= (MIN_QUESTION_WORDS if question else MIN_WORDS)


def is_question(sentence: str) -> bool:
    """True if a sentence ends in a question mark, tag and whitespace aside."""
    return sentence.strip().endswith("?")


class RepetitionFilter:
    """Per-conversation memory of what has already been said out loud.

    Not thread-safe by design: one conversation is one speaker, and the pipeline
    only ever generates one reply at a time.
    """

    def __init__(self, spoken=()):
        self._keys = set()
        self._order = deque()
        self._pending = []         # keys from a turn not yet confirmed spoken
        self.dropped = []          # sentences withheld, for measurement
        self.kept_nothing = 0      # replies that were entirely repeat
        for text in spoken:
            self.remember(text)

    # -- memory -----------------------------------------------------------

    def reset(self, spoken=()):
        """Forget everything, then optionally seed from prior assistant turns."""
        self._keys.clear()
        self._order.clear()
        self._pending = []
        self.dropped = []
        self.kept_nothing = 0
        for text in spoken:
            self.remember(text)

    def begin(self):
        """Open a turn. Anything emitted from here is provisional until committed."""
        self._pending = []

    def commit(self):
        """The turn was delivered. Fold what she said into permanent memory."""
        for key in self._pending:
            self._add(key)
        self._pending = []

    def abandon(self):
        """The turn was superseded or aborted before delivery. It never happened."""
        self._pending = []

    def _add(self, key: str):
        if key in self._keys:
            return
        self._keys.add(key)
        self._order.append(key)
        while len(self._order) > MEMORY:
            self._keys.discard(self._order.popleft())

    def remember(self, text: str):
        """Record every trackable sentence in `text` as already spoken."""
        for sentence in _SENTENCE_SPLIT.split(text or ""):
            key = normalise(sentence)
            if is_tracked(key, is_question(sentence)):
                self._add(key)

    # -- filtering --------------------------------------------------------

    def _sift(self, sentences):
        """Split a sentence list into (kept, dropped), staging what is kept.

        A kept sentence goes to `_pending`, not to memory: within one turn it
        must not be said twice, but across turns it only counts once the turn is
        confirmed delivered.
        """
        kept, dropped = [], []
        for sentence in sentences:
            if not sentence.strip():
                continue
            key = normalise(sentence)
            tracked = is_tracked(key, is_question(sentence))
            if tracked and (key in self._keys or key in self._pending):
                dropped.append(sentence)
                continue
            if tracked:
                self._pending.append(key)
            kept.append(sentence)
        return kept, dropped

    def filter_reply(self, text: str) -> str:
        """Return `text` with already-spoken sentences removed.

        The leading emotion tag is preserved even when the sentence carrying it
        is dropped -- the pipeline reads that tag to pick a delivery, and losing
        it would silently reset her to neutral.

        If nothing at all survives, the original is returned unchanged. Saying
        something twice is a blemish; saying nothing is a broken assistant, and
        this filter is not allowed to make her mute.

        A complete reply is a delivered reply, so this commits as it goes; only
        the streaming path has to wait to find out.
        """
        if not text or not text.strip():
            return text
        self.begin()
        match = _LEADING_TAG.match(text)
        tag = match.group(0) if match else ""
        body = text[match.end():] if match else text

        kept, dropped = self._sift(_SENTENCE_SPLIT.split(body))
        self.dropped.extend(dropped)
        if not kept:
            self.kept_nothing += 1
            self.commit()  # nothing pending; keeps "every path commits" true
            return text
        self.commit()
        return tag + " ".join(kept)

    def wrap(self, chunks):
        """Return a token stream with already-spoken sentences withheld.

        Buffers to sentence boundaries, so a caller downstream sees whole
        sentences instead of tokens. That costs nothing on the latency path: the
        pipeline's quick-answer worker already waits for a sentence boundary
        before it can hand anything to TTS.

        Deliberately not a generator function: the turn has to open when the
        generator is created, not when something first pulls on it, or a
        speculative generation that is superseded before its first token would
        leave the previous turn's provisional keys standing.

        Sentences emitted here are provisional. Call `commit()` once the turn
        has actually been delivered, `abandon()` if it was superseded.
        """
        self.begin()
        return self._stream(chunks)

    def _stream(self, chunks):
        buffer = ""
        emitted = False
        dropped_at_start = len(self.dropped)
        try:
            for chunk in chunks:
                buffer += chunk
                out, buffer = self._drain(buffer)
                if out:
                    emitted = True
                    yield out
            if buffer.strip():
                # Emit `buffer`, not `buffer.strip()`: its leading whitespace is
                # the separator left behind by the sentence before it, and
                # stripping it here loses the space just as surely as consuming
                # it there did.
                kept, dropped = self._sift([buffer])
                self.dropped.extend(dropped)
                if kept:
                    emitted = True
                    yield kept[0]
            if not emitted:
                # The whole reply was a repeat. Speak it rather than fall silent,
                # for the same reason filter_reply does.
                #
                # This sits OUTSIDE the `if buffer.strip()` guard deliberately, and
                # that is the whole point of it. _SENTENCE_END needs whitespace
                # after the punctuation, so a reply ending "...new?\n" has its last
                # sentence consumed by _drain and leaves `buffer` holding only the
                # newline. With the rescue nested inside the guard, that case fell
                # through and wrap() yielded NOTHING -- a silent turn, and
                # kept_nothing never incremented, so the instrument that measures
                # muting reported zero. Measured 2026-09-09.
                #
                # Rescue the whole reply, not just the tail: that is what
                # filter_reply does when every sentence is a repeat. Sentences come
                # off _drain without their trailing separator, so rejoin with one.
                rescue = " ".join(self.dropped[dropped_at_start:]) or buffer
                if rescue.strip():
                    self.kept_nothing += 1
                    yield rescue
        finally:
            close = getattr(chunks, "close", None)
            if close:
                try:
                    close()
                except Exception:
                    pass

    def _drain(self, buffer):
        """Pull complete sentences off the front of `buffer`, filtering them."""
        out = []
        while True:
            match = _SENTENCE_END.search(buffer)
            if not match:
                break
            sentence, buffer = buffer[:match.end()], buffer[match.end():]
            kept, dropped = self._sift([sentence])
            self.dropped.extend(dropped)
            out.extend(kept)
        return "".join(out), buffer
