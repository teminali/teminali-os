"""Tests for the mid-clause hesitation layer."""

import re
import unittest

from delivery import FUNCTION_WORDS, INSERT_PER_100_SYL, MIN_GAP_WORDS, lazify

LONG = ("I will act as an intermediary between you and Marco to ensure there is no "
        "friction between his organisation and yours, and I would like that settled "
        "before the week is out because the alternative helps nobody at all.")


def strip(t):
    return t.replace("...", "")


class TestLazify(unittest.TestCase):
    def test_short_text_untouched(self):
        for t in ("Sure.", "No.", "I don't think so.", "Yes, of course."):
            self.assertEqual(lazify(t), t)

    def test_strength_zero_disables(self):
        self.assertEqual(lazify(LONG, strength=0), LONG)

    def test_inserts_something_in_a_long_line(self):
        self.assertIn("...", lazify(LONG))

    def test_deterministic(self):
        """The same reply must hesitate identically every time it is spoken."""
        self.assertEqual(lazify(LONG), lazify(LONG))

    def test_only_adds_ellipses(self):
        """The layer may add pauses; it may never alter a word the assistant chose."""
        self.assertEqual(strip(lazify(LONG)), LONG)

    def test_inserts_only_after_function_words(self):
        out = lazify(LONG).split()
        for w in out:
            if w.endswith("..."):
                base = re.sub(r"[^a-z']", "", w[:-3].lower())
                self.assertIn(base, FUNCTION_WORDS, f"hesitated after {w!r}")

    def test_never_at_the_edges(self):
        out = lazify(LONG).split()
        self.assertFalse(out[0].endswith("..."))
        self.assertFalse(out[1].endswith("..."))
        self.assertFalse(out[-1].endswith("..."))

    def test_not_after_existing_punctuation(self):
        """Kokoro already pauses at punctuation; doubling it reads as a fault."""
        for w in lazify(LONG).split():
            if w.endswith("..."):
                self.assertFalse(re.search(r"[.,!?;:]$", w[:-3]), w)

    def test_respects_minimum_gap(self):
        out = lazify(LONG).split()
        hits = [i for i, w in enumerate(out) if w.endswith("...")]
        for a, b in zip(hits, hits[1:]):
            self.assertGreaterEqual(b - a, MIN_GAP_WORDS)

    def test_rate_is_near_the_measured_target(self):
        """Bella pauses mid-clause ~2.4 times per 100 syllables (7.8 total - 5.4
        already supplied by punctuation). Allow one pause of slack either way."""
        text = " ".join([LONG] * 4)
        n = lazify(text).count("...")
        syl = sum(max(len(re.findall(r"[aeiouy]+", w.lower())), 1) for w in text.split())
        want = syl / 100.0 * INSERT_PER_100_SYL
        self.assertLessEqual(abs(n - want), 1.5, f"{n} inserted, wanted ~{want:.1f}")


if __name__ == "__main__":
    unittest.main()
