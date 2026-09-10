import asyncio
import logging
import os
import struct
import threading
import time
from collections import namedtuple
from queue import Queue
from typing import Callable, Generator, Optional

import numpy as np
from huggingface_hub import hf_hub_download
# Assuming RealtimeTTS is installed and available
from RealtimeTTS import (CoquiEngine, KokoroEngine, OrpheusEngine,
                         OrpheusVoice, TextToAudioStream)

from delivery import lazify
import asr_guard

logger = logging.getLogger(__name__)

# Default configuration constants
START_ENGINE = "kokoro"
Silence = namedtuple("Silence", ("comma", "sentence", "default"))
ENGINE_SILENCES = {
    "coqui":   Silence(comma=0.3, sentence=0.6, default=0.3),
    "kokoro":  Silence(comma=0.3, sentence=0.6, default=0.3),
    "orpheus": Silence(comma=0.3, sentence=0.6, default=0.3),
}
# Stream chunk sizes influence latency vs. throughput trade-offs
QUICK_ANSWER_STREAM_CHUNK_SIZE = 8
FINAL_ANSWER_STREAM_CHUNK_SIZE = 30

# Coqui model download helper functions
def create_directory(path: str) -> None:
    """
    Creates a directory at the specified path if it doesn't already exist.

    Args:
        path: The directory path to create.
    """
    if not os.path.exists(path):
        os.makedirs(path)

def ensure_lasinya_models(models_root: str = "models", model_name: str = "Lasinya") -> None:
    """
    Ensures the Coqui XTTS Lasinya model files are present locally.

    Checks for required model files (config.json, vocab.json, etc.) within
    the specified directory structure. If any file is missing, it downloads
    it from the 'KoljaB/XTTS_Lasinya' Hugging Face Hub repository.

    Args:
        models_root: The root directory where models are stored.
        model_name: The specific name of the model subdirectory.
    """
    base = os.path.join(models_root, model_name)
    create_directory(base)
    files = ["config.json", "vocab.json", "speakers_xtts.pth", "model.pth"]
    for fn in files:
        local_file = os.path.join(base, fn)
        if not os.path.exists(local_file):
            # Not using logger here as it might not be configured yet during module import/init
            print(f"👄⏬ Downloading {fn} to {base}")
            hf_hub_download(
                repo_id="KoljaB/XTTS_Lasinya",
                filename=fn,
                local_dir=base
            )

class AudioProcessor:
    """
    Manages Text-to-Speech (TTS) synthesis using various engines via RealtimeTTS.

    This class initializes a chosen TTS engine (Coqui, Kokoro, or Orpheus),
    configures it for streaming output, measures initial latency (TTFT),
    and provides methods to synthesize audio from text strings or generators,
    placing the resulting audio chunks into a queue. It handles dynamic
    stream parameter adjustments and manages the synthesis lifecycle, including
    optional callbacks upon receiving the first audio chunk.
    """
    def __init__(
            self,
            engine: str = START_ENGINE,
            orpheus_model: str = "orpheus-3b-0.1-ft-Q8_0-GGUF/orpheus-3b-0.1-ft-q8_0.gguf",
        ) -> None:
        """
        Initializes the AudioProcessor with a specific TTS engine.

        Sets up the chosen engine (Coqui, Kokoro, Orpheus), downloads Coqui models
        if necessary, configures the RealtimeTTS stream, and performs an initial
        synthesis to measure Time To First Audio chunk (TTFA).

        Args:
            engine: The name of the TTS engine to use ("coqui", "kokoro", "orpheus").
            orpheus_model: The path or identifier for the Orpheus model file (used only if engine is "orpheus").
        """
        self.engine_name = engine
        self.stop_event = threading.Event()
        self.finished_event = threading.Event()
        self.audio_chunks = asyncio.Queue() # Queue for synthesized audio output
        self.orpheus_model = orpheus_model

        self.silence = ENGINE_SILENCES.get(engine, ENGINE_SILENCES[self.engine_name])
        self.current_stream_chunk_size = QUICK_ANSWER_STREAM_CHUNK_SIZE # Initial chunk size

        # Dynamically load and configure the selected TTS engine
        if engine == "coqui":
            ensure_lasinya_models(models_root="models", model_name="Lasinya")
            self.engine = CoquiEngine(
                specific_model="Lasinya",
                local_models_path="./models",
                voice="reference_audio.wav",
                speed=1.1,
                use_deepspeed=True,
                thread_count=6,
                stream_chunk_size=self.current_stream_chunk_size,
                overlap_wav_len=1024,
                load_balancing=True,
                load_balancing_buffer_length=0.5,
                load_balancing_cut_off=0.1,
                add_sentence_filter=True,
            )
        elif engine == "kokoro":
            # bf_emma unblended. Measured 2026-09-09 against Benedetta Porcaroli's two
            # reference cuts on six acoustic axes (F0, pitch range, HNR, spectral tilt,
            # F1, F2): emma 73.1%, the previous bella_exact_custom.pt tensor 66.8%. For
            # calibration Bella's own two cuts score 71.7% against each other, so emma is
            # already inside the noise floor of "same speaker, different sentence" and no
            # blend tested beat her. See resources/bella/blend_emma_sara.py.
            default_voice = self.BELLA_DEFAULT_VOICE
            kokoro_voice = os.getenv("KOKORO_VOICE", default_voice)
            kokoro_speed = float(os.getenv("KOKORO_SPEED", "1.10"))
            self.engine = KokoroEngine(
                voice=kokoro_voice,
                default_speed=kokoro_speed,
                trim_silence=True,
                silence_threshold=0.01,
                extra_start_ms=25,
                extra_end_ms=60,
                fade_in_ms=15,
                fade_out_ms=45,
            )
        elif engine == "orpheus":
            self.engine = OrpheusEngine(
                model=self.orpheus_model,
                temperature=0.8,
                top_p=0.95,
                repetition_penalty=1.1,
                max_tokens=1200,
            )
            voice = OrpheusVoice("tara")
            self.engine.set_voice(voice)
        else:
            raise ValueError(f"Unsupported engine: {engine}")


        # Initialize the RealtimeTTS stream
        self.stream = TextToAudioStream(
            self.engine,
            muted=True, # Do not play audio directly
            playout_chunk_size=4096, # Internal chunk size for processing
            on_audio_stream_stop=self.on_audio_stream_stop,
        )

        # Ensure Coqui engine starts with the quick chunk size
        if self.engine_name == "coqui" and hasattr(self.engine, 'set_stream_chunk_size') and self.current_stream_chunk_size != QUICK_ANSWER_STREAM_CHUNK_SIZE:
            logger.info(f"👄⚙️ Setting Coqui stream chunk size to {QUICK_ANSWER_STREAM_CHUNK_SIZE} for initial setup.")
            self.engine.set_stream_chunk_size(QUICK_ANSWER_STREAM_CHUNK_SIZE)
            self.current_stream_chunk_size = QUICK_ANSWER_STREAM_CHUNK_SIZE

        # Prewarm the engine
        self.stream.feed("prewarm")
        play_kwargs = dict(
            log_synthesized_text=False, # Don't log prewarm text
            muted=True,
            fast_sentence_fragment=False,
            comma_silence_duration=self.silence.comma,
            sentence_silence_duration=self.silence.sentence,
            default_silence_duration=self.silence.default,
            force_first_fragment_after_words=999999, # Effectively disable this
        )
        self.stream.play(**play_kwargs) # Synchronous play for prewarm
        # Wait for prewarm to finish (indicated by on_audio_stream_stop)
        while self.stream.is_playing():
            time.sleep(0.01)
        self.finished_event.wait() # Wait for stop callback
        self.finished_event.clear()

        # Measure Time To First Audio (TTFA)
        start_time = time.time()
        ttfa = None
        def on_audio_chunk_ttfa(chunk: bytes):
            nonlocal ttfa
            if ttfa is None:
                ttfa = time.time() - start_time
                logger.debug(f"👄⏱️ TTFA measurement first chunk arrived, TTFA: {ttfa:.2f}s.")

        self.stream.feed("This is a test sentence to measure the time to first audio chunk.")
        play_kwargs_ttfa = dict(
            on_audio_chunk=on_audio_chunk_ttfa,
            log_synthesized_text=False, # Don't log test sentence
            muted=True,
            fast_sentence_fragment=False,
            comma_silence_duration=self.silence.comma,
            sentence_silence_duration=self.silence.sentence,
            default_silence_duration=self.silence.default,
            force_first_fragment_after_words=999999,
        )
        self.stream.play_async(**play_kwargs_ttfa)

        # Wait until the first chunk arrives or stream finishes
        while ttfa is None and (self.stream.is_playing() or not self.finished_event.is_set()):
            time.sleep(0.01)
        self.stream.stop() # Ensure stream stops cleanly

        # Wait for stop callback if it hasn't fired yet
        if not self.finished_event.is_set():
            self.finished_event.wait(timeout=2.0) # Add timeout for safety
        self.finished_event.clear()

        if ttfa is not None:
            logger.debug(f"👄⏱️ TTFA measurement complete. TTFA: {ttfa:.2f}s.")
            self.tts_inference_time = ttfa * 1000  # Store as ms
        else:
            logger.warning("👄⚠️ TTFA measurement failed (no audio chunk received).")
            self.tts_inference_time = 0

        # Callbacks to be set externally if needed
        self.on_first_audio_chunk_synthesize: Optional[Callable[[], None]] = None

    # Predefined emotion configurations
    # Calibrated to Countess Isabella 'Bella' Soranza de Parme (Benedetta Porcaroli in The Gentlemen S2)
    # Core architecture: Decoupled 256-dim style tensor with vocal tract timbre ([:128]) and prosodic cadence ([128:])
    BELLA_CUSTOM_PT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "bella", "audio_samples", "bella_exact_custom.pt")
    BELLA_DECOUPLED_VOICE = BELLA_CUSTOM_PT if os.path.exists(BELLA_CUSTOM_PT) else "0.45*bf_isabella + 0.40*bf_emma + 0.15*af_nicole"
    # A three-way blend, both halves of the style tensor. bf_emma must
    # lead the formula: RealtimeTTS reads a blend's lang_code from its FIRST segment
    # (kokoro_engine._get_lang_code_from_voice), so leading with if_sara would apply
    # the Italian frontend to English text. Whisper transcribes this blend at 0.0% WER.
    #
    # This replaces plain bf_emma, and it overturns the note that stood here before --
    # that no blend could win because tilt and harmonicity pull in opposite directions.
    # The facts in that note are correct and still are; the conclusion was drawn from a
    # distance score that ranks on F1/F2/tilt and does not include HNR at all. Measured
    # on 2026-09-09 against her two reference cuts:
    #
    #                  F0     range    HNR    tilt     F2
    #   her target    ~200   7.0st   3.6-5.5  -12.1   1814
    #   plain emma     182.9  7.0st     0.9   -13.7   1891
    #   this blend     204.7  9.1st     3.4   -18.4   1831
    #
    # It wins her pitch, her F2 and most of the harmonicity gap -- emma is two to four
    # times grainier than she is -- and pays for it in spectral tilt, which goes darker
    # than hers, and in pitch range, which overshoots 7.0st. That trade was made BY EAR:
    # the user rejected plain emma as "sharp" and picked this blend in an A/B against it.
    # Do not revert it on the strength of the tilt number alone. The same day, the same
    # kind of distance score sent the delivery layer chasing a 0.71s mid-clause pause
    # that turned out to be an artifact of pooling her sentence pauses with her
    # hesitations -- see resources/bella/timing_metric.py, pause_med_mid.
    #
    # af_nicole was then added at 0.25, by ear, for a lazier and more knowing register.
    # It was expected to cost harmonicity -- af_nicole is the grainiest of the ten at
    # HNR 0.2 -- and measurably did not. Rendered on her own held-out line, walking
    # nicole 0.00 -> 0.25 over the emma/sara pair moved:
    #
    #                    F0    range    HNR    tilt     F2
    #   her target      ~200   7.0st  3.6-5.5  -12.1   1814
    #   without nicole  204.1  9.8st    1.6    -20.2   1416
    #   with 0.25       185.0  8.4st    1.7    -19.5   1795
    #
    # HNR flat, pitch range 1.4st closer to hers, and F2 from 1416 to within 19 Hz of
    # her 1814. Whisper transcribes it at 0.0% WER, so the Italian and American vowels
    # are not leaking through the British frontend. F0 does drop below her ~200.
    #
    # Those figures are measured with librosa trim on the holdout line and are NOT
    # comparable to the emma/sara table above, which used the fit line and a different
    # trim -- compare within a ladder, never across the two. Reproduce either with
    # resources/bella/blend_emma_sara.py.
    BELLA_DEFAULT_VOICE = "0.30*bf_emma + 0.45*if_sara + 0.25*af_nicole"

    # Mid-clause hesitation rate, 1.0 = Bella's measured rate. See delivery.py; the
    # numbers come from resources/bella/timing_metric.py --vs-emma against 46 s of
    # her real speech. 0 disables the layer without removing it.
    BELLA_DELIVERY_STRENGTH = 1.0
    # Deeper contralto variant: heavier chest-register timbre and a slower prosodic
    # cadence, built from the same licensed Kokoro voice actors. Generated by
    # resources/bella/generate_decoupled_bella_benchmarks.py.
    BELLA_DEEP_PT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "bella", "audio_samples", "bella_neural_deep.pt")
    BELLA_DEEP_VOICE = BELLA_DEEP_PT if os.path.exists(BELLA_DEEP_PT) else "0.60*bf_emma + 0.25*bf_isabella + 0.15*af_sarah"
    # Numerically fitted registers. Blend weights were solved against measured
    # register/timbre/phonation descriptors rather than picked by ear; see
    # resources/bella/fit_style_tensor.py. Two tensors because the reference cuts
    # sit in genuinely different registers (~226 Hz seductive, ~180 Hz cold).
    BELLA_FIT_SEDUCTIVE_PT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "bella", "audio_samples", "bella_fitted_seductive.pt")
    BELLA_FIT_AUTHORITY_PT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "bella", "audio_samples", "bella_fitted_authority.pt")
    BELLA_FIT_SEDUCTIVE_VOICE = BELLA_FIT_SEDUCTIVE_PT if os.path.exists(BELLA_FIT_SEDUCTIVE_PT) else "0.62*af_bella + 0.22*bf_isabella + 0.09*af_sky + 0.07*af_heart"
    BELLA_FIT_AUTHORITY_VOICE = BELLA_FIT_AUTHORITY_PT if os.path.exists(BELLA_FIT_AUTHORITY_PT) else "0.47*af_bella + 0.27*bf_alice + 0.16*bf_emma + 0.10*bf_isabella"

    # Emotion morphing is now SPEED-ONLY. Each tag used to swap in its own
    # isabella/emma/nicole blend; all of those measured below plain bf_emma, and most
    # leaned on af_nicole, the worst voice in the pool on harmonicity (0.2 dB) --
    # precisely the axis emma is already weakest on. Swapping the voice per tag made
    # the default worse several times a turn. The speeds are unchanged and still
    # carry the emotional variation.
    EMOTION_CONFIG = {
        "default": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.10,
        },
        "intimate": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.07,
        },
        "tender": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.07,
        },
        "softly": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.07,
        },
        "breath": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.05,
        },
        "playful": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.12,
        },
        "chuckle": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.12,
        },
        "witty": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.13,
        },
        "thoughtful": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.08,
        },
        "comforting": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.08,
        },
        "reassuring": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.08,
        },
        "serious": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.10,
        },
        "firm": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.11,
        },
        "warm": {
            "voice": BELLA_DEFAULT_VOICE,
            "speed": 1.10,
        },
    }

    VOICE_PROFILES = {
        "bella_soranza": {
            "name": "👑 Countess Bella Soranza (measured default)",
            "description": "bf_emma unblended at 1.10x. Closest of everything tested to Benedetta Porcaroli's reference cuts: 73.1% across F0, pitch range, HNR, spectral tilt and F1/F2, where her own two cuts score 71.7% against each other. Not a clone -- a licensed voice that lands in her register.",
            "formula": BELLA_DEFAULT_VOICE,
            "speed": 1.10,
        },
        "bella_decoupled": {
            "name": "🧬 Bella Decoupled (previous default, superseded)",
            "description": "bella_exact_custom.pt, the fitted 256-dim style tensor that shipped until 2026-09-09. Measured 66.8% on the same six axes against plain bf_emma's 73.1%, so it was replaced. Kept selectable.",
            "formula": BELLA_DECOUPLED_VOICE,
            "speed": 1.10,
        },
        "bella_fit_authority": {
            "name": "🧊 Bella Fitted / Cold Authority (measured)",
            "description": "Solved blend, not hand-picked: F0 181.6 Hz against a 179.5 Hz target (1.2% off), jitter 2.30 vs 2.01. Residual is delivery flatness -- 5.1 st of pitch movement vs 2.3 in the reference, which no Kokoro blend can reach.",
            "formula": BELLA_FIT_AUTHORITY_VOICE,
            "speed": 1.07,
        },
        "bella_fit_seductive": {
            "name": "🌹 Bella Fitted / Seductive (measured)",
            "description": "Solved blend for the higher, warmer register: F0 212 Hz against a 226 Hz target, tilt and jitter close. Best overall fit cost of the set (0.909).",
            "formula": BELLA_FIT_SEDUCTIVE_VOICE,
            "speed": 1.06,
        },
        "bella_neural_deep": {
            "name": "🎶 Bella Neural Deep (Contralto Register)",
            "description": "Timbre (Emma 60% + Isabella 25% + Sarah 15%) + Prosody (Isabella 40% + Nicole 30% + Sara 15% + Emma 15%) at 1.05x — lowest chest resonance with a slower cadence for vocal-fry decay",
            "formula": BELLA_DEEP_VOICE,
            "speed": 1.05,
        },
        "bella_velvet_noir": {
            "name": "🌙 Bella Velvet Noir (Lowest Smoky Register)",
            "description": "55% Emma + 30% Sarah + 15% Isabella at 1.08x — Deepest chest resonance & sultry vocal fry",
            "formula": "0.55*bf_emma + 0.30*af_sarah + 0.15*bf_isabella",
            "speed": 1.08,
        },
        "royal_velvet": {
            "name": "👑 Royal Velvet",
            "description": "Nicole (65%) + Isabella (35%) — Intimate warmth & British clarity",
            "formula": "0.65*af_nicole + 0.35*bf_isabella",
            "speed": 1.14,
        },
        "pure_isabella": {
            "name": "💎 Pure Isabella",
            "description": "100% Isabella — Aristocratic British diction",
            "formula": "bf_isabella",
            "speed": 1.15,
        },
    }

    def set_voice_profile(self, profile_key: str) -> bool:
        """Switches the active voice profile and updates default emotion settings."""
        if profile_key not in self.VOICE_PROFILES:
            logger.warning(f"👄⚠️ Unknown voice profile: {profile_key}")
            return False
        prof = self.VOICE_PROFILES[profile_key]
        self.current_profile_key = profile_key
        self.EMOTION_CONFIG["default"]["voice"] = prof["formula"]
        self.EMOTION_CONFIG["default"]["speed"] = prof["speed"]
        if self.engine_name == "kokoro":
            try:
                self.engine.set_voice(prof["formula"])
                self.engine.set_speed(prof["speed"])
                logger.info(f"👄🎛️ Voice Profile switched to: {prof['name']} ({prof['formula']} at {prof['speed']}x)")
                return True
            except Exception as e:
                logger.error(f"👄💥 Error switching voice profile to {profile_key}: {e}")
                return False
        return True

    def set_emotion(self, emotion: str) -> None:
        """Dynamically morphs Kokoro voice blend and speed based on emotion tag."""
        if self.engine_name != "kokoro":
            return
        tag = (emotion or "default").lower().strip()
        cfg = self.EMOTION_CONFIG.get(tag, self.EMOTION_CONFIG["default"])
        try:
            self.engine.set_voice(cfg["voice"])
            self.engine.set_speed(cfg["speed"])
            logger.info(f"👄✨ Voice morphed to [{tag}]: voice='{cfg['voice']}', speed={cfg['speed']}")
        except Exception as e:
            logger.warning(f"👄⚠️ Failed to morph voice to [{tag}]: {e}")

    def _apply_delivery(self, text: str) -> str:
        """Insert Bella's mid-clause hesitations before the text reaches the engine.

        Kokoro only: the layer's rate and placement were fitted to her voice, and the
        other engines have their own prosody. On the streamed path this sees partial
        chunks rather than whole sentences; delivery.lazify() returns anything under
        MIN_WORDS unchanged, so a short chunk degrades to a no-op instead of picking
        up a hesitation it has no room for.
        """
        if self.engine_name != "kokoro" or not self.BELLA_DELIVERY_STRENGTH:
            return text
        try:
            return lazify(text, self.BELLA_DELIVERY_STRENGTH)
        except Exception:
            logger.exception("👄 delivery layer failed; speaking the line unchanged")
            return text

    def apply_emotion_tag(self, text: str) -> str:
        """
        Detects leading emotion tags like [intimate], [playful], morphs voice,
        phonetically converts stage actions (e.g. -laughs softly-) into real spoken
        laughter sounds ('Haha, '), and strips forbidden cliches and markdown symbols.
        """
        import re
        if not text:
            return ""
        m = re.match(r'^\s*\[([a-zA-Z]+)\]\s*', text)
        if m:
            tag = m.group(1).lower()
            self.set_emotion(tag)
            text = text[m.end():]
            # If [chuckle] tag is chosen and text doesn't start with a laugh/chuckle, add a natural vocalization
            if tag == "chuckle" and not re.match(r'^\s*(?:heh|hah|haha|aha|pfft)', text, re.IGNORECASE):
                text = "Heh... " + text

        # Convert laugh/chuckle stage directions in hyphens, asterisks, or brackets into authentic vocal laughter
        text = re.sub(r'[-\*\(]\s*(?:laughs?|chuckles?|giggles?|cackles?)[^-\*\)]*[-\*\)]', ' Heh... ', text, flags=re.IGNORECASE)
        # Convert sighs/exhales into natural breathing sound
        text = re.sub(r'[-\*\(]\s*(?:sighs?|exhales?|gasps?)[^-\*\)]*[-\*\)]', ' Ah... ', text, flags=re.IGNORECASE)
        # Remove silent physical action descriptions (smiles, winks, leans in, pauses, etc.)
        text = re.sub(r'[-\*\(]\s*(?:smiles?|grins?|winks?|pauses?|leans?[^-\*\)]*)[-\*\)]', '', text, flags=re.IGNORECASE)
        # Strip any remaining asterisks or bracketed actions
        text = re.sub(r'\*[^*]+\*', '', text)
        text = text.replace('*', '').replace('#', '')

        # Sanitize forbidden repetitive clichés like "my love", "honey", "darling", "babe"
        text = re.sub(r',\s*my love\b', '', text, flags=re.IGNORECASE)
        text = re.sub(r'\bmy love\b', '', text, flags=re.IGNORECASE)
        text = re.sub(r'\b(honey|darling|sweetheart|babe)\b', '', text, flags=re.IGNORECASE)

        # Clean up punctuation artifacts
        text = re.sub(r',\s*,', ',', text)
        text = re.sub(r',\s*\.', '.', text)
        text = re.sub(r'\s+([,\.!\?])', r'\1', text)
        text = re.sub(r'\s{2,}', ' ', text).strip()
        return text

    def on_audio_stream_stop(self) -> None:
        """
        Callback executed when the RealtimeTTS audio stream stops processing.

        Logs the event and sets the `finished_event` to signal completion or stop.
        """
        logger.info("👄🛑 Audio stream stopped.")
        self.finished_event.set()

    def stop(self) -> None:
        """Immediately halts ongoing synthesis, stops the stream, and resets finished state."""
        try:
            if hasattr(self, 'stream') and self.stream:
                self.stream.stop()
        except Exception as e:
            logger.warning(f"👄⚠️ Error stopping TTS stream: {e}")
        self.finished_event.set()

    def stop_playback(self) -> None:
        """Alias for stop() to support external callers."""
        self.stop()

    def synthesize(
            self,
            text: str,
            audio_chunks: Queue, 
            stop_event: threading.Event,
            generation_string: str = "",
        ) -> bool:
        """
        Synthesizes audio from a complete text string and puts chunks into a queue.

        Feeds the entire text string to the TTS engine. As audio chunks are generated,
        they are potentially buffered initially for smoother streaming and then put
        into the provided queue. Synthesis can be interrupted via the stop_event.
        Skips initial silent chunks if using the Orpheus engine. Triggers the
        `on_first_audio_chunk_synthesize` callback when the first valid audio chunk is queued.

        Args:
            text: The text string to synthesize.
            audio_chunks: The queue to put the resulting audio chunks (bytes) into.
                          This should typically be the instance's `self.audio_chunks`.
            stop_event: A threading.Event to signal interruption of the synthesis.
                        This should typically be the instance's `self.stop_event`.
            generation_string: An optional identifier string for logging purposes.

        Returns:
            True if synthesis completed fully, False if interrupted by stop_event.
        """
        if self.engine_name == "coqui" and hasattr(self.engine, 'set_stream_chunk_size') and self.current_stream_chunk_size != QUICK_ANSWER_STREAM_CHUNK_SIZE:
            logger.info(f"👄⚙️ {generation_string} Setting Coqui stream chunk size to {QUICK_ANSWER_STREAM_CHUNK_SIZE} for quick synthesis.")
            self.engine.set_stream_chunk_size(QUICK_ANSWER_STREAM_CHUNK_SIZE)
            self.current_stream_chunk_size = QUICK_ANSWER_STREAM_CHUNK_SIZE

        text = self._apply_delivery(self.apply_emotion_tag(text))
        # Remember what she is about to say, so the ASR can recognise it coming
        # back through the speakers as a fake operator turn. See asr_guard.is_echo.
        asr_guard.note_spoken(text)
        self.stream.feed(text)
        self.finished_event.clear() # Reset finished event before starting

        # Buffering state variables
        buffer: list[bytes] = []
        good_streak: int = 0
        buffering: bool = True
        buf_dur: float = 0.0
        SR, BPS = 24000, 2 # Assumed Sample Rate and Bytes Per Sample (16-bit)
        start = time.time()
        self._quick_prev_chunk_time: float = 0.0 # Track time of previous chunk

        def on_audio_chunk(chunk: bytes):
            nonlocal buffer, good_streak, buffering, buf_dur, start
            # Check for interruption signal
            if stop_event.is_set():
                logger.info(f"👄🛑 {generation_string} Quick audio stream interrupted by stop_event. Text: {text[:50]}...")
                # We should not put more chunks, let the main loop handle stream stop
                return

            now = time.time()
            samples = len(chunk) // BPS
            play_duration = samples / SR # Duration of the current chunk

            # --- Orpheus specific: Skip initial silence ---
            if on_audio_chunk.first_call and self.engine_name == "orpheus":
                if not hasattr(on_audio_chunk, "silent_chunks_count"):
                    # Initialize silence detection state
                    on_audio_chunk.silent_chunks_count = 0
                    on_audio_chunk.silent_chunks_time = 0.0
                    on_audio_chunk.silence_threshold = 200 # Amplitude threshold for silence

                try:
                    # Analyze chunk for silence
                    fmt = f"{samples}h" # Format for 16-bit signed integers
                    pcm_data = struct.unpack(fmt, chunk)
                    avg_amplitude = np.abs(np.array(pcm_data)).mean()

                    if avg_amplitude < on_audio_chunk.silence_threshold:
                        on_audio_chunk.silent_chunks_count += 1
                        on_audio_chunk.silent_chunks_time += play_duration
                        logger.debug(f"👄⏭️ {generation_string} Quick Skipping silent chunk {on_audio_chunk.silent_chunks_count} (avg_amp: {avg_amplitude:.2f})")
                        return # Skip this chunk
                    elif on_audio_chunk.silent_chunks_count > 0:
                        # First non-silent chunk after silence
                        logger.info(f"👄⏭️ {generation_string} Quick Skipped {on_audio_chunk.silent_chunks_count} silent chunks, saved {on_audio_chunk.silent_chunks_time*1000:.2f}ms")
                        # Proceed to process this non-silent chunk
                except Exception as e:
                    logger.warning(f"👄⚠️ {generation_string} Quick Error analyzing audio chunk for silence: {e}")
                    # Proceed assuming not silent on error

            # --- Timing and Logging ---
            if on_audio_chunk.first_call:
                on_audio_chunk.first_call = False
                self._quick_prev_chunk_time = now
                ttfa_actual = now - start
                logger.info(f"👄🚀 {generation_string} Quick audio start. TTFA: {ttfa_actual:.2f}s. Text: {text[:50]}...")
            else:
                gap = now - self._quick_prev_chunk_time
                self._quick_prev_chunk_time = now
                if gap <= play_duration * 1.1: # Allow small tolerance
                    # logger.debug(f"👄✅ {generation_string} Quick chunk ok (gap={gap:.3f}s ≤ {play_duration:.3f}s). Text: {text[:50]}...")
                    good_streak += 1
                else:
                    logger.warning(f"👄❌ {generation_string} Quick chunk slow (gap={gap:.3f}s > {play_duration:.3f}s). Text: {text[:50]}...")
                    good_streak = 0 # Reset streak on slow chunk

            put_occurred_this_call = False # Track if put happened in this specific call

            # --- Buffering Logic ---
            buffer.append(chunk) # Always append the received chunk first
            buf_dur += play_duration # Update buffer duration

            if buffering:
                # Check conditions to flush buffer and stop buffering
                if good_streak >= 2 or buf_dur >= 0.5: # Flush if stable or buffer > 0.5s
                    logger.info(f"👄➡️ {generation_string} Quick Flushing buffer (streak={good_streak}, dur={buf_dur:.2f}s).")
                    for c in buffer:
                        try:
                            audio_chunks.put_nowait(c)
                            put_occurred_this_call = True
                        except asyncio.QueueFull:
                            logger.warning(f"👄⚠️ {generation_string} Quick audio queue full, dropping chunk.")
                    buffer.clear()
                    buf_dur = 0.0 # Reset buffer duration
                    buffering = False # Stop buffering mode
            else: # Not buffering, put chunk directly
                try:
                    audio_chunks.put_nowait(chunk)
                    put_occurred_this_call = True
                except asyncio.QueueFull:
                    logger.warning(f"👄⚠️ {generation_string} Quick audio queue full, dropping chunk.")


            # --- First Chunk Callback ---
            if put_occurred_this_call and not on_audio_chunk.callback_fired:
                if self.on_first_audio_chunk_synthesize:
                    try:
                        logger.info(f"👄🚀 {generation_string} Quick Firing on_first_audio_chunk_synthesize.")
                        self.on_first_audio_chunk_synthesize()
                    except Exception as e:
                        logger.error(f"👄💥 {generation_string} Quick Error in on_first_audio_chunk_synthesize callback: {e}", exc_info=True)
                # Ensure callback fires only once per synthesize call
                on_audio_chunk.callback_fired = True

        # Initialize callback state for this run
        on_audio_chunk.first_call = True
        on_audio_chunk.callback_fired = False

        play_kwargs = dict(
            log_synthesized_text=True, # Log the text being synthesized
            on_audio_chunk=on_audio_chunk,
            muted=True, # We handle audio via the queue
            fast_sentence_fragment=False, # Standard processing
            comma_silence_duration=self.silence.comma,
            sentence_silence_duration=self.silence.sentence,
            default_silence_duration=self.silence.default,
            force_first_fragment_after_words=999999, # Don't force early fragments
        )

        logger.info(f"👄▶️ {generation_string} Quick Starting synthesis. Text: {text[:50]}...")
        self.stream.play_async(**play_kwargs)

        # Wait loop for completion or interruption
        while self.stream.is_playing() or not self.finished_event.is_set():
            if stop_event.is_set():
                self.stream.stop()
                logger.info(f"👄🛑 {generation_string} Quick answer synthesis aborted by stop_event. Text: {text[:50]}...")
                # Drain remaining buffer if any? Decided against it to stop faster.
                buffer.clear()
                # Wait briefly for stop confirmation? The finished_event handles this.
                self.finished_event.wait(timeout=1.0) # Wait for stream stop confirmation
                return False # Indicate interruption
            time.sleep(0.01)

        # If loop exited normally, check if buffer still has content (stream finished before flush)
        if buffering and buffer and not stop_event.is_set():
            logger.info(f"👄➡️ {generation_string} Quick Flushing remaining buffer after stream finished.")
            for c in buffer:
                 try:
                    audio_chunks.put_nowait(c)
                 except asyncio.QueueFull:
                    logger.warning(f"👄⚠️ {generation_string} Quick audio queue full on final flush, dropping chunk.")
            buffer.clear()
            if self.on_first_audio_chunk_synthesize and not on_audio_chunk.callback_fired:
                try:
                    logger.info(f"👄🚀 {generation_string} Quick Firing on_first_audio_chunk_synthesize on flush.")
                    self.on_first_audio_chunk_synthesize()
                except Exception as e:
                    logger.error(f"👄💥 Error in on_first_audio_chunk_synthesize on flush: {e}", exc_info=True)
                on_audio_chunk.callback_fired = True

        logger.info(f"👄✅ {generation_string} Quick answer synthesis complete. Text: {text[:50]}...")
        return True # Indicate successful completion

    def synthesize_generator(
            self,
            generator: Generator[str, None, None],
            audio_chunks: Queue, # Should match self.audio_chunks type
            stop_event: threading.Event,
            generation_string: str = "",
        ) -> bool:
        """
        Synthesizes audio from a generator yielding text chunks and puts audio into a queue.

        Feeds text chunks yielded by the generator to the TTS engine. As audio chunks
        are generated, they are potentially buffered initially and then put into the
        provided queue. Synthesis can be interrupted via the stop_event.
        Skips initial silent chunks if using the Orpheus engine. Sets specific playback
        parameters when using the Orpheus engine. Triggers the
       `on_first_audio_chunk_synthesize` callback when the first valid audio chunk is queued.


        Args:
            generator: A generator yielding text chunks (strings) to synthesize.
            audio_chunks: The queue to put the resulting audio chunks (bytes) into.
                          This should typically be the instance's `self.audio_chunks`.
            stop_event: A threading.Event to signal interruption of the synthesis.
                        This should typically be the instance's `self.stop_event`.
            generation_string: An optional identifier string for logging purposes.

        Returns:
            True if synthesis completed fully, False if interrupted by stop_event.
        """
        if self.engine_name == "coqui" and hasattr(self.engine, 'set_stream_chunk_size') and self.current_stream_chunk_size != FINAL_ANSWER_STREAM_CHUNK_SIZE:
            logger.info(f"👄⚙️ {generation_string} Setting Coqui stream chunk size to {FINAL_ANSWER_STREAM_CHUNK_SIZE} for generator synthesis.")
            self.engine.set_stream_chunk_size(FINAL_ANSWER_STREAM_CHUNK_SIZE)
            self.current_stream_chunk_size = FINAL_ANSWER_STREAM_CHUNK_SIZE

        # Feed the generator to the stream with emotion filtering
        def _emotion_filtered_generator():
            first = True
            for chunk in generator:
                if first:
                    chunk = self._apply_delivery(self.apply_emotion_tag(chunk))
                    asr_guard.note_spoken(chunk)
                    first = False
                elif chunk:
                    import re
                    chunk = re.sub(r'\*[^*]+\*', '', chunk)
                yield chunk

        self.stream.feed(_emotion_filtered_generator())
        self.finished_event.clear() # Reset finished event

        # Buffering state variables
        buffer: list[bytes] = []
        good_streak: int = 0
        buffering: bool = True
        buf_dur: float = 0.0
        SR, BPS = 24000, 2 # Assumed Sample Rate and Bytes Per Sample
        start = time.time()
        self._final_prev_chunk_time: float = 0.0 # Separate timer for generator synthesis

        def on_audio_chunk(chunk: bytes):
            nonlocal buffer, good_streak, buffering, buf_dur, start
            if stop_event.is_set():
                logger.info(f"👄🛑 {generation_string} Final audio stream interrupted by stop_event.")
                return

            now = time.time()
            samples = len(chunk) // BPS
            play_duration = samples / SR

            # --- Orpheus specific: Skip initial silence ---
            if on_audio_chunk.first_call and self.engine_name == "orpheus":
                if not hasattr(on_audio_chunk, "silent_chunks_count"):
                    on_audio_chunk.silent_chunks_count = 0
                    on_audio_chunk.silent_chunks_time = 0.0
                    # Lower threshold potentially for final answers? Or keep consistent? Using 100 as in original code.
                    on_audio_chunk.silence_threshold = 100

                try:
                    fmt = f"{samples}h"
                    pcm_data = struct.unpack(fmt, chunk)
                    avg_amplitude = np.abs(np.array(pcm_data)).mean()

                    if avg_amplitude < on_audio_chunk.silence_threshold:
                        on_audio_chunk.silent_chunks_count += 1
                        on_audio_chunk.silent_chunks_time += play_duration
                        logger.debug(f"👄⏭️ {generation_string} Final Skipping silent chunk {on_audio_chunk.silent_chunks_count} (avg_amp: {avg_amplitude:.2f})")
                        return # Skip
                    elif on_audio_chunk.silent_chunks_count > 0:
                        logger.info(f"👄⏭️ {generation_string} Final Skipped {on_audio_chunk.silent_chunks_count} silent chunks, saved {on_audio_chunk.silent_chunks_time*1000:.2f}ms")
                except Exception as e:
                    logger.warning(f"👄⚠️ {generation_string} Final Error analyzing audio chunk for silence: {e}")

            # --- Timing and Logging ---
            if on_audio_chunk.first_call:
                on_audio_chunk.first_call = False
                self._final_prev_chunk_time = now
                ttfa_actual = now-start
                logger.info(f"👄🚀 {generation_string} Final audio start. TTFA: {ttfa_actual:.2f}s.")
            else:
                gap = now - self._final_prev_chunk_time
                self._final_prev_chunk_time = now
                if gap <= play_duration * 1.1:
                    # logger.debug(f"👄✅ {generation_string} Final chunk ok (gap={gap:.3f}s ≤ {play_duration:.3f}s).")
                    good_streak += 1
                else:
                    logger.warning(f"👄❌ {generation_string} Final chunk slow (gap={gap:.3f}s > {play_duration:.3f}s).")
                    good_streak = 0

            put_occurred_this_call = False

            # --- Buffering Logic ---
            buffer.append(chunk)
            buf_dur += play_duration
            if buffering:
                if good_streak >= 2 or buf_dur >= 0.5: # Same flush logic as synthesize
                    logger.info(f"👄➡️ {generation_string} Final Flushing buffer (streak={good_streak}, dur={buf_dur:.2f}s).")
                    for c in buffer:
                        try:
                           audio_chunks.put_nowait(c)
                           put_occurred_this_call = True
                        except asyncio.QueueFull:
                            logger.warning(f"👄⚠️ {generation_string} Final audio queue full, dropping chunk.")
                    buffer.clear()
                    buf_dur = 0.0
                    buffering = False
            else: # Not buffering
                try:
                    audio_chunks.put_nowait(chunk)
                    put_occurred_this_call = True
                except asyncio.QueueFull:
                    logger.warning(f"👄⚠️ {generation_string} Final audio queue full, dropping chunk.")


            # --- First Chunk Callback --- (Using the same callback as synthesize)
            if put_occurred_this_call and not on_audio_chunk.callback_fired:
                if self.on_first_audio_chunk_synthesize:
                    try:
                        logger.info(f"👄🚀 {generation_string} Final Firing on_first_audio_chunk_synthesize.")
                        self.on_first_audio_chunk_synthesize()
                    except Exception as e:
                        logger.error(f"👄💥 {generation_string} Final Error in on_first_audio_chunk_synthesize callback: {e}", exc_info=True)
                on_audio_chunk.callback_fired = True

        # Initialize callback state
        on_audio_chunk.first_call = True
        on_audio_chunk.callback_fired = False

        play_kwargs = dict(
            log_synthesized_text=True, # Log text from generator
            on_audio_chunk=on_audio_chunk,
            muted=True,
            fast_sentence_fragment=False,
            comma_silence_duration=self.silence.comma,
            sentence_silence_duration=self.silence.sentence,
            default_silence_duration=self.silence.default,
            force_first_fragment_after_words=999999,
        )

        # Add Orpheus specific parameters for generator streaming
        if self.engine_name == "orpheus":
            # These encourage waiting for more text before synthesizing, potentially better for generators
            play_kwargs["minimum_sentence_length"] = 200
            play_kwargs["minimum_first_fragment_length"] = 200

        logger.info(f"👄▶️ {generation_string} Final Starting synthesis from generator.")
        self.stream.play_async(**play_kwargs)

        # Wait loop for completion or interruption
        while self.stream.is_playing() or not self.finished_event.is_set():
            if stop_event.is_set():
                self.stream.stop()
                logger.info(f"👄🛑 {generation_string} Final answer synthesis aborted by stop_event.")
                buffer.clear()
                self.finished_event.wait(timeout=1.0) # Wait for stream stop confirmation
                return False # Indicate interruption
            time.sleep(0.01)

        # Flush remaining buffer if stream finished before flush condition met
        if buffering and buffer and not stop_event.is_set():
            logger.info(f"👄➡️ {generation_string} Final Flushing remaining buffer after stream finished.")
            for c in buffer:
                try:
                   audio_chunks.put_nowait(c)
                except asyncio.QueueFull:
                   logger.warning(f"👄⚠️ {generation_string} Final audio queue full on final flush, dropping chunk.")
            buffer.clear()
            if self.on_first_audio_chunk_synthesize and not on_audio_chunk.callback_fired:
                try:
                    logger.info(f"👄🚀 {generation_string} Final Firing on_first_audio_chunk_synthesize on flush.")
                    self.on_first_audio_chunk_synthesize()
                except Exception as e:
                    logger.error(f"👄💥 Error in on_first_audio_chunk_synthesize on flush: {e}", exc_info=True)
                on_audio_chunk.callback_fired = True

        logger.info(f"👄✅ {generation_string} Final answer synthesis complete.")
        return True # Indicate successful completion