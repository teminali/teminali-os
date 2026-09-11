"""The microphone gate must never close without something that reopens it.

`AudioInputProcessor.interrupted` decides whether incoming frames reach the
recogniser. It lives on a server-wide object that outlives every client, so a
close that is never released does not end with the session: it deafens the
server for the life of the process, and restarting the app does not clear it.

Measured 2026-09-11, which is why these tests exist: a server in that state
accepted 198 correctly framed frames of speech at -1.8 dBFS peak and produced
no partial, no final, and no log line. The same bytes against a freshly
started server transcribed perfectly.
"""
import time
import types
import unittest
from unittest import mock

import server


class StubTranscriber:
    def __init__(self):
        self.cleared = 0

    def clear_audio(self):
        self.cleared += 1


class StubAIP:
    def __init__(self):
        self.interrupted = False
        self.transcriber = StubTranscriber()

    def abort_generation(self):
        pass


class StubPipeline:
    def __init__(self):
        self.running_generation = None
        self.history = []

    def prepare_generation(self, txt):
        self.running_generation = types.SimpleNamespace(id=1, abortion_started=False)


def make_callbacks():
    """A TranscriptionCallbacks over stub state, with its worker thread stopped."""
    app = types.SimpleNamespace(state=types.SimpleNamespace())
    app.state.AudioInputProcessor = StubAIP()
    app.state.SpeechPipelineManager = StubPipeline()
    app.state.active_connections = []
    with mock.patch.object(server.threading, "Thread"):  # no background worker in tests
        cb = server.TranscriptionCallbacks(app)
    return cb, app


class Gate(unittest.TestCase):
    def test_gate_opens_and_closes_the_processor(self):
        cb, app = make_callbacks()
        cb.set_mic_gate(True, "test close")
        self.assertTrue(app.state.AudioInputProcessor.interrupted)
        cb.set_mic_gate(False, "test open")
        self.assertFalse(app.state.AudioInputProcessor.interrupted)

    def test_close_during_final_transcription_keeps_the_audio(self):
        # on_before_final closes the gate while Whisper is still transcribing
        # exactly that audio; clearing the buffer there would destroy it.
        cb, app = make_callbacks()
        before = app.state.AudioInputProcessor.transcriber.cleared
        cb.set_mic_gate(True, "end of turn", clear_audio=False)
        self.assertEqual(app.state.AudioInputProcessor.transcriber.cleared, before)


class TurnEndsWithoutAGeneration(unittest.TestCase):
    """Every exit from a turn that starts no generation must reopen the gate."""

    def test_empty_final_reopens(self):
        cb, app = make_callbacks()
        cb.on_before_final(b"", "")
        self.assertTrue(app.state.AudioInputProcessor.interrupted)
        cb.on_final("   ")
        self.assertFalse(app.state.AudioInputProcessor.interrupted)
        self.assertIsNone(app.state.SpeechPipelineManager.running_generation)

    def test_discarded_echo_reopens(self):
        cb, app = make_callbacks()
        cb.tts_client_playing = True          # busy, so the echo guard runs
        cb.on_before_final(b"", "")
        with mock.patch.object(server.asr_guard, "is_echo", return_value=(True, "test")):
            cb.on_final("thank you very much")
        self.assertFalse(app.state.AudioInputProcessor.interrupted)

    def test_discarded_silence_artifact_reopens(self):
        cb, app = make_callbacks()
        cb.tts_client_playing = True
        cb.on_before_final(b"", "")
        with mock.patch.object(server.asr_guard, "is_echo", return_value=(False, "")), \
             mock.patch.object(server.asr_guard, "is_silence_artifact", return_value=True):
            cb.on_final("Thank you.")
        self.assertFalse(app.state.AudioInputProcessor.interrupted)

    def test_a_real_final_keeps_the_gate_closed(self):
        # The one case that SHOULD stay closed: the assistant is about to speak.
        cb, app = make_callbacks()
        cb.on_before_final(b"", "")
        cb.on_final("what is the weather like today")
        self.assertTrue(app.state.AudioInputProcessor.interrupted)
        self.assertIsNotNone(app.state.SpeechPipelineManager.running_generation)


class Watchdog(unittest.TestCase):
    """The backstop for whatever closes the gate that we have not thought of."""

    def test_reopens_a_gate_stuck_with_nothing_in_flight(self):
        cb, app = make_callbacks()
        cb.set_mic_gate(True, "stuck")
        cb._mic_closed_since = time.time() - (server.MIC_STUCK_TIMEOUT + 1)
        cb.reopen_mic_if_stuck()
        self.assertFalse(app.state.AudioInputProcessor.interrupted)

    def test_leaves_it_closed_while_a_generation_runs(self):
        cb, app = make_callbacks()
        cb.set_mic_gate(True, "assistant turn")
        app.state.SpeechPipelineManager.running_generation = object()
        cb._mic_closed_since = time.time() - (server.MIC_STUCK_TIMEOUT + 1)
        cb.reopen_mic_if_stuck()
        self.assertTrue(app.state.AudioInputProcessor.interrupted)

    def test_leaves_it_closed_while_the_client_is_playing(self):
        cb, app = make_callbacks()
        cb.set_mic_gate(True, "assistant turn")
        cb.tts_client_playing = True
        cb._mic_closed_since = time.time() - (server.MIC_STUCK_TIMEOUT + 1)
        cb.reopen_mic_if_stuck()
        self.assertTrue(app.state.AudioInputProcessor.interrupted)

    def test_does_not_fire_before_the_timeout(self):
        cb, app = make_callbacks()
        cb.set_mic_gate(True, "assistant turn")
        cb.reopen_mic_if_stuck()
        self.assertTrue(app.state.AudioInputProcessor.interrupted)


class FreshClient(unittest.TestCase):
    def test_reset_turn_state_reopens_the_gate(self):
        # What a reconnecting client gets: the session a crashed one left
        # behind must not still be muted.
        cb, app = make_callbacks()
        cb.set_mic_gate(True, "previous client vanished mid-turn")
        cb.reset_turn_state()
        self.assertFalse(app.state.AudioInputProcessor.interrupted)


if __name__ == "__main__":
    unittest.main()
