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
