"""The guard must kill phantom turns without ever swallowing a real short reply."""
import unittest

import numpy as np

import asr_guard as g


def speech(seconds=0.8, sr=16000, amp=0.25):
    """A tone at speaking level -- stands in for real voiced audio."""
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    return (amp * np.sin(2 * np.pi * 180 * t)).astype(np.float32)


def silence(seconds=0.8, sr=16000, amp=1e-4):
    """Room tone far below anything a voice reaches."""
    rng = np.random.default_rng(0)
    return (amp * rng.standard_normal(int(sr * seconds))).astype(np.float32)


class Normalise(unittest.TestCase):
    def test_strips_punctuation_and_case(self):
        self.assertEqual(g.normalise("...Thank you!"), "thank you")
        self.assertEqual(g.normalise("  THANKS.  "), "thanks")

    def test_artifact_matches_whole_transcript_only(self):
        self.assertTrue(g.is_silence_artifact("Thank you."))
        # Real speech that merely CONTAINS the phrase is not an artifact.
        self.assertFalse(g.is_silence_artifact("Thank you for the coffee."))
        self.assertFalse(g.is_silence_artifact("thank you, that worked"))


class Describe(unittest.TestCase):
    def test_handles_none_and_empty(self):
        for a in (None, np.zeros(0, dtype=np.float32)):
            self.assertFalse(g.describe(a)["known"])

    def test_int16_is_normalised_before_measuring(self):
        i16 = (speech() * 32767).astype(np.int16)
        self.assertAlmostEqual(g.describe(i16)["peak_dbfs"],
                               g.describe(speech())["peak_dbfs"], delta=0.1)

    def test_silence_measures_far_below_speech(self):
        self.assertLess(g.describe(silence())["peak_dbfs"],
                        g.describe(speech())["peak_dbfs"] - 40)


class Suppression(unittest.TestCase):
    def test_phantom_thank_you_over_silence_is_dropped(self):
        drop, why = g.is_hallucination("Thank you.", g.describe(silence()))
        self.assertTrue(drop, why)

    def test_real_thank_you_with_speech_energy_survives(self):
        """The whole point: she must not go deaf to an actual thank you."""
        drop, _ = g.is_hallucination("Thank you.", g.describe(speech()))
        self.assertFalse(drop)

    def test_real_sentence_over_silence_is_left_alone(self):
        """Not our business -- only the known stock phrases are ever suppressed."""
        drop, _ = g.is_hallucination("Book me a flight to Rome.", g.describe(silence()))
        self.assertFalse(drop)

    def test_no_audio_lets_the_phrase_through(self):
        """Without corroboration, favour the false negative over deafness."""
        drop, why = g.is_hallucination("Thank you.", g.describe(None))
        self.assertFalse(drop)
        self.assertIn("no audio", why)

    def test_empty_and_none_text_are_not_suppressed_here(self):
        for t in (None, "", "   "):
            self.assertFalse(g.is_hallucination(t, g.describe(silence()))[0])


class Echo(unittest.TestCase):
    """The loop that ran a whole conversation with no operator in it (2026-09-09)."""

    def setUp(self):
        g.reset_spoken()

    def test_her_own_words_coming_back_are_dropped(self):
        g.note_spoken("Because you're not saying it. You're waiting for me to ask.")
        drop, why = g.is_echo("I'm waiting for you to ask, then ask.")
        self.assertTrue(drop, why)

    def test_real_request_survives(self):
        g.note_spoken("Because you're not saying it. You're waiting for me to ask.")
        self.assertFalse(g.is_echo("Book me a flight to Rome on Tuesday.")[0])

    def test_short_human_turns_are_never_swallowed(self):
        g.note_spoken("Then ask. I'm waiting.")
        for t in ("yes", "no", "go on", "stop"):
            self.assertFalse(g.is_echo(t)[0], t)

    def test_nothing_spoken_means_nothing_is_echo(self):
        self.assertFalse(g.is_echo("I'm waiting for you to ask, then ask.")[0])

    def test_expires_outside_the_window(self):
        g.note_spoken("You're waiting for me to ask.")
        drop, _ = g.is_echo("I'm waiting for you to ask, then ask.",
                            now=__import__("time").monotonic() + g.ECHO_WINDOW_S + 1)
        self.assertFalse(drop)

    def test_reset_clears_history(self):
        g.note_spoken("You're waiting for me to ask.")
        g.reset_spoken()
        self.assertFalse(g.is_echo("I'm waiting for you to ask, then ask.")[0])

    def test_documented_miss_is_documented(self):
        """The badly-mangled echo escapes by design; asserted so it is not a surprise."""
        g.note_spoken("I want to know if you're afraid of what you're about to say.")
        drop, _ = g.is_echo("What I'm about to say. What makes you think of "
                            "something to say to you?")
        self.assertFalse(drop, "if this now passes, the threshold changed -- update the note")
