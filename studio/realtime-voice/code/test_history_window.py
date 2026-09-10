"""The window is bounded by context, not by a message count.

A count cannot bound what it is meant to bound: twenty messages is four hundred
tokens of short spoken turns or four thousand of dictated prose, and only one of
those is a context problem. Counting tokens bounds the thing that actually runs
out, and lets the assistant keep everything it has room to keep.
"""
import unittest

import history_window as h


def turns(n, words=10):
    return [{"role": "user" if i % 2 == 0 else "assistant",
             "content": " ".join(["word"] * words)} for i in range(n)]


class Budget(unittest.TestCase):
    def test_the_reply_is_reserved_before_history_gets_the_rest(self):
        # The reply is generated from the same window it must fit in.
        with_reply = h.budget_tokens(8192, 700, 500)
        without = h.budget_tokens(8192, 700, 0)
        self.assertEqual(without - with_reply, 500)

    def test_a_system_prompt_that_fills_the_window_leaves_nothing(self):
        self.assertEqual(h.budget_tokens(1024, 100_000, 200), 0)

    def test_a_bigger_context_gives_history_more_room(self):
        self.assertGreater(h.budget_tokens(16384, 700, 220), h.budget_tokens(8192, 700, 220))


class Window(unittest.TestCase):
    def test_a_conversation_that_fits_is_kept_whole(self):
        conversation = turns(30)
        self.assertEqual(len(h.window(conversation, 10_000)), 30)

    def test_the_twenty_message_cliff_is_gone(self):
        """The measured failure: facts stated 19 turns ago were unreachable."""
        conversation = turns(60)
        kept = h.window(conversation, h.budget_tokens(8192, 700, 220))
        self.assertGreater(len(kept), 20)

    def test_it_keeps_the_most_recent_turns_not_the_oldest(self):
        conversation = turns(200)
        kept = h.window(conversation, 500)
        self.assertIs(kept[-1], conversation[-1])

    def test_a_long_conversation_is_still_bounded(self):
        kept = h.window(turns(1000), 10_000_000)
        self.assertLessEqual(len(kept), h.MAX_MESSAGES)

    def test_one_enormous_message_does_not_take_the_whole_window_with_it(self):
        conversation = turns(20) + [{"role": "user", "content": "x" * 400_000}]
        kept = h.window(conversation, 2000)
        self.assertLessEqual(len(kept), h.MIN_MESSAGES)

    def test_it_never_trims_below_the_floor(self):
        kept = h.window(turns(40, words=5000), 10)
        self.assertEqual(len(kept), h.MIN_MESSAGES)

    def test_an_empty_history_is_not_a_special_case_for_the_caller(self):
        self.assertEqual(h.window([], 1000), [])

    def test_trimming_leaves_headroom_so_it_does_not_repeat_next_turn(self):
        """Every trim invalidates the KV prefix; trimming to exactly the budget
        would do that on every single turn from then on."""
        conversation = turns(200)
        budget = 1000
        kept = h.window(conversation, budget)
        self.assertLessEqual(h.cost(kept), budget * h.TRIM_TO)

    def test_the_window_is_a_copy_the_caller_cannot_corrupt(self):
        conversation = turns(10)
        h.window(conversation, 10_000).clear()
        self.assertEqual(len(conversation), 10)


if __name__ == "__main__":
    unittest.main()


class TheCliffWasInServerPy(unittest.TestCase):
    """The window was rewritten; the truncation upstream of it was not.

    `Window.test_the_twenty_message_cliff_is_gone` passed all along, because the
    cliff had moved. `server.py` ran `while len(history) > 20: history.pop(0)`
    after every user turn and again after every assistant turn, so the history
    that reached `window()` could never exceed twenty messages however large the
    budget was. A fact stated twenty-four turns ago was not trimmed by the
    window — it had been discarded before the window was asked.

    These read the source because importing `server.py` starts a pipeline.
    """

    def source(self):
        import pathlib
        return (pathlib.Path(__file__).parent / "server.py").read_text()

    def test_the_hard_twenty_is_gone_from_the_server(self):
        self.assertNotIn("len(history) > 20", self.source())

    def test_the_bound_is_the_window_s_own_ceiling(self):
        src = self.source()
        self.assertIn("import history_window", src)
        self.assertIn("history_window.MAX_MESSAGES", src)

    def test_both_commit_points_are_bounded(self):
        # One after the user's turn, one after the assistant's. Bounding only
        # one lets the list grow by a message a turn.
        self.assertEqual(self.source().count("_bound_history(history)"), 2)


class FarMemory(unittest.TestCase):
    """What the budget actually buys, in turns.

    The handover recorded "far memory (~24 turns) still drops facts". With the
    server's cap removed the window is what decides, so this pins how far it
    reaches: a fact survives well past twenty-four turns, and the failure when
    it finally comes is the oldest turns going first.
    """

    FACT = "I take my coffee black, no sugar."

    def conversation(self, turns):
        # Realistic spoken lengths: a short question, and a reply as long as
        # OLLAMA_NUM_PREDICT now permits.
        history = [{"role": "user", "content": self.FACT},
                   {"role": "assistant", "content": "Black, no sugar. Noted." + " word" * 80}]
        for i in range(turns - 1):
            history.append({"role": "user", "content": f"Tell me about topic number {i}, please."})
            history.append({"role": "assistant", "content": ("A considered answer about that. " * 3) + " word" * 80})
        return history

    def budget(self):
        # 8192 context, the real system prompt's size, the real reply
        # reservation -- which is now OLLAMA_NUM_PREDICT's 256, not 220, so
        # the budget is 5878 rather than 5914. See TheReplyReserveIsOneQuantity.
        return h.budget_tokens(8192, 6293, 256)

    def kept(self, turns):
        return h.window(self.conversation(turns), self.budget())

    def remembers(self, turns):
        return any(self.FACT in m["content"] for m in self.kept(turns))

    def test_a_fact_survives_the_span_the_handover_said_it_did_not(self):
        self.assertTrue(self.remembers(24), "twenty-four turns was the reported failure")
        self.assertTrue(self.remembers(36))

    def test_twenty_messages_would_never_have_reached_it(self):
        # The cliff, restated as the thing it cost: under the old cap the fact
        # is gone by turn eleven, whatever the budget says.
        capped = self.conversation(24)[-20:]
        self.assertFalse(any(self.FACT in m["content"] for m in capped))

    def test_when_it_does_run_out_it_is_the_oldest_that_goes(self):
        kept = self.kept(60)
        self.assertFalse(any(self.FACT in m["content"] for m in kept))
        self.assertIn("topic number 58", kept[-2]["content"])

class TheReplyReserveIsOneQuantity(unittest.TestCase):
    """The tokens reserved for the reply and the cap on generating it are one
    number, and were written twice.

    `speech_pipeline_manager` reserved 220 while `llm_module` let the model emit
    256. Nothing broke, because a reply that long is rare and the window has
    slack -- but when one does arrive the prompt and the reply together exceed
    the 8192 window, and what ollama drops to make room is the beginning of the
    prompt: the system prompt, the thing that makes her Temi. The reserve now
    falls back to the cap, so setting one moves the other.

    Source-level, like TheCliffWasInServerPy: importing either module starts
    loading a pipeline.
    """

    def source(self, name):
        import pathlib
        return (pathlib.Path(__file__).parent / name).read_text()

    def test_the_reserve_falls_back_to_the_generator_s_cap(self):
        src = self.source("speech_pipeline_manager.py")
        self.assertIn('os.getenv("TEMI_REPLY_TOKENS",', src)
        self.assertIn('os.getenv("OLLAMA_NUM_PREDICT", "256")', src)

    def test_the_two_defaults_agree(self):
        import re
        reserve = re.search(r'TEMI_REPLY_TOKENS",\s*\n?\s*os\.getenv\("OLLAMA_NUM_PREDICT",\s*"(\d+)"',
                            self.source("speech_pipeline_manager.py"))
        cap = re.search(r'OLLAMA_NUM_PREDICT",\s*"(\d+)"', self.source("llm_module.py"))
        self.assertIsNotNone(reserve, "the reserve no longer reads the cap")
        self.assertIsNotNone(cap, "llm_module no longer defaults num_predict")
        self.assertEqual(reserve.group(1), cap.group(1))

    def test_the_reserve_is_never_smaller_than_the_cap(self):
        # The direction that matters: a reserve below the cap is the overflow.
        self.assertLessEqual(h.budget_tokens(8192, 6293, 256),
                             h.budget_tokens(8192, 6293, 220))
