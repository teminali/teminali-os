"""
Serve a trained adapter on the wire the rest of this repo already speaks.

Nothing in Teminali OS can *hear* an adapter. `mlx_lm` holds the weights, but
every consumer -- `resources/bella/persona_eval.py`, `code/llm_module.py`, and
Studio's `/api/ollama/chat` -- talks to Ollama's HTTP API, and Ollama cannot
load an MLX LoRA adapter. This is the shim across that gap: an Ollama-shaped
`/api/chat` backed by `mlx_lm.load(..., adapter_path=...)`.

Three decisions, so the next reader does not have to re-derive them:

THE WIRE is Ollama's, not OpenAI's, and not `mlx_lm.server`'s. `mlx_lm` ships an
OpenAI-compatible server that would have cost nothing to launch -- and then every
caller in the repo would need rewriting to use it. The shim exists so that
pointing an existing consumer at a fine-tuned model is a change of *port*, and
nothing else. `stream: false` returns one JSON object; `stream: true` returns
NDJSON deltas terminated by `{"done": true}`, because `llm_module.py:967` reads
the stream and the non-streaming path would deadlock the voice lane.

THE RENDER is the trainer's. `train.py` builds a pair with a plain
`apply_chat_template` over [system?, user, assistant] and no template flags; this
file calls the same method with `add_generation_prompt=True` on the same
tokenizer. An adapter served on a different render is a different model, and the
failure mode is silent -- slightly worse replies, not an error.

THE PORT is 11435, not 11434. Real Ollama keeps 11434. A peer thread runs the
voice lane against it, and this shim serving base-vs-adapter comparisons must
not evict the model that lane depends on. Pass `--port 11434` deliberately, with
Ollama stopped, when you want the whole product to use the adapter instead.

The empty `<think></think>` block is stripped from the reply. The adapter is
trained to emit one (see `train.py`, "the mask offset lands before it"), and no
caller wants to see it -- `persona_eval` would score the tags inside it.

Usage:
    ../.venv/bin/python serve.py --adapter runs/r2            # newest checkpoint
    ../.venv/bin/python serve.py --adapter runs/r2 --iter 24  # one checkpoint
    ../.venv/bin/python serve.py                              # base model, no adapter
    ../.venv/bin/python serve.py --adapter runs/r2 --port 11434
"""

# `training/select.py` shadows the stdlib `select` module, and `http.server`
# imports `socketserver` -> `socket` -> `selectors` -> `select`. Same two-place
# fix as train.py: drop this file's own directory from sys.path, and do not sit
# in `training/` so a respawned child does not prepend it as the cwd. Every path
# below is absolute, so the chdir costs nothing. See train.py for the full note.
import sys as _sys, os as _os
_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path = [p for p in _sys.path if _os.path.abspath(p or ".") != _here]
_os.chdir(_os.path.dirname(_here))

import argparse
import json
import re
import shutil
import tempfile
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

R = Path(__file__).resolve().parent
RUNS = R / "runs"
MODEL = "mlx-community/Qwen3-8B-4bit"

# An empty thinking block, exactly as the trained adapter emits it. A non-empty
# one is left alone: that is the model actually thinking, which is a finding
# worth seeing rather than hiding.
EMPTY_THINK = re.compile(r"^\s*<think>\s*</think>\s*")
ANY_THINK = re.compile(r"^\s*<think>.*?</think>\s*", re.DOTALL)

# One model on one GPU, served by a plain `HTTPServer` and not a threading one:
# MLX's streams are thread-local, and generating inside a `ThreadingHTTPServer`
# worker dies on `RuntimeError: There is no Stream(cpu, 0) in current thread`.
# Requests are therefore handled one at a time on the main thread, which is what
# serialized generation on a single GPU amounts to anyway.
_STATE = {}


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def checkpoint_dir(adapter, iteration):
    """An adapter directory `mlx_lm.load` will accept.

    `mlx_lm` loads `<dir>/adapters.safetensors` and nothing else, so serving a
    mid-run checkpoint (`0000024_adapters.safetensors`) means staging it under
    that name. The copy goes to a temp directory rather than overwriting the
    run's final weights -- r1 taught this lane that the checkpoint you want is
    rarely the last one, and clobbering it to serve it would be the same
    mistake twice.
    """
    adapter = Path(adapter)
    if not adapter.is_absolute():
        adapter = R / adapter
    if not adapter.is_dir():
        raise SystemExit(f"no such adapter directory: {adapter}")
    if iteration is None:
        if not (adapter / "adapters.safetensors").exists():
            raise SystemExit(f"{adapter} has no adapters.safetensors")
        return str(adapter)

    src = adapter / f"{iteration:07d}_adapters.safetensors"
    if not src.exists():
        have = sorted(p.name for p in adapter.glob("*_adapters.safetensors"))
        raise SystemExit(f"no checkpoint at iter {iteration} in {adapter}; have: {have}")
    staged = Path(tempfile.mkdtemp(prefix=f"adapter-{adapter.name}-{iteration:05d}-"))
    shutil.copy2(src, staged / "adapters.safetensors")
    shutil.copy2(adapter / "adapter_config.json", staged / "adapter_config.json")
    return str(staged)


def load_model(model, adapter, iteration):
    from mlx_lm import load
    path = checkpoint_dir(adapter, iteration) if adapter else None
    t0 = time.time()
    print(f"loading {model}" + (f"\n  adapter {path}" if path else "\n  (base model, no adapter)"),
          flush=True)
    m, tok = load(model, adapter_path=path)
    print(f"  loaded in {time.time() - t0:.1f}s", flush=True)
    return m, tok


def render(tok, messages, thinking=True):
    """The trainer's render, plus the generation prompt. See the docstring.

    `thinking=False` is what Ollama's `think: false` actually does, and stripping
    a `<think>` block afterwards is not the same thing. Measured 2026-09-12: the
    BASE model under `think: false` spent all 256 tokens inside an unterminated
    `<think>`, so `strip_think` found no closing tag and the eval graded the
    model's reasoning as its reply -- 7 of 9 fabrication turns failed for "no
    delivery tag" and the comparison the arm existed for was worthless.

    The adapter does not show this: it was trained to emit an empty `<think></think>`
    and does so unprompted, which is exactly why the defect hid until a base arm
    ran. Disabling thinking in the TEMPLATE, the way Ollama does, is the render
    production uses -- so this is closer to the trainer's render, not further from
    it. `enable_thinking` is a Qwen3 template keyword; a template that does not
    take it renders unchanged rather than failing.
    """
    kwargs = dict(add_generation_prompt=True, tokenize=False)
    if not thinking:
        try:
            return tok.apply_chat_template(messages, enable_thinking=False, **kwargs)
        except TypeError:
            pass
    return tok.apply_chat_template(messages, **kwargs)


def sampler_for(options):
    from mlx_lm.sample_utils import make_sampler
    return make_sampler(
        temp=float(options.get("temperature", 0.7)),
        top_p=float(options.get("top_p", 0.8)),
        top_k=int(options.get("top_k", 20)),
    )


# Ollama's window for all three penalties. llama.cpp calls it `penalty_last_n`
# and defaults it to 64; mlx_lm's own default is 20, which would penalise a much
# tighter window than the server does. Match the server, not the library.
REPEAT_LAST_N = 64


def logits_for(options):
    """The penalty samplers, in Ollama's vocabulary.

    `sampler_for` covers temperature/top_p/top_k, which is all this shim needed
    while the eval sent nothing else. But production does send more:
    `llm_module.py` sets `frequency_penalty 0.7` and `presence_penalty 0.5` on
    every request, and those are precisely the samplers that suppress anaphoric
    list-babble -- the adapter's dominant failure mode. An eval that omits them
    scores a configuration nobody ships, and a shim that ignores them while
    Ollama honours them makes base-vs-adapter unfair in a *new* direction. So
    the shim has to understand them before the eval may start sending them.

    mlx_lm 0.31.3's semantics match OpenAI's and llama.cpp's: frequency
    subtracts `penalty` once per occurrence in the window, presence subtracts it
    once if the token occurs at all. The window fed to a processor starts as the
    whole prompt and grows with generation (`generate_step` seeds `tokens` with
    the prompt on its first `_step`), so a penalty can see the prompt tail just
    as it does under llama.cpp.

    Returns [] when nothing is set, which is the previous behaviour exactly.
    """
    from mlx_lm.sample_utils import make_logits_processors
    window = int(options.get("repeat_last_n", REPEAT_LAST_N))
    # Ollama spells the multiplicative one `repeat_penalty`; 1.0 is its identity
    # and qwen3:8b's Modelfile ships exactly that, so treat it as unset rather
    # than paying for a processor that cannot change a logit.
    repeat = float(options.get("repeat_penalty", 1.0))
    return make_logits_processors(
        repetition_penalty=None if repeat == 1.0 else repeat,
        repetition_context_size=window,
        frequency_penalty=float(options.get("frequency_penalty", 0.0)) or None,
        frequency_context_size=window,
        presence_penalty=float(options.get("presence_penalty", 0.0)) or None,
        presence_context_size=window,
    )


def strip_think(text, keep_nonempty=True):
    out = EMPTY_THINK.sub("", text, count=1)
    if out == text and not keep_nonempty:
        out = ANY_THINK.sub("", text, count=1)
    return out.strip()


def envelope(model, content, prompt_tokens, gen_tokens, elapsed, done=True,
             reason="stop"):
    """Ollama's non-streaming /api/chat body.

    `prompt_eval_count` is real and is the reason it is here: `llm_module.py`
    reads it to detect a truncated prompt (it pins to num_ctx exactly when
    Ollama truncates). MLX has no fixed window, so this count is always the
    true one -- which is itself the answer that check is looking for.

    `done_reason` is real too, and was not: it was hardcoded to "stop", so a
    reply that ran into `num_predict` and was cut off reported that it had
    finished on its own. Measured 2026-09-10 -- the r2 adapter under the short
    prompt returned `done_reason "stop"` with `eval_count` exactly 220, the
    cap. That is the runaway this shim exists to make visible, reported as its
    opposite. `mlx_lm` already knows which it was; pass its `finish_reason`
    through. The vocabulary is the same on both sides -- "stop" or "length".
    """
    return {
        "model": model, "created_at": now(),
        "message": {"role": "assistant", "content": content},
        "done": done, "done_reason": (reason or "stop") if done else None,
        "total_duration": int(elapsed * 1e9),
        "prompt_eval_count": prompt_tokens, "eval_count": gen_tokens,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass   # the run log is the generation log, not an access log

    def _send(self, code, body, ctype="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        name = _STATE["name"]
        if self.path.rstrip("/") in ("/api/tags", "/api/ps"):
            # Some clients probe for a model list before speaking. Answer with
            # the one model there is, under the name callers already send.
            self._send(200, {"models": [{"name": name, "model": name,
                                         "modified_at": now(), "size": 0,
                                         "details": {"family": "qwen3"}}]})
        elif self.path.rstrip("/") in ("", "/"):
            self._send(200, b"mlx_lm adapter shim: " + name.encode(), "text/plain")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/api/chat", "/api/generate"):
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send(400, {"error": f"bad request body: {e}"})
            return

        if self.path.rstrip("/") == "/api/generate":
            messages = [{"role": "user", "content": body.get("prompt", "")}]
        else:
            messages = body.get("messages") or []
        if not messages:
            self._send(400, {"error": "no messages"})
            return

        options = body.get("options") or {}
        max_tokens = int(options.get("num_predict", 220))
        keep = body.get("think") is True
        try:
            if body.get("stream"):
                self._stream(messages, options, max_tokens, keep)
            else:
                self._once(messages, options, max_tokens, keep)
        except (BrokenPipeError, ConnectionResetError):
            pass   # the caller hung up mid-generation; nothing to report

    def _generate(self, messages, options, max_tokens, thinking=True):
        from mlx_lm import stream_generate
        model, tok = _STATE["model"], _STATE["tok"]
        prompt = render(tok, messages, thinking=thinking)
        for resp in stream_generate(model, tok, prompt, max_tokens=max_tokens,
                                    sampler=sampler_for(options),
                                    logits_processors=logits_for(options)):
            yield resp

    def _once(self, messages, options, max_tokens, keep):
        t0 = time.time()
        text, last = [], None
        for resp in self._generate(messages, options, max_tokens, thinking=keep):
            text.append(resp.text)
            last = resp
        content = strip_think("".join(text), keep_nonempty=keep)
        self._send(200, envelope(_STATE["name"], content,
                                 last.prompt_tokens if last else 0,
                                 last.generation_tokens if last else 0,
                                 time.time() - t0,
                                 reason=last.finish_reason if last else None))

    def _stream(self, messages, options, max_tokens, keep):
        """NDJSON deltas, Ollama-shaped, terminated by a `done` object.

        The thinking block cannot be stripped from a delta in isolation, so the
        head of the stream is buffered until the opening `<think>` has either
        closed or failed to appear. That costs a few tokens of latency once per
        reply, which the voice lane will not notice.
        """
        t0 = time.time()
        # The body length is unknown up front, so it is close-delimited: under
        # HTTP/1.1 that MUST be announced, or the client blocks forever waiting
        # for a Content-Length that is never coming.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Connection", "close")
        self.end_headers()
        head, holding, last = [], True, None
        # The template puts a blank line after `</think>`, and it arrives as its
        # own token *after* the block has closed -- so stripping the block is not
        # enough, the stream would open with a delta of pure whitespace. The
        # voice lane would hand that to TTS as a first chunk with nothing in it.
        # Suppress leading whitespace until the first real character is out.
        started = False

        def emit(obj):
            self.wfile.write(json.dumps(obj).encode() + b"\n")
            self.wfile.flush()

        def emit_text(text, resp, done=False):
            nonlocal started
            if not started:
                text = text.lstrip()
                if not text:
                    return
                started = True
            emit(envelope(_STATE["name"], text, resp.prompt_tokens,
                          resp.generation_tokens, time.time() - t0, done=done))

        for resp in self._generate(messages, options, max_tokens, thinking=keep):
            last = resp
            if holding:
                head.append(resp.text)
                joined = "".join(head)
                stripped = strip_think(joined, keep_nonempty=keep)
                # Release once the block has closed, or once it is clear there
                # is no block to wait for.
                if "</think>" in joined or (len(joined) > 12 and "<think>" not in joined):
                    holding = False
                    emit_text(stripped, resp)
                continue
            emit_text(resp.text, resp)

        if holding and last is not None:   # the reply was shorter than the hold window
            emit_text(strip_think("".join(head), keep_nonempty=keep), last)
        final = envelope(_STATE["name"], "",
                         last.prompt_tokens if last else 0,
                         last.generation_tokens if last else 0,
                         time.time() - t0, done=True,
                         reason=last.finish_reason if last else None)
        emit(final)


def main():
    a = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    a.add_argument("--adapter", default=None,
                   help="a runs/<name> directory; omit to serve the base model")
    a.add_argument("--iter", type=int, default=None,
                   help="serve one mid-run checkpoint, e.g. --iter 24")
    a.add_argument("--model", default=MODEL)
    a.add_argument("--port", type=int, default=11435,
                   help="11434 is real Ollama's; take it only deliberately")
    a.add_argument("--name", default="qwen3:8b",
                   help="the model name echoed back; callers send this and it is ignored")
    args = a.parse_args()

    _STATE["name"] = args.name
    _STATE["model"], _STATE["tok"] = load_model(args.model, args.adapter, args.iter)

    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    what = f"{args.adapter}" + (f"@{args.iter}" if args.iter is not None else "") \
        if args.adapter else "base model"
    print(f"serving {what} on http://127.0.0.1:{args.port}/api/chat  (ctrl-c to stop)",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)


if __name__ == "__main__":
    main()
