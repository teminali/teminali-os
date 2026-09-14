"""Tests for the filled-pause policy.

These are the timing cases the persona eval structurally cannot see: it scores
text, and a filler is timing. Everything here is deterministic -- the policy
selects least-recently-used rather than at random, precisely so density and
rotation are testable rather than vibes.
"""

import unittest

from filler_policy import ACK, THINK, FillerPolicy


BANK = {ACK: ["ack_mm", "ack_breath", "ack_go_on"],
        THINK: ["think_breath", "think_hm"]}


def policy(**kw):
    kw.setdefault("min_turn_gap", 0)
    return FillerPolicy(BANK, **kw)


class Acknowledgement(unittest.TestCase):
    def test_fires_on_commit(self):
        p = policy()
        self.assertEqual(p.user_committed(0.0), "ack_mm")

    def test_absent_category_is_silent(self):
        p = FillerPolicy({THINK: ["t"]}, min_turn_gap=0)
        self.assertIsNone(p.user_committed(0.0))

    def test_empty_bank_is_silent(self):
        p = FillerPolicy({}, min_turn_gap=0)
        self.assertIsNone(p.user_committed(0.0))
        self.assertIsNone(p.poll(99.0))


class Thinking(unittest.TestCase):
    def test_silent_before_threshold(self):
        p = FillerPolicy({THINK: ["think_breath"]}, think_after=0.6, min_turn_gap=0)
        p.user_committed(10.0)
        self.assertIsNone(p.poll(10.5))

    def test_fires_after_threshold(self):
        p = FillerPolicy({THINK: ["think_breath"]}, think_after=0.6, min_turn_gap=0)
        p.user_committed(0.0)
        self.assertEqual(p.poll(0.6), "think_breath")

    def test_threshold_is_not_float_fragile(self):
        """10.6 - 10.0 is 0.5999... in binary. A near-boundary poll must still
        fire on the next tick rather than stalling the whole turn."""
        p = FillerPolicy({THINK: ["think_breath"]}, think_after=0.6, min_turn_gap=0)
        p.user_committed(10.0)
        self.assertIsNone(p.poll(10.6))
        self.assertEqual(p.poll(10.7), "think_breath")

    def test_speech_disarms_it(self):
        p = FillerPolicy({THINK: ["think_breath"]}, think_after=0.6, min_turn_gap=0)
        p.user_committed(10.0)
        p.speech_started(10.2)
        self.assertIsNone(p.poll(99.0))

    def test_poll_without_a_turn_is_silent(self):
        p = policy()
        self.assertIsNone(p.poll(99.0))

    def test_only_one_filler_per_turn(self):
        """An ack already fired; a long wait must not stack a think on top."""
        p = policy(think_after=0.6)
        self.assertEqual(p.user_committed(10.0), "ack_mm")
        self.assertIsNone(p.poll(20.0))

    def test_fires_only_once_per_turn(self):
        p = FillerPolicy({THINK: ["a", "b"]}, think_after=0.6, min_turn_gap=0)
        p.user_committed(10.0)
        self.assertEqual(p.poll(11.0), "a")
        self.assertIsNone(p.poll(12.0))


class Rotation(unittest.TestCase):
    def test_never_repeats_consecutively(self):
        p = policy()
        seen = []
        for turn in range(6):
            clip = p.user_committed(float(turn))
            p.played()
            seen.append(clip)
        for a, b in zip(seen, seen[1:]):
            self.assertNotEqual(a, b, f"repeated {a!r} back to back in {seen}")

    def test_cycles_the_whole_bank_before_reusing(self):
        p = policy()
        seen = [p.user_committed(float(t)) or p.played() for t in range(3)]
        seen = []
        p.reset()
        for t in range(3):
            seen.append(p.user_committed(float(t)))
            p.played()
        self.assertEqual(sorted(seen), sorted(BANK[ACK]))

    def test_abandoned_filler_keeps_its_slot(self):
        """Barged over -> it never happened, so it stays next in rotation."""
        p = policy()
        first = p.user_committed(0.0)
        p.barge_in(0.1)
        self.assertEqual(p.user_committed(1.0), first)
        self.assertEqual(p.abandoned, 1)


class Density(unittest.TestCase):
    def test_gap_suppresses_consecutive_turns(self):
        p = policy(min_turn_gap=2)
        self.assertEqual(p.user_committed(0.0), "ack_mm")
        p.played()
        self.assertIsNone(p.user_committed(1.0))
        p.played()
        self.assertEqual(p.user_committed(2.0), "ack_breath")

    def test_suppression_is_counted(self):
        p = policy(min_turn_gap=3)
        p.user_committed(0.0); p.played()
        p.user_committed(1.0)
        p.user_committed(2.0)
        self.assertEqual(p.suppressed_gap, 2)

    def test_barge_in_does_not_spend_the_gap(self):
        """A filler nobody heard must not buy silence on the next turn."""
        p = policy(min_turn_gap=2)
        self.assertIsNotNone(p.user_committed(0.0))
        p.barge_in(0.1)
        self.assertIsNotNone(p.user_committed(1.0))


class Lifecycle(unittest.TestCase):
    def test_reset_clears_everything(self):
        p = policy(min_turn_gap=2)
        p.user_committed(0.0); p.played()
        p.reset()
        self.assertEqual(p.recent, [])
        self.assertEqual(p.user_committed(0.0), "ack_mm")

    def test_speech_started_commits_pending(self):
        p = policy()
        clip = p.user_committed(0.0)
        p.speech_started(0.3)
        self.assertEqual(p.recent, [clip])


if __name__ == "__main__":
    unittest.main(verbosity=2)
