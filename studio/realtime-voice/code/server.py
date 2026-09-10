# server.py
from queue import Queue, Empty
import logging
from logsetup import setup_logging
setup_logging(logging.INFO)
logger = logging.getLogger(__name__)
if __name__ == "__main__":
    logger.info("🖥️👋 Welcome to local real-time voice chat")

from upsample_overlap import UpsampleOverlap
from datetime import datetime
from colors import Colors
import uvicorn
import asyncio
import struct
import json
import time
import threading # Keep threading for SpeechPipelineManager internals and AbortWorker
import sys
import os # Added for environment variable access
import asr_guard

from typing import Any, Dict, Optional, Callable # Added for type hints in docstrings
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import HTMLResponse, JSONResponse, Response, FileResponse

USE_SSL = False
TTS_START_ENGINE = "kokoro"
TTS_ORPHEUS_MODEL = "orpheus-3b-0.1-ft-Q8_0-GGUF/orpheus-3b-0.1-ft-q8_0.gguf"

LLM_START_PROVIDER = os.getenv("LLM_PROVIDER", "ollama")
LLM_START_MODEL = os.getenv("LLM_MODEL", "qwen3:8b")
NO_THINK = os.getenv("NO_THINK", "True").lower() in ("true", "1", "yes")
# See on_recording_start: without an echo canceller the mic hears the speakers and she
# interrupts herself. Off is only safe on headphones.
HALF_DUPLEX = os.getenv("VOICE_HALF_DUPLEX", "1").lower() in ("true", "1", "yes")
DIRECT_STREAM = TTS_START_ENGINE=="orpheus"
PORT = int(os.getenv("PORT", 8000))
# Loopback by default. This process carries an open microphone and an
# unauthenticated WebSocket; binding 0.0.0.0 offered both to the LAN.
# Teminali OS supervises it on 127.0.0.1 and never needs anything wider.
HOST = os.getenv("HOST", "127.0.0.1")

if __name__ == "__main__":
    logger.info(f"🖥️⚙️ {Colors.apply('[PARAM]').blue} Starting engine: {Colors.apply(TTS_START_ENGINE).blue}")
    logger.info(f"🖥️⚙️ {Colors.apply('[PARAM]').blue} Direct streaming: {Colors.apply('ON' if DIRECT_STREAM else 'OFF').blue}")

# Define the maximum allowed size for the incoming audio queue
try:
    MAX_AUDIO_QUEUE_SIZE = int(os.getenv("MAX_AUDIO_QUEUE_SIZE", 50))
    if __name__ == "__main__":
        logger.info(f"🖥️⚙️ {Colors.apply('[PARAM]').blue} Audio queue size limit set to: {Colors.apply(str(MAX_AUDIO_QUEUE_SIZE)).blue}")
except ValueError:
    if __name__ == "__main__":
        logger.warning("🖥️⚠️ Invalid MAX_AUDIO_QUEUE_SIZE env var. Using default: 50")
    MAX_AUDIO_QUEUE_SIZE = 50


if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

#from handlerequests import LanguageProcessor
#from audio_out import AudioOutProcessor
from audio_in import AudioInputProcessor
from speech_pipeline_manager import SpeechPipelineManager
import history_window
from colors import Colors

LANGUAGE = "en"
# TTS_FINAL_TIMEOUT = 0.5 # unsure if 1.0 is needed for stability
TTS_FINAL_TIMEOUT = 1.0 # unsure if 1.0 is needed for stability

# --------------------------------------------------------------------
# Custom no-cache StaticFiles
# --------------------------------------------------------------------
class NoCacheStaticFiles(StaticFiles):
    """
    Serves static files without allowing client-side caching.

    Overrides the default Starlette StaticFiles to add 'Cache-Control' headers
    that prevent browsers from caching static assets. Useful for development.
    """
    async def get_response(self, path: str, scope: Dict[str, Any]) -> Response:
        """
        Gets the response for a requested path, adding no-cache headers.

        Args:
            path: The path to the static file requested.
            scope: The ASGI scope dictionary for the request.

        Returns:
            A Starlette Response object with cache-control headers modified.
        """
        response: Response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        # These might not be strictly necessary with no-store, but belt and suspenders
        if "etag" in response.headers:
             response.headers.__delitem__("etag")
        if "last-modified" in response.headers:
             response.headers.__delitem__("last-modified")
        return response

# --------------------------------------------------------------------
# Ollama Keep-Alive Heartbeat
# --------------------------------------------------------------------
async def _ollama_keepalive_worker(model_name: str):
    """
    Background heartbeat that pings Ollama every 90 seconds with keep_alive: -1.
    Guarantees the model runner process never gets unloaded from Apple Silicon GPU memory during idle periods.
    """
    url = "http://127.0.0.1:11434/api/generate"
    payload = {"model": model_name, "keep_alive": -1}
    logger.info(f"🖥️🔥 Starting Ollama keep-alive heartbeat loop for '{model_name}'...")
    while True:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(url, json=payload)
                if res.status_code == 200:
                    logger.debug(f"🖥️🔥 Ollama keep-alive heartbeat acknowledged: '{model_name}' hot in GPU memory.")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.debug(f"🖥️⚠️ Ollama heartbeat ping non-fatal notice: {e}")
        await asyncio.sleep(90)

# --------------------------------------------------------------------
# Lifespan management
# --------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manages the application's lifespan, initializing and shutting down resources.

    Initializes global components like SpeechPipelineManager, Upsampler, and
    AudioInputProcessor and stores them in `app.state`. Handles cleanup on shutdown.

    Args:
        app: The FastAPI application instance.
    """
    logger.info("🖥️▶️ Server starting up")
    # Initialize global components, not connection-specific state
    app.state.SpeechPipelineManager = SpeechPipelineManager(
        tts_engine=TTS_START_ENGINE,
        llm_provider=LLM_START_PROVIDER,
        llm_model=LLM_START_MODEL,
        no_think=NO_THINK,
        orpheus_model=TTS_ORPHEUS_MODEL,
    )

    app.state.Upsampler = UpsampleOverlap()
    app.state.AudioInputProcessor = AudioInputProcessor(
        LANGUAGE,
        is_orpheus=TTS_START_ENGINE=="orpheus",
        pipeline_latency=app.state.SpeechPipelineManager.full_output_pipeline_latency / 1000, # seconds
    )
    app.state.Aborting = False
    app.state.active_connections = []

    # Initialize server-wide transcription callbacks
    callbacks = TranscriptionCallbacks(app)
    app.state.callbacks = callbacks

    # Bind global component callbacks once at startup
    app.state.AudioInputProcessor.callbacks = callbacks
    app.state.AudioInputProcessor.realtime_callback = callbacks.on_partial
    app.state.AudioInputProcessor.transcriber.potential_sentence_end = callbacks.on_potential_sentence
    app.state.AudioInputProcessor.transcriber.on_tts_allowed_to_synthesize = callbacks.on_tts_allowed_to_synthesize
    app.state.AudioInputProcessor.transcriber.potential_full_transcription_callback = callbacks.on_potential_final
    app.state.AudioInputProcessor.transcriber.potential_full_transcription_abort_callback = callbacks.on_potential_abort
    app.state.AudioInputProcessor.transcriber.full_transcription_callback = callbacks.on_final
    app.state.AudioInputProcessor.transcriber.before_final_sentence = callbacks.on_before_final
    app.state.AudioInputProcessor.recording_start_callback = callbacks.on_recording_start
    app.state.AudioInputProcessor.transcriber.on_recording_start_callback = callbacks.on_recording_start
    app.state.AudioInputProcessor.transcriber.silence_active_callback = callbacks.on_silence_active
    app.state.SpeechPipelineManager.on_partial_assistant_text = callbacks.on_partial_assistant_text

    app.state.tts_broadcaster = asyncio.create_task(send_tts_chunks(app))

    if LLM_START_PROVIDER == "ollama":
        app.state.ollama_heartbeat = asyncio.create_task(_ollama_keepalive_worker(LLM_START_MODEL))

    yield

    logger.info("🖥️⏹️ Server shutting down")
    if hasattr(app.state, "ollama_heartbeat") and not app.state.ollama_heartbeat.done():
        app.state.ollama_heartbeat.cancel()
    if hasattr(app.state, "tts_broadcaster") and not app.state.tts_broadcaster.done():
        app.state.tts_broadcaster.cancel()
    app.state.AudioInputProcessor.shutdown()

# --------------------------------------------------------------------
# FastAPI app instance
# --------------------------------------------------------------------
app = FastAPI(lifespan=lifespan)

# Enable CORS if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files with no cache
app.mount("/static", NoCacheStaticFiles(directory="static"), name="static")

@app.get("/favicon.ico")
async def favicon():
    """
    Serves the favicon.ico file.

    Returns:
        A FileResponse containing the favicon.
    """
    return FileResponse("static/favicon.ico")

@app.get("/health")
async def health(request: Request):
    """
    Cheap readiness probe for the Teminali OS supervisor.

    Deliberately touches no model and holds no lock: the supervisor polls this
    every second while the pipeline is still loading weights, and a probe that
    contended with loading would be the thing that made loading slow. Presence
    of the lifespan-built objects on `app.state` is the whole test — until the
    lifespan has run there is nothing to talk to, and once it has, the socket
    is answerable.

    Returns:
        JSON with readiness, the configured engines and the live connection
        count, which is what the studio's status route surfaces to the user.
    """
    state = request.app.state
    pipeline = getattr(state, "SpeechPipelineManager", None)
    ready = pipeline is not None and getattr(state, "AudioInputProcessor", None) is not None
    return JSONResponse({
        "ok": ready,
        "service": "teminali-realtime-voice",
        "ready": ready,
        "tts_engine": TTS_START_ENGINE,
        "llm_provider": LLM_START_PROVIDER,
        "llm_model": LLM_START_MODEL,
        "half_duplex": HALF_DUPLEX,
        "connections": len(getattr(state, "active_connections", []) or []),
    })

@app.get("/")
async def get_index() -> HTMLResponse:
    """
    Serves the main index.html page.

    Reads the content of static/index.html and returns it as an HTML response.

    Returns:
        An HTMLResponse containing the content of index.html.
    """
    with open("static/index.html", "r", encoding="utf-8") as f:
        html_content = f.read()
    return HTMLResponse(content=html_content)

@app.get("/api/voices")
def get_voices():
    audio_mgr = getattr(app.state.SpeechPipelineManager, "audio", None)
    current = getattr(audio_mgr, "current_profile_key", "royal_velvet") if audio_mgr else "royal_velvet"
    profiles = getattr(audio_mgr, "VOICE_PROFILES", {}) if audio_mgr else {}
    return {
        "current": current,
        "voices": profiles
    }

@app.post("/api/voice")
async def set_voice_endpoint(payload: dict):
    voice_key = payload.get("voice", "royal_velvet")
    success = app.state.SpeechPipelineManager.set_voice_profile(voice_key)
    return {"status": "ok" if success else "error", "voice": voice_key}

# --------------------------------------------------------------------
# Utility functions
# --------------------------------------------------------------------
def parse_json_message(text: str) -> dict:
    """
    Safely parses a JSON string into a dictionary.

    Logs a warning if the JSON is invalid and returns an empty dictionary.

    Args:
        text: The JSON string to parse.

    Returns:
        A dictionary representing the parsed JSON, or an empty dictionary on error.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logger.warning("🖥️⚠️ Ignoring client message with invalid JSON")
        return {}

def format_timestamp_ns(timestamp_ns: int) -> str:
    """
    Formats a nanosecond timestamp into a human-readable HH:MM:SS.fff string.

    Args:
        timestamp_ns: The timestamp in nanoseconds since the epoch.

    Returns:
        A string formatted as hours:minutes:seconds.milliseconds.
    """
    # Split into whole seconds and the nanosecond remainder
    seconds = timestamp_ns // 1_000_000_000
    remainder_ns = timestamp_ns % 1_000_000_000

    # Convert seconds part into a datetime object (local time)
    dt = datetime.fromtimestamp(seconds)

    # Format the main time as HH:MM:SS
    time_str = dt.strftime("%H:%M:%S")

    # For instance, if you want milliseconds, divide the remainder by 1e6 and format as 3-digit
    milliseconds = remainder_ns // 1_000_000
    formatted_timestamp = f"{time_str}.{milliseconds:03d}"

    return formatted_timestamp

# --------------------------------------------------------------------
# WebSocket data processing
# --------------------------------------------------------------------

async def process_incoming_data(ws: WebSocket, app: FastAPI, incoming_chunks: asyncio.Queue, callbacks: 'TranscriptionCallbacks') -> None:
    """
    Receives messages via WebSocket, processes audio and text messages.

    Handles binary audio chunks, extracting metadata (timestamp, flags) and
    putting the audio PCM data with metadata into the `incoming_chunks` queue.
    Applies back-pressure if the queue is full.
    Parses text messages (assumed JSON) and triggers actions based on message type
    (e.g., updates client TTS state via `callbacks`, clears history, sets speed).

    Args:
        ws: The WebSocket connection instance.
        app: The FastAPI application instance (for accessing global state if needed).
        incoming_chunks: An asyncio queue to put processed audio metadata dictionaries into.
        callbacks: The TranscriptionCallbacks instance for this connection to manage state.
    """
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                logger.info("🖥️ℹ️ WebSocket disconnect received from client.")
                break
            if "bytes" in msg and msg["bytes"]:
                raw = msg["bytes"]

                # Ensure we have at least an 8‑byte header: 4 bytes timestamp_ms + 4 bytes flags
                if len(raw) < 8:
                    logger.warning("🖥️⚠️ Received packet too short for 8‑byte header.")
                    continue

                # Unpack big‑endian uint32 timestamp (ms) and uint32 flags
                timestamp_ms, flags = struct.unpack("!II", raw[:8])
                client_sent_ns = timestamp_ms * 1_000_000
                is_client_playing = bool(flags & 1)
                callbacks.tts_client_playing = is_client_playing

                # Build metadata using fixed fields
                metadata = {
                    "client_sent_ms":           timestamp_ms,
                    "client_sent":              client_sent_ns,
                    "client_sent_formatted":    format_timestamp_ns(client_sent_ns),
                    "isTTSPlaying":             is_client_playing,
                }

                # Record server receive time
                server_ns = time.time_ns()
                metadata["server_received"] = server_ns
                metadata["server_received_formatted"] = format_timestamp_ns(server_ns)

                # The rest of the payload is raw PCM bytes
                metadata["pcm"] = raw[8:]

                # Check queue size before putting data
                current_qsize = incoming_chunks.qsize()
                if current_qsize < MAX_AUDIO_QUEUE_SIZE:
                    # Now put only the metadata dict (containing PCM audio) into the processing queue.
                    await incoming_chunks.put(metadata)
                else:
                    # Queue is full, drop the chunk and log a warning
                    logger.warning(
                        f"🖥️⚠️ Audio queue full ({current_qsize}/{MAX_AUDIO_QUEUE_SIZE}); dropping chunk. Possible lag."
                    )

            elif "text" in msg and msg["text"]:
                # Text-based message: parse JSON
                data = parse_json_message(msg["text"])
                msg_type = data.get("type")
                logger.info(Colors.apply(f"🖥️📥 ←←Client: {data}").orange)

                if msg_type == "tts_start":
                    logger.info("🖥️ℹ️ Received tts_start from client.")
                    callbacks.tts_client_playing = True
                elif msg_type == "tts_stop":
                    logger.info("🖥️ℹ️ Received tts_stop from client (audio playback completed).")
                    callbacks.tts_client_playing = False
                elif msg_type == "user_barge_in":
                    logger.info("🖥️⚡ Received user_barge_in from client.")
                    callbacks.trigger_user_interruption(reason="client user_barge_in")
                elif msg_type == "user_text":
                    text_content = data.get("text", "").strip()
                    # Defensive guard: Drop stale prompt injections from unrefreshed browser tabs
                    if "[The user asked:" in text_content or "[The background coding assistant has finished" in text_content:
                        logger.warning(f"🖥️🛡️ Dropping stale browser tab prompt injection: '{text_content[:60]}...'")
                        continue
                    if text_content:
                        logger.info(f"🖥️📝 Received typed user message: '{text_content}'")
                        callbacks.reset_turn_state()
                        callbacks.on_final(text_content)
                elif msg_type == "assistant_directive":
                    # A line the Teminali OS shell wants said now, in her voice: an
                    # answer built from the live agent run, or that run's final report.
                    #
                    # It is not a user turn. The pipeline has only one way in, so it
                    # enters as one, bracketed. It cannot ride on "user_text": the
                    # guard above drops bracketed prose there, because an unrefreshed
                    # tab on this server's own preview page replays it. A build old
                    # enough to be that stale tab does not know this message type,
                    # so the guard keeps doing its job and this channel is immune
                    # to it by construction.
                    #
                    # She is told not to add facts. The line was built from what the
                    # agent actually did, and a voice answer that invents a filename
                    # is worse than one that admits the step is not visible — the
                    # operator asked out loud because they cannot see the screen.
                    directive = data.get("text", "").strip()
                    if directive:
                        logger.info(f"\U0001f5a5\ufe0f\U0001f9ed Assistant directive: '{directive[:80]}'")
                        callbacks.reset_turn_state()
                        callbacks.on_final(
                            "[Say this to the user now, in your own voice, warmly and in one or "
                            "two spoken sentences. Do not add any facts that are not in it: "
                            f"\"{directive}\"]"
                        )
                elif msg_type == "clear_history":
                    logger.info("🖥️ℹ️ Received clear_history from client. Resetting callbacks, turn detection, and pipeline.")
                    callbacks.reset_state()
                    app.state.SpeechPipelineManager.reset()
                    turn_detection = getattr(app.state.AudioInputProcessor.transcriber, 'turn_detection', None)
                    if turn_detection:
                        turn_detection.reset()
                    logger.info("🖥️✨ All state, turns, and history reset for fresh conversation.")
                elif msg_type == "set_history":
                    incoming_history = data.get("history", [])
                    logger.info(f"🖥️ℹ️ Received set_history from client with {len(incoming_history)} items.")
                    callbacks.reset_state()
                    app.state.SpeechPipelineManager.set_history(incoming_history)
                    turn_detection = getattr(app.state.AudioInputProcessor.transcriber, 'turn_detection', None)
                    if turn_detection:
                        turn_detection.reset()
                    logger.info(f"🖥️✨ Active chat session history set to {len(app.state.SpeechPipelineManager.history)} turns.")
                elif msg_type == "set_speed":
                    speed_value = data.get("speed", 0)
                    speed_factor = speed_value / 100.0  # Convert 0-100 to 0.0-1.0
                    turn_detection = app.state.AudioInputProcessor.transcriber.turn_detection
                    if turn_detection:
                        turn_detection.update_settings(speed_factor)
                        logger.info(f"🖥️⚙️ Updated turn detection settings to factor: {speed_factor:.2f}")
                elif msg_type == "set_voice":
                    voice_key = data.get("voice", "royal_velvet")
                    success = app.state.SpeechPipelineManager.set_voice_profile(voice_key)
                    logger.info(f"🖥️🎛️ Voice switched via WS to '{voice_key}': success={success}")
                    try:
                        await ws.send_text(json.dumps({
                            "type": "voice_changed",
                            "voice": voice_key,
                            "success": success
                        }))
                    except Exception as send_err:
                        logger.warning(f"Error sending voice_changed: {send_err}")


    except asyncio.CancelledError:
        pass # Task cancellation is expected on disconnect
    except WebSocketDisconnect as e:
        logger.warning(f"🖥️⚠️ {Colors.apply('WARNING').red} disconnect in process_incoming_data: {repr(e)}")
    except RuntimeError as e:  # Often raised on closed transports
        logger.error(f"🖥️💥 {Colors.apply('RUNTIME_ERROR').red} in process_incoming_data: {repr(e)}")
    except Exception as e:
        logger.exception(f"🖥️💥 {Colors.apply('EXCEPTION').red} in process_incoming_data: {repr(e)}")

async def send_text_messages(ws: WebSocket, message_queue: asyncio.Queue) -> None:
    """
    Continuously sends text messages from a queue to the client via WebSocket.

    Waits for messages on the `message_queue`, formats them as JSON, and sends
    them to the connected WebSocket client. Logs non-TTS messages.

    Args:
        ws: The WebSocket connection instance.
        message_queue: An asyncio queue yielding dictionaries to be sent as JSON.
    """
    try:
        while True:
            await asyncio.sleep(0.001) # Yield control
            data = await message_queue.get()
            msg_type = data.get("type")
            if msg_type != "tts_chunk":
                logger.info(Colors.apply(f"🖥️📤 →→Client: {data}").orange)
            await ws.send_json(data)
    except asyncio.CancelledError:
        pass # Task cancellation is expected on disconnect
    except WebSocketDisconnect as e:
        logger.warning(f"🖥️⚠️ {Colors.apply('WARNING').red} disconnect in send_text_messages: {repr(e)}")
    except RuntimeError as e:  # Often raised on closed transports
        logger.error(f"🖥️💥 {Colors.apply('RUNTIME_ERROR').red} in send_text_messages: {repr(e)}")
    except Exception as e:
        logger.exception(f"🖥️💥 {Colors.apply('EXCEPTION').red} in send_text_messages: {repr(e)}")

async def send_tts_chunks(app: FastAPI, message_queue: Optional[asyncio.Queue] = None, callbacks: Optional['TranscriptionCallbacks'] = None) -> None:
    """
    Continuously broadcasts TTS audio chunks from SpeechPipelineManager to all active connections.
    """
    try:
        logger.info("🖥️🔊 Starting global TTS chunk broadcaster")
        last_quick_answer_chunk = 0
        last_chunk_sent = 0

        while True:
            await asyncio.sleep(0.001) # Yield control

            cb = getattr(app.state, "callbacks", None)
            if not cb:
                await asyncio.sleep(0.01)
                continue

            # Check if callbacks allows TTS streaming and user request has been sent
            if not cb.tts_to_client or not cb.user_finished_turn or not cb.user_request_sent_for_turn:
                await asyncio.sleep(0.002)
                continue

            running_gen = app.state.SpeechPipelineManager.running_generation
            if not running_gen:
                await asyncio.sleep(0.002)
                continue

            if running_gen.abortion_started:
                await asyncio.sleep(0.002)
                continue

            if not running_gen.audio_quick_finished:
                running_gen.tts_quick_allowed_event.set()

            if not running_gen.quick_answer_first_chunk_ready and running_gen.audio_chunks.empty():
                if running_gen.llm_finished and running_gen.audio_quick_finished and running_gen.audio_final_finished:
                    logger.info("🖥️🏁 Both quick and final TTS finished with empty chunks.")
                    cb.send_final_assistant_answer()
                    cb.tts_chunk_sent = False
                    cb.reset_turn_state()
                    app.state.SpeechPipelineManager.running_generation = None
                await asyncio.sleep(0.002)
                continue

            chunk = None
            try:
                chunk = running_gen.audio_chunks.get_nowait()
                if chunk:
                    last_quick_answer_chunk = time.time()
            except Empty:
                quick_done = running_gen.audio_quick_finished
                final_done = running_gen.audio_final_finished or (getattr(running_gen, 'llm_stream_exhausted', False) and not running_gen.quick_answer_overhang)

                if quick_done and final_done:
                    logger.info("🖥️🏁 Sending of TTS chunks and 'user request/assistant answer' cycle finished.")
                    cb.send_final_assistant_answer()
                    cb.tts_chunk_sent = False
                    cb.reset_turn_state()
                    app.state.SpeechPipelineManager.running_generation = None

                await asyncio.sleep(0.002)
                continue

            base64_chunk = app.state.Upsampler.get_base64_chunk(chunk)
            gen_id = running_gen.id if running_gen else 0
            msg = {
                "type": "tts_chunk",
                "gen_id": gen_id,
                "content": base64_chunk
            }
            last_chunk_sent = time.time()
            cb.tts_chunk_sent = True
            cb.broadcast(msg)

    except asyncio.CancelledError:
        pass # Task cancellation is expected on shutdown
    except Exception as e:
        logger.exception(f"🖥️💥 {Colors.apply('EXCEPTION').red} in send_tts_chunks: {repr(e)}")


# --------------------------------------------------------------------
# Callback class to handle transcription events
# --------------------------------------------------------------------

def _bound_history(history: list) -> None:
    """Keeps `SpeechPipelineManager.history` from growing without end.

    **This is a memory bound, not the model's window.** It was a hard trim to
    twenty messages, applied here after every turn — ten exchanges, which is
    precisely the design `history_window.py` was written to replace. That module was rewritten to spend a *context* budget (5914 tokens
    against an 8192 window and a 6293-character system prompt, measured), and it
    holds a fact for about thirty-six turns. None of it could ever run: this
    line had already thrown the older turns away before `window()` was asked,
    so the budget was spent on a list that could never exceed twenty. A fact
    stated twenty-four turns ago was not trimmed by the window — it did not
    exist.

    The bound is now the window's own ceiling, so there is one number and the
    budget decides what the model actually sees.
    """
    while len(history) > history_window.MAX_MESSAGES:
        history.pop(0)


class TranscriptionCallbacks:
    """
    Manages state and callbacks for a single WebSocket connection's transcription lifecycle.

    This class holds connection-specific state flags (like TTS status, user interruption)
    and implements callback methods triggered by the `AudioInputProcessor` and
    `SpeechPipelineManager`. It sends messages back to the client via the provided
    `message_queue` and manages interaction logic like interruptions and final answer delivery.
    It also includes a threaded worker to handle abort checks based on partial transcription.
    """
    def __init__(self, app: FastAPI):
        """
        Initializes the TranscriptionCallbacks instance for the voice server.

        Args:
            app: The FastAPI application instance (to access global components).
        """
        self.app = app
        self.final_transcription = ""
        self.abort_text = ""
        self.last_abort_text = ""

        # Initialize session state flags
        self.tts_to_client: bool = False
        self.user_interrupted: bool = False
        self.tts_chunk_sent: bool = False
        self.tts_client_playing: bool = False
        self.interruption_time: float = 0.0

        self.silence_active: bool = True
        self.is_hot: bool = False
        self.user_finished_turn: bool = False
        self.synthesis_started: bool = False
        self.assistant_answer: str = ""
        self.final_assistant_answer: str = ""
        self.is_processing_potential: bool = False
        self.is_processing_final: bool = False
        self.last_inferred_transcription: str = ""
        self.final_assistant_answer_sent: bool = False
        self.partial_transcription: str = ""
        self.user_request_sent_for_turn: bool = False

        self.reset_turn_state()

        self.abort_request_event = threading.Event()
        self.abort_worker_thread = threading.Thread(target=self._abort_worker, name="AbortWorker", daemon=True)
        self.abort_worker_thread.start()

    def reset_turn_state(self):
        """Resets turn-specific state flags and variables without aborting active pipelines."""
        self.tts_to_client = False
        self.user_interrupted = False
        self.tts_chunk_sent = False
        self.interruption_time = 0.0

        self.silence_active = True
        self.is_hot = False
        self.user_finished_turn = False
        self.user_request_sent_for_turn = False
        self.synthesis_started = False
        self.assistant_answer = ""
        self.final_assistant_answer = ""
        self.is_processing_potential = False
        self.is_processing_final = False
        self.last_inferred_transcription = ""
        self.final_assistant_answer_sent = False
        self.partial_transcription = ""

        # Re-enable microphone only once assistant turn has completely finished
        if hasattr(self.app.state, "AudioInputProcessor"):
            self.app.state.AudioInputProcessor.interrupted = False
            if hasattr(self.app.state.AudioInputProcessor, "transcriber"):
                self.app.state.AudioInputProcessor.transcriber.clear_audio()

    def reset_state(self):
        """Resets state flags and triggers audio abort (e.g. on clear_history)."""
        self.reset_turn_state()
        self.app.state.AudioInputProcessor.abort_generation()

    def broadcast(self, msg: dict):
        """Broadcasts a message to all active client connection queues."""
        active = getattr(self.app.state, "active_connections", [])
        for mq in list(active):
            try:
                mq.put_nowait(msg)
            except Exception:
                pass

    def _abort_worker(self):
        """Background thread worker for connection state maintenance."""
        while True:
            was_set = self.abort_request_event.wait(timeout=0.1) # Check every 100ms
            if was_set:
                self.abort_request_event.clear()

    def trigger_user_interruption(self, reason: str = "user interruption"):
        """
        Immediately and cleanly stops active TTS playback, LLM generation,
        and audio synthesizer pipeline on verified user interruption.
        """
        is_playing_audio = self.tts_client_playing or self.tts_chunk_sent
        current_gen = self.app.state.SpeechPipelineManager.running_generation
        is_busy = is_playing_audio or (current_gen is not None)

        if not is_busy:
            return

        logger.info(Colors.apply(f"🖥️⚡ TRIGGER USER INTERRUPTION: {reason}").magenta)
        self.tts_to_client = False
        self.user_interrupted = True
        self.tts_client_playing = False
        self.user_finished_turn = False
        self.tts_chunk_sent = False

        gen_id = current_gen.id if current_gen else 0

        # Send final assistant answer (forced on interruption)
        self.send_final_assistant_answer(forced=True)

        # Purge pending tts_chunk messages from all active client queues
        active = getattr(self.app.state, "active_connections", [])
        for mq in list(active):
            temp_queue = []
            while not mq.empty():
                try:
                    msg = mq.get_nowait()
                    if msg.get("type") != "tts_chunk":
                        temp_queue.append(msg)
                except Exception:
                    break
            for msg in temp_queue:
                try:
                    mq.put_nowait(msg)
                except Exception:
                    pass

        # Reset overlap-add upsampler buffer
        if hasattr(self.app.state, "Upsampler") and self.app.state.Upsampler:
            self.app.state.Upsampler.reset()

        logger.info(f"🖥️🛑 Sending stop_tts to client (gen_id={gen_id}).")
        self.broadcast({
            "type": "stop_tts",
            "gen_id": gen_id,
            "content": ""
        })

        logger.info(f"🖥️❗ Sending tts_interruption to client (gen_id={gen_id}).")
        self.broadcast({
            "type": "tts_interruption",
            "gen_id": gen_id,
            "content": ""
        })

        self.abort_generations(reason)

        # Re-enable microphone so user speech is captured seamlessly
        if hasattr(self.app.state, "AudioInputProcessor"):
            self.app.state.AudioInputProcessor.interrupted = False
            if hasattr(self.app.state.AudioInputProcessor, "transcriber"):
                self.app.state.AudioInputProcessor.transcriber.clear_audio()

    def on_partial(self, txt: str):
        """
        Callback invoked when a partial transcription result is available.

        Updates internal state, sends the partial result to the client,
        and signals the abort worker thread to check for potential interruptions.

        Args:
            txt: The partial transcription text.
        """
        txt_clean = txt.strip()
        if not txt_clean:
            return

        is_busy = (
            self.tts_client_playing
            or self.tts_chunk_sent
            or (self.app.state.SpeechPipelineManager.running_generation is not None)
        )
        if is_busy:
            # Check if this partial is acoustic echo from speakers
            is_echo, echo_reason = asr_guard.is_echo(txt_clean)
            if is_echo:
                logger.debug(f"🖥️🔇 Discarding partial echo during playback: '{txt_clean}' ({echo_reason})")
                return

            # Check if this is a silence artifact hallucination
            if asr_guard.is_silence_artifact(txt_clean):
                logger.debug(f"🖥️🔇 Discarding silence artifact partial: '{txt_clean}'")
                return

            # Verified user speech! Trigger barge-in immediately
            logger.info(f"🖥️⚡ User speech barge-in verified by Whisper partial: '{txt_clean}'")
            self.trigger_user_interruption(reason=f"speech partial: '{txt_clean}'")

        self.final_assistant_answer_sent = False # New user speech invalidates previous final answer sending state
        self.final_transcription = "" # Clear final transcription as this is partial
        self.partial_transcription = txt
        self.broadcast({"type": "partial_user_request", "content": txt})
        self.abort_text = txt # Update text used for abort check
        self.abort_request_event.set() # Signal the abort worker

    def safe_abort_running_syntheses(self, reason: str):
        """Placeholder for safely aborting syntheses (currently does nothing)."""
        pass

    def on_tts_allowed_to_synthesize(self):
        """Callback invoked when the system determines TTS synthesis can proceed."""
        # Access global manager state
        if self.app.state.SpeechPipelineManager.running_generation and not self.app.state.SpeechPipelineManager.running_generation.abortion_started:
            logger.info(f"{Colors.apply('🖥️🔊 TTS ALLOWED').blue}")
            self.tts_to_client = True
            self.app.state.SpeechPipelineManager.running_generation.tts_quick_allowed_event.set()
            # Keep mic paused during synthesis and playback to eliminate speaker acoustic bleed

    def on_potential_sentence(self, txt: str):
        """
        Callback invoked when a potential sentence is detected by the STT during speech.
        We intentionally do not trigger speculative LLM generation on mid-speech fragments,
        preventing GPU starvation, abort lag, and premature replies.
        """
        logger.debug(f"🖥️🧠 Potential sentence: '{txt}'")

    def on_potential_final(self, txt: str):
        """Callback invoked when a potential *final* transcription is detected (hot state)."""
        logger.info(f"{Colors.apply('🖥️🧠 HOT: ').magenta}{txt}")

    def on_potential_abort(self):
        """Callback invoked if the STT detects a potential need to abort based on user speech."""
        pass

    def on_before_final(self, audio: bytes, txt: str):
        """
        Callback invoked immediately when user speech stops and turn silence is confirmed.
        Blocks further incoming audio while Whisper finishes transcribing the turn.
        """
        logger.info(Colors.apply('🖥️🏁 =================== USER TURN END ===================').light_gray)
        self.user_finished_turn = True
        self.user_interrupted = False

        # Block further incoming audio while final transcription completes
        if not self.app.state.AudioInputProcessor.interrupted:
            logger.info(f"{Colors.apply('🖥️🎙️ ⏸️ Microphone interrupted (end of turn)').cyan}")
            self.app.state.AudioInputProcessor.interrupted = True
            self.interruption_time = time.time()

    def on_final(self, txt: str):
        """
        Callback invoked when the final transcription result for a user turn is confirmed by Whisper.
        """
        txt = txt.strip()
        if not txt:
            return

        is_busy = (
            self.tts_client_playing
            or self.tts_chunk_sent
            or (self.app.state.SpeechPipelineManager.running_generation is not None)
        )
        if is_busy:
            is_echo, echo_reason = asr_guard.is_echo(txt)
            if is_echo:
                logger.warning(f"🖥️🔇 Discarding final echo during TTS playback: '{txt}' ({echo_reason})")
                return
            if asr_guard.is_silence_artifact(txt):
                logger.warning(f"🖥️🔇 Discarding silence artifact final during TTS playback: '{txt}'")
                return

            logger.info(f"🖥️⚡ User speech final verified during playback: '{txt}' - interrupting assistant turn")
            self.trigger_user_interruption(reason=f"speech final: '{txt}'")

        logger.info(f"\n{Colors.apply('🖥️✅ FINAL USER REQUEST (STT Callback): ').green}{txt}")
        self.user_finished_turn = True
        self.user_interrupted = False
        self.tts_client_playing = False
        self.tts_to_client = True
        self.tts_chunk_sent = False

        # Keep mic paused and clear STT buffer so room noise during synthesis doesn't produce ghost turns
        if hasattr(self.app.state, "AudioInputProcessor"):
            self.app.state.AudioInputProcessor.interrupted = True
            if hasattr(self.app.state.AudioInputProcessor, "transcriber"):
                self.app.state.AudioInputProcessor.transcriber.clear_audio()

        self.final_transcription = txt
        self.user_request_sent_for_turn = True
        self.broadcast({
            "type": "final_user_request",
            "content": txt
        })
        self.app.state.SpeechPipelineManager.prepare_generation(txt)

        # Update conversation history with the full, accurate final transcription
        history = self.app.state.SpeechPipelineManager.history
        if history and history[-1]["role"] == "user":
            history[-1]["content"] = txt
        else:
            history.append({"role": "user", "content": txt})
        _bound_history(history)

    def abort_generations(self, reason: str):
        """
        Triggers the abortion of any ongoing speech generation process.

        Logs the reason and calls the SpeechPipelineManager's abort method.

        Args:
            reason: A string describing why the abortion is triggered.
        """
        logger.info(f"{Colors.apply('🖥️🛑 Aborting generation:').blue} {reason}")
        # Access global manager state
        self.app.state.SpeechPipelineManager.abort_generation(reason=f"server.py abort_generations: {reason}")

    def on_silence_active(self, silence_active: bool):
        """
        Callback invoked when the silence detection state changes.

        Updates the internal silence_active flag.

        Args:
            silence_active: True if silence is currently detected, False otherwise.
        """
        self.silence_active = silence_active

    def on_partial_assistant_text(self, txt: str):
        """
        Callback invoked when a partial text result from the assistant (LLM) is available.
        Only broadcast to client IF user turn has completed, user request was sent,
        and the generation is active and unaborted.
        """
        logger.info(f"{Colors.apply('🖥️💬 PARTIAL ASSISTANT ANSWER: ').green}{txt}")
        if self.user_interrupted:
            return

        current_gen = self.app.state.SpeechPipelineManager.running_generation
        if not current_gen or current_gen.abortion_started or current_gen.llm_aborted:
            logger.warning("🖥️⚠️ Dropping partial assistant text for missing or aborted generation.")
            return

        if not self.user_finished_turn or not self.user_request_sent_for_turn:
            logger.warning("🖥️⚠️ Dropping partial assistant text: user turn not completed or user request not sent.")
            return

        self.assistant_answer = txt
        self.tts_to_client = True
        self.broadcast({
            "type": "partial_assistant_answer",
            "gen_id": current_gen.id,
            "content": txt
        })

    def on_recording_start(self):
        """
        Callback invoked when the audio input processor starts recording user speech (VAD trigger).
        """
        self.user_finished_turn = False
        self.user_request_sent_for_turn = False
        is_playing_audio = (
            self.tts_client_playing
            or self.tts_chunk_sent
        )
        is_busy = (
            is_playing_audio
            or (self.app.state.SpeechPipelineManager.running_generation is not None)
        )
        logger.info(f"{Colors.ORANGE}🖥️🎙️ Recording started.{Colors.RESET} TTS Playing: {self.tts_client_playing}, Busy: {is_busy}")
        # Note: We deliberately do NOT abort generation here on raw VAD energy.
        # Interruption is handled cleanly by client barge-in, validated partials, or UI buttons.

    def send_final_assistant_answer(self, forced=False):
        """
        Sends the final (or best available) assistant answer to the client.

        Constructs the full answer from quick and final parts if available.
        If `forced` and no full answer exists, uses the last partial answer.
        Cleans the text and sends it as 'final_assistant_answer' if not already sent.

        Args:
            forced: If True, attempts to send the last partial answer if no complete
                    final answer is available. Defaults to False.
        """
        final_answer = ""
        current_gen = self.app.state.SpeechPipelineManager.running_generation
        gen_id = current_gen.id if current_gen else 0

        # Access global manager state
        if self.app.state.SpeechPipelineManager.is_valid_gen():
            final_answer = self.app.state.SpeechPipelineManager.running_generation.quick_answer + self.app.state.SpeechPipelineManager.running_generation.final_answer

        if not final_answer: # Check if constructed answer is empty
            # If forced, try using the last known partial answer from this connection
            if forced and self.assistant_answer:
                 final_answer = self.assistant_answer
                 logger.warning(f"🖥️⚠️ Using partial answer as final (forced): '{final_answer}'")
            else:
                logger.warning(f"🖥️⚠️ Final assistant answer was empty, not sending.")
                return # Nothing to send

        logger.debug(f"🖥️✅ Attempting to send final answer: '{final_answer}' (Sent previously: {self.final_assistant_answer_sent})")

        if not self.final_assistant_answer_sent and final_answer:
            import re
            # Clean up the final answer text
            cleaned_answer = re.sub(r'[\r\n]+', ' ', final_answer)
            cleaned_answer = re.sub(r'\s+', ' ', cleaned_answer).strip()
            cleaned_answer = cleaned_answer.replace('\\n', ' ')
            # Sanitize forbidden clichés from final answer
            cleaned_answer = re.sub(r',\s*my love\b', '', cleaned_answer, flags=re.IGNORECASE)
            cleaned_answer = re.sub(r'\bmy love\b', '', cleaned_answer, flags=re.IGNORECASE)
            cleaned_answer = re.sub(r'\b(honey|darling|sweetheart|babe)\b', '', cleaned_answer, flags=re.IGNORECASE)
            cleaned_answer = re.sub(r',\s*,', ',', cleaned_answer)
            cleaned_answer = re.sub(r'\s{2,}', ' ', cleaned_answer).strip()

            if forced and cleaned_answer and not cleaned_answer.endswith("..."):
                cleaned_answer = cleaned_answer + "..."

            if cleaned_answer: # Ensure it's not empty after cleaning
                logger.info(f"\n{Colors.apply('🖥️✅ FINAL ASSISTANT ANSWER (Sending): ').green}{cleaned_answer}")
                self.broadcast({
                    "type": "final_assistant_answer",
                    "gen_id": gen_id,
                    "content": cleaned_answer
                })
                # Always commit what Temi said to history so future turns have context of previous assistant speech
                history = self.app.state.SpeechPipelineManager.history
                if history and history[-1]["role"] == "assistant":
                    history[-1]["content"] = cleaned_answer
                else:
                    history.append({"role": "assistant", "content": cleaned_answer})
                _bound_history(history)

                if not forced:
                    # She said it, in full. Only now do those sentences become
                    # something the anti-repetition filter will refuse twice.
                    self.app.state.SpeechPipelineManager.repetition.commit()
                else:
                    # Interrupted: abandoned from repetition filter
                    self.app.state.SpeechPipelineManager.repetition.abandon()
                self.final_assistant_answer_sent = True
                self.final_assistant_answer = cleaned_answer # Store the sent answer
            else:
                logger.warning(f"🖥️⚠️ {Colors.YELLOW}Final assistant answer was empty after cleaning.{Colors.RESET}")
                self.final_assistant_answer_sent = False # Don't mark as sent
                self.final_assistant_answer = "" # Clear the stored answer
        elif forced and not final_answer: # Should not happen due to earlier check, but safety
             logger.warning(f"🖥️⚠️ {Colors.YELLOW}Forced send of final assistant answer, but it was empty.{Colors.RESET}")
             self.final_assistant_answer = "" # Clear the stored answer


# --------------------------------------------------------------------
# Main WebSocket endpoint
# --------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    Handles the main WebSocket connection for real-time voice chat.

    Accepts a connection, sets up connection-specific state via `TranscriptionCallbacks`,
    initializes audio/message queues, and creates asyncio tasks for handling
    incoming data, audio processing, outgoing text messages, and outgoing TTS chunks.
    Manages the lifecycle of these tasks and cleans up on disconnect.

    Args:
        ws: The WebSocket connection instance provided by FastAPI.
    """
    await ws.accept()
    logger.info("🖥️✅ Client connected via WebSocket.")

    message_queue = asyncio.Queue()
    audio_chunks = asyncio.Queue()

    if not hasattr(app.state, "active_connections"):
        app.state.active_connections = []
    app.state.active_connections.append(message_queue)

    callbacks = getattr(app.state, "callbacks", None)

    # Create tasks for handling incoming client data, audio processing, and outgoing messages
    tasks = [
        asyncio.create_task(process_incoming_data(ws, app, audio_chunks, callbacks)),
        asyncio.create_task(app.state.AudioInputProcessor.process_chunk_queue(audio_chunks)),
        asyncio.create_task(send_text_messages(ws, message_queue)),
    ]

    try:
        # Wait for any task to complete (e.g., client disconnect)
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            if not task.done():
                task.cancel()
        # Await cancelled tasks to let them clean up if needed
        await asyncio.gather(*pending, return_exceptions=True)
    except Exception as e:
        logger.error(f"🖥️💥 {Colors.apply('ERROR').red} in WebSocket session: {repr(e)}")
    finally:
        if hasattr(app.state, "active_connections") and message_queue in app.state.active_connections:
            app.state.active_connections.remove(message_queue)
        logger.info("🖥️🧹 Cleaning up WebSocket tasks...")
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("🖥️❌ WebSocket session ended.")

# --------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------
if __name__ == "__main__":

    # Run the server without SSL
    if not USE_SSL:
        logger.info(f"🖥️▶️ Starting server without SSL on {HOST}:{PORT}.")
        uvicorn.run("server:app", host=HOST, port=PORT, log_config=None)

    else:
        logger.info("🖥️🔒 Attempting to start server with SSL.")
        # Check if cert files exist
        cert_file = "127.0.0.1+1.pem"
        key_file = "127.0.0.1+1-key.pem"
        if not os.path.exists(cert_file) or not os.path.exists(key_file):
             logger.error(f"🖥️💥 SSL cert file ({cert_file}) or key file ({key_file}) not found.")
             logger.error("🖥️💥 Please generate them using mkcert:")
             logger.error("🖥️💥   choco install mkcert") # Assuming Windows based on earlier check, adjust if needed
             logger.error("🖥️💥   mkcert -install")
             logger.error("🖥️💥   mkcert 127.0.0.1 YOUR_LOCAL_IP") # Remind user to replace with actual IP if needed
             logger.error("🖥️💥 Exiting.")
             sys.exit(1)

        # Run the server with SSL
        logger.info(f"🖥️▶️ Starting server with SSL (cert: {cert_file}, key: {key_file}).")
        uvicorn.run(
            "server:app",
            host=HOST,
            port=PORT,
            log_config=None,
            ssl_certfile=cert_file,
            ssl_keyfile=key_file,
        )
