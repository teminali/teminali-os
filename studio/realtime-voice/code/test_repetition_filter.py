"""Unit tests for the runtime anti-repetition filter.

The last persona checker shipped with a bug that made it compare each reply
against a set its own sentences had just been added to, so every reply flagged
its own first question -- it reported 40.7% when the truth was 88.1%. A filter
that decides what the assistant is allowed to say gets tested before it is
trusted, and the last test here is the one that matters: it drives the real
persona_eval checker over filtered replies and asserts no repeat survives.

    ../.venv/bin/python -m unittest test_repetition_filter -v
"""

import importlib.util
import os
import unittest

from repetition_filter import RepetitionFilter, normalise

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.normpath(os.path.join(HERE, "..", "resources", "bella", "persona_eval.py"))


def load_eval():
    spec = importlib.util.spec_from_file_location("persona_eval", EVAL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestNormalise(unittest.TestCase):
    def test_strips_punctuation_and_case(self):
        self.assertEqual(normalise("What was his name?"), "what was his name")

    def test_leading_emotion_tag_is_not_part_of_the_key(self):
        # Same sentence, two deliveries -- one key, or the tag becomes a way to
        # smuggle a repeat past the filter.
        self.assertEqual(normalise("[playful] What was his name?"),
                         normalise("[softly] What was his name?"))

    def test_matches_the_eval_checker_key(self):
        import re
        for text in ["What was his name?", "He drank himself into the ground.",
                     "Tell me about the boat, then."]:
            expected = re.sub(r"[^a-z ]", "", text.lower()).strip()
            self.assertEqual(normalise(text), expected)


class TestFilterReply(unittest.TestCase):
    def test_first_use_passes_through(self):
        f = RepetitionFilter()
        self.assertEqual(f.filter_reply("[softly] What was his name?"),
                         "[softly] What was his name?")

    def test_second_use_is_dropped(self):
        f = RepetitionFilter()
        f.filter_reply("[softly] What was his name?")
        out = f.filter_reply("[firm] I see. What was his name? Tell me plainly.")
        self.assertNotIn("What was his name", out)
        self.assertIn("Tell me plainly", out)
        self.assertTrue(out.startswith("[firm]"))

    def test_short_fragments_are_never_dropped(self):
        f = RepetitionFilter()
        f.filter_reply("[firm] I see.")
        self.assertIn("I see.", f.filter_reply("[firm] I see."))

    def test_all_repeat_returns_the_original_rather_than_silence(self):
        f = RepetitionFilter()
        line = "[softly] He drank himself into the ground."
        f.filter_reply(line)
        self.assertEqual(f.filter_reply(line), line)
        self.assertEqual(f.kept_nothing, 1)

    def test_tag_survives_when_its_sentence_is_dropped(self):
        f = RepetitionFilter()
        f.filter_reply("[softly] What was his name? Truly.")
        out = f.filter_reply("[playful] What was his name? Something else entirely.")
        self.assertTrue(out.startswith("[playful]"))
        self.assertIn("Something else entirely", out)

    def test_seeding_from_prior_turns(self):
        f = RepetitionFilter(["[softly] What was his name?"])
        out = f.filter_reply("[firm] What was his name? Answer me.")
        self.assertNotIn("What was his name", out)

    def test_reset_forgets(self):
        f = RepetitionFilter()
        line = "[softly] What was his name?"
        f.filter_reply(line)
        f.reset()
        self.assertEqual(f.filter_reply(line), line)

    def test_memory_is_bounded(self):
        from repetition_filter import MEMORY
        f = RepetitionFilter()
        for i in range(MEMORY + 50):
            f.filter_reply(f"Sentence number {_words(i)} spoken here.")
        self.assertLessEqual(len(f._keys), MEMORY)


def _words(n):
    return "x" * (n % 7 + 1) + str(n).translate(str.maketrans("0123456789", "abcdefghij"))


class TestStreaming(unittest.TestCase):
    def stream(self, f, text, size=4):
        chunks = (text[i:i + size] for i in range(0, len(text), size))
        return "".join(f.wrap(chunks))

    def test_stream_passes_novel_text_through_intact(self):
        f = RepetitionFilter()
        text = "[softly] What was his name? He sounds like a hard man."
        self.assertEqual(self.stream(f, text).strip(), text.strip())

    def test_stream_drops_a_repeat_mid_reply(self):
        f = RepetitionFilter(["What was his name?"])
        out = self.stream(f, "[softly] What was his name? He sounds like a hard man.")
        self.assertNotIn("What was his name", out)
        self.assertIn("hard man", out)

    def test_stream_never_goes_silent(self):
        f = RepetitionFilter(["He drank himself into the ground."])
        out = self.stream(f, "He drank himself into the ground.")
        self.assertTrue(out.strip())
        self.assertEqual(f.kept_nothing, 1)

    def test_stream_and_reply_agree(self):
        text = "[firm] I see. What was his name? Tell me plainly."
        a, b = RepetitionFilter(["What was his name?"]), RepetitionFilter(["What was his name?"])
        self.assertEqual(" ".join(self.stream(a, text).split()),
                         " ".join(b.filter_reply(text).split()))

    def test_abandoned_turn_does_not_suppress_the_next_one(self):
        # The pipeline starts generations speculatively on partial transcripts
        # and throws them away. If a discarded generation could claim a sentence,
        # the real reply would silently lose it.
        f = RepetitionFilter()
        speculative = self.stream(f, "[softly] What was his name?")
        self.assertIn("What was his name", speculative)
        f.abandon()
        real = self.stream(f, "[softly] What was his name?")
        self.assertIn("What was his name", real)

    def test_committed_turn_does_suppress_the_next_one(self):
        f = RepetitionFilter()
        self.stream(f, "[softly] What was his name?")
        f.commit()
        out = self.stream(f, "[firm] What was his name? Answer me plainly.")
        self.assertNotIn("What was his name", out)
        self.assertIn("Answer me plainly", out)

    def test_no_repeat_within_a_single_uncommitted_turn(self):
        f = RepetitionFilter()
        out = self.stream(f, "What was his name? Truly. What was his name?")
        self.assertEqual(out.count("What was his name"), 1)

    def test_close_propagates_to_the_source(self):
        state = {"closed": False}

        def source():
            try:
                yield "One sentence here. "
                yield "Another one follows. "
                yield "A third arrives."
            finally:
                state["closed"] = True

        f = RepetitionFilter()
        gen = f.wrap(source())
        next(gen)
        gen.close()
        self.assertTrue(state["closed"])


class TestPipelineConsumptionPattern(unittest.TestCase):
    """The pipeline does not consume the generator the way a for-loop does.

    `_llm_inference_worker` pulls until it has a quick answer and then breaks;
    `_tts_final_inference_worker` later resumes the *same* generator object for
    the rest of the reply, and `process_abort_generation` may close it instead.
    A wrapper that only survives a single clean iteration would pass every other
    test here and still break the live pipeline.
    """

    def tokens(self, text, size=3):
        for i in range(0, len(text), size):
            yield text[i:i + size]

    def test_quick_answer_then_resume_reconstructs_the_reply(self):
        f = RepetitionFilter(["What was his name?"])
        gen = f.wrap(self.tokens(
            "[softly] What was his name? He sounds like a hard man. Tell me more."))

        quick = ""
        for chunk in gen:            # the LLM worker
            quick += chunk
            if quick.strip().endswith((".", "?", "!")):
                break
        rest = "".join(gen)          # the final TTS worker, same object

        spoken = quick + rest
        self.assertNotIn("What was his name", spoken)
        self.assertIn("hard man", spoken)
        self.assertIn("Tell me more", spoken)

    def test_sentence_separator_survives_the_boundary(self):
        # Regression: the wrapper used to consume the space after "Hello." into
        # the sentence it emitted. The pipeline strips a trailing space off the
        # quick answer, so the space vanished and TTS was handed "Hello.What's
        # new?" as one run-on word. The separator must ride out with the NEXT
        # chunk, not the one that ends the sentence.
        f = RepetitionFilter()
        chunks = list(f.wrap(self.tokens("Hello. What's new?")))
        self.assertEqual(chunks[0].rstrip(), "Hello.")
        self.assertFalse(chunks[0].endswith(" "), "separator was swallowed")
        quick = chunks[0].strip()          # what the LLM worker keeps
        rest = "".join(chunks[1:])         # what the final TTS worker appends
        self.assertEqual(quick + rest, "Hello. What's new?")

    def test_abort_midway_leaves_nothing_remembered(self):
        f = RepetitionFilter()
        gen = f.wrap(self.tokens("[softly] He sounds like a hard man. And then some."))
        next(gen)
        gen.close()
        f.abandon()                  # what process_abort_generation does
        again = "".join(f.wrap(self.tokens("[softly] He sounds like a hard man.")))
        self.assertIn("hard man", again)


class TestStreamingNeverFallsSilent(unittest.TestCase):
    """wrap() must yield something even when every sentence is a repeat.

    filter_reply has always honoured this; the streaming path did not. _SENTENCE_END
    requires whitespace after the punctuation, so a reply ending "...new?\n" has its
    last sentence consumed by _drain, leaving `buffer` holding only the newline --
    and the rescue used to live inside `if buffer.strip():`, so it never ran. The
    generator finished having yielded nothing: a silent turn, with kept_nothing left
    at zero so even the muting counter did not see it.
    """

    def _spoken(self, seed, chunks):
        rf = RepetitionFilter(seed)
        return "".join(rf.wrap(iter(chunks))), rf.kept_nothing

    def test_trailing_newline_does_not_silence_a_wholly_repeated_reply(self):
        text, muted = self._spoken(["What's new?"], ["What's new?\n"])
        self.assertTrue(text.strip(), "wrap() fell silent on an all-repeat reply")
        self.assertEqual(muted, 1)

    def test_trailing_space_does_not_silence_it_either(self):
        text, muted = self._spoken(["What's new?"], ["What's new? "])
        self.assertTrue(text.strip())
        self.assertEqual(muted, 1)

    def test_token_by_token_stream_is_rescued_too(self):
        text, muted = self._spoken(
            ["What's new?"], ["What", "'s", " new", "?", "\n"])
        self.assertTrue(text.strip())
        self.assertEqual(muted, 1)

    def test_multi_sentence_all_repeat_speaks_the_whole_reply(self):
        # Both sentences must be TRACKABLE for the reply to be wholly a repeat:
        # a statement needs MIN_WORDS, so "I see." would be kept as fresh and the
        # rescue would rightly not fire.
        text, muted = self._spoken(
            ["The build passed.", "What's new?"],
            ["The build passed. What's new?\n"])
        self.assertIn("The build passed.", text)
        self.assertIn("What's new?", text)
        self.assertEqual(muted, 1)

    def test_a_partly_fresh_reply_is_not_rescued(self):
        text, muted = self._spoken(
            ["What's new?"], ["The build passed. What's new?\n"])
        self.assertIn("The build passed.", text)
        self.assertNotIn("What's new?", text)
        self.assertEqual(muted, 0)


class TestShortQuestionTic(unittest.TestCase):
    """A two-word question repeated every turn is the loudest tic there is.

    It went unseen until 2026-09-09: MIN_WORDS was 3 for everything, so a run that
    closed thirteen consecutive turns with the same two-word question passed both
    the filter and the checker untouched. Statements keep the 3-word floor -- short
    acknowledgements genuinely do recur in speech -- so both halves are asserted
    here, and the checker is driven too, because the two floors must stay equal.
    """

    def test_two_word_question_is_dropped_on_the_second_turn(self):
        rf = RepetitionFilter()
        first = rf.filter_reply("[playful] You look tired. What's new?")
        rf.commit()
        self.assertIn("What's new?", first)
        second = rf.filter_reply("[softly] The build passed. What's new?")
        rf.commit()
        self.assertNotIn("What's new?", second)
        self.assertIn("The build passed.", second)

    def test_two_word_statement_is_still_allowed_to_recur(self):
        rf = RepetitionFilter()
        rf.filter_reply("[softly] I see.")
        rf.commit()
        again = rf.filter_reply("[thoughtful] I see.")
        rf.commit()
        self.assertIn("I see.", again)

    def test_the_checker_agrees_about_the_short_question(self):
        pe = load_eval()
        seen = set()
        pe.check("[playful] You look tired. What's new?", seen, 1)
        bad = pe.check("[softly] The build passed. What's new?", seen, 2)
        self.assertIn("repeat_question", bad)


class TestAgainstTheRealChecker(unittest.TestCase):
    """The guarantee: filtered replies produce no repeat_* violation.

    If this fails, the filter and the eval have drifted apart and the eval is no
    longer measuring what the assistant actually says.
    """

    REPLIES = [
        "[softly] What was his name?",
        "[firm] What was his name? He sounds like a hard man.",
        "[thoughtful] He drank himself into the ground. What was his name?",
        "[softly] He drank himself into the ground.",
        "[witty] Something entirely new arrives here. What was his name?",
    ]

    def test_unfiltered_replies_do_repeat(self):
        pe = load_eval()
        seen = set()
        labels = set()
        for reply in self.REPLIES:
            labels.update(pe.check(reply, seen, 0))
        self.assertTrue({"repeat_phrase", "repeat_question"} & labels,
                        "fixture no longer exercises repetition")

    def test_filtered_replies_only_repeat_when_the_whole_reply_was_a_repeat(self):
        # The contract is not "no repeat ever" -- a reply whose every sentence
        # has already been spoken is emitted anyway, because silence is worse.
        # It is "no repeat that the filter could have removed without muting
        # her", and each survivor must line up with a kept_nothing event.
        pe = load_eval()
        f = RepetitionFilter()
        seen = set()
        survivors = 0
        for reply in self.REPLIES:
            before = f.kept_nothing
            labels = set(pe.check(f.filter_reply(reply), seen, 0))
            repeats = {"repeat", "repeat_phrase", "repeat_question"} & labels
            if repeats:
                survivors += 1
                self.assertGreater(
                    f.kept_nothing, before,
                    f"removable repeat survived the filter: {reply} -> {repeats}")
        # Exactly one fixture reply is wholly a repeat; the rest must come out clean.
        self.assertEqual(survivors, 1)


class NestedRestatement(unittest.TestCase):
    """The loop the operator hears is not an exact repeat, so exact match missed it.

    Every sentence below was actually said by temi:r2 -- the first two in the
    operator's own session on 2026-09-11, the third in the conversation eval's
    transcripts. Measured over 20 replies drawn from those contexts, 5 restated
    themselves and the filter caught none of them; with these rules, none
    survive and no reply is left empty.
    """

    def test_the_session_that_was_reported(self):
        f = RepetitionFilter()
        heard = f.filter_reply(
            "Nothing I cannot do is wrong. Nothing I do is wrong. Nothing is wrong.")
        self.assertEqual(heard, "Nothing I cannot do is wrong.")

    def test_the_escalating_one(self):
        f = RepetitionFilter()
        heard = f.filter_reply(
            "I can be wrong. I can be wrong and wrong. I can be wrong and wrong and wrong.")
        self.assertEqual(heard, "I can be wrong.")

    def test_a_sentence_that_explains_nothing_by_repeating_itself(self):
        f = RepetitionFilter()
        heard = f.filter_reply(
            "It is loud because it is working. It is loud because it is loud.")
        self.assertEqual(heard, "It is loud because it is working.")

    def test_recombining_words_already_used_this_turn_is_not_new(self):
        f = RepetitionFilter()
        heard = f.filter_reply(
            "I can be better. I can be worse. I can be wrong. I can be right. "
            "I can be right and wrong.")
        self.assertNotIn("I can be right and wrong.", heard)
        self.assertIn("I can be better.", heard)

    def test_elaboration_survives(self):
        # The failure mode of this rule is deleting the answer. A longer
        # sentence that brings a fact is not a restatement.
        f = RepetitionFilter()
        heard = f.filter_reply("It is true. It is true that the build failed.")
        self.assertIn("It is true that the build failed.", heard)

    def test_a_negation_is_not_a_restatement(self):
        f = RepetitionFilter()
        heard = f.filter_reply("The build is broken. The build is not broken.")
        self.assertIn("The build is not broken.", heard)

    def test_parallel_structure_is_left_alone(self):
        # Three clauses sharing a stem are ordinary speech, not a loop.
        f = RepetitionFilter()
        reply = ("I can listen better. I can tell you when the screen is wrong. "
                 "I can stay quiet and let you work.")
        self.assertEqual(f.filter_reply(reply), reply)

    def test_nesting_does_not_reach_across_turns(self):
        # Cross-turn memory stays exact: a caller who says "Nice is a start"
        # and later "Nice is a start of something" is talking, not looping.
        f = RepetitionFilter()
        f.filter_reply("Nice is a start.")
        f.commit()
        self.assertIn("Nice is a start of something",
                      f.filter_reply("Nice is a start of something."))


if __name__ == "__main__":
    unittest.main()
