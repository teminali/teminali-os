"""Expose the shipping output chain to `voice-conversation.mjs`.

The chain, in `speech_pipeline_manager.py:959` order:

    model -> temi_moves.guard_stream(...) -> RepetitionFilter.wrap(...) -> TTS

Both of those layers rewrite or delete what the operator hears, and until
2026-09-12 the conversation eval scored neither -- it graded `message.content`
straight off Ollama. Every number it produced therefore described an assistant
nobody has ever spoken to, and a regression in either layer could not lower it.
`temi_moves` in particular can REPLACE a reply it judges weak with a second
LLM call's output; if its detectors misfire, the eval saw the good answer and
the operator heard the repair.

The conversation eval is JavaScript and the filter is Python, and the filter is
the last thing between the model and the operator's ears. Before this bridge the
eval scored `message.content` -- the raw generation -- so a filter fix could not
move the number and a filter regression could not lower it.

A port to JavaScript was the obvious alternative and is the wrong one. The
filter's own docstring warns that its normalisation must stay identical to
`resources/bella/persona_eval.py::check`; a third copy in another language would
drift the first time someone touched a regex. So the eval drives the real module
instead, one long-lived process for the whole run.

Protocol: one JSON object per line in, one JSON object per line out, in order.

    {"op": "config", "model": str, "ollama": str, "system": str, "options": {}}
                                      -> {"ok": true, "moves": bool}
    {"op": "reset"}                   -> {"ok": true}
    {"op": "hear", "text": str, "user": str, "spoken": [str]}
                                      -> {"heard": str, "moves": str,
                                          "events": [str], "dropped": [str],
                                          "muted": bool, "keys": [str]}
    {"op": "filter", "text": "..."}   -> {"heard": str, "dropped": [str],
                                          "muted": bool, "keys": [str]}
    {"op": "keys", "text": "..."}     -> {"keys": [str]}

`hear` is the whole chain and is what the eval uses. `filter` is the repetition
stage alone, kept because it is the one stage with no side effects and it makes a
two-stage A/B possible without a second process.

`config` must arrive before the first `hear`: a `temi_moves` repair is a real
generation, and it needs the model, the endpoint and the persona the eval is
measuring rather than a second guess at them. Set `TEMI_MOVES=0` in this
process's environment to run the chain with the rewriter off -- `temi_moves`
reads that at import, so the eval passes it down rather than toggling it here.

`keys` touches no memory. It is what `--no-filter` uses: the eval still wants to
know which sentences a reply carries so it can catch an audible repeat, and with
the filter off that question is asked of the raw generation.

`filter_reply` is used rather than `wrap` because the eval holds a complete reply
-- the filter's docstring names this caller. `muted` is the rescue path: every
sentence was a repeat, so the reply was spoken anyway rather than leaving her
silent. The operator hears a repeat in that case, which is why the eval is told
about it instead of the filter quietly absorbing it.

`keys` is what the filter would remember about the text it just let through. The
eval compares those across turns to catch an audible repeat, using this module's
normalisation rather than a second copy of it.
"""

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "realtime-voice" / "code"))

import temi_moves  # noqa: E402
from repetition_filter import RepetitionFilter, keys  # noqa: E402

CONFIG = {"model": "temi:r2", "ollama": "http://127.0.0.1:11434", "system": "", "options": {},
          "filter": True}


def _generate(prompt: str):
    """One streaming Ollama call, as `llm_module.generate` would make it.

    `temi_moves` repairs a weak reply by generating a replacement, and it wants a
    stream of text chunks. This is the smallest thing that is really that: same
    model, same persona, same options, `think` off, no history -- which is what
    `speech_pipeline_manager.py:957` passes for the same callback.
    """
    body = json.dumps({
        "model": CONFIG["model"],
        "stream": True,
        "think": False,
        "keep_alive": "10m",
        "options": CONFIG["options"],
        "messages": (
            ([{"role": "system", "content": CONFIG["system"]}] if CONFIG["system"] else [])
            + [{"role": "user", "content": prompt}]
        ),
    }).encode()
    req = urllib.request.Request(
        CONFIG["ollama"].rstrip("/") + "/api/chat",
        data=body,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            for line in res:
                line = line.strip()
                if not line:
                    continue
                piece = json.loads(line)
                chunk = (piece.get("message") or {}).get("content") or ""
                if chunk:
                    yield chunk
                if piece.get("done"):
                    break
    except Exception as exc:
        # A repair that cannot generate must leave the reply alone, never take the
        # turn down with it. `temi_moves` treats an empty stream as a failed repair
        # and passes the original through, which is the right outcome here and in
        # production. The noise goes to stderr, which the eval inherits.
        print(f"[bridge] repair generation failed: {exc}", file=sys.stderr, flush=True)
        return


def hear(f: RepetitionFilter, text: str, user: str, spoken):
    """What the operator hears, given what the model emitted.

    The stages run in the pipeline's order and nothing is skipped. `text` arrives
    whole rather than as tokens, which `guard_stream` handles -- it buffers to a
    sentence boundary anyway -- and the release heuristics it applies to a single
    chunk are the ones it would reach at the end of a stream.
    """
    events = []
    guarded = temi_moves.guard_stream(
        iter([text]),
        user,
        _generate,
        recent_spoken=list(spoken or []),
        on_event=lambda ev, *a: events.append(" ".join([str(ev)] + [str(x)[:120] for x in a])),
    )
    moves = "".join(guarded)

    if not CONFIG["filter"]:
        # The repetition stage off, the rewriter still on: the eval needs the two
        # stages separable or it cannot say which one costs what.
        return {"heard": moves, "moves": moves, "events": events,
                "dropped": [], "muted": False, "keys": list(keys(moves))}

    before_dropped = len(f.dropped)
    before_muted = f.kept_nothing
    heard_text = f.filter_reply(moves)
    return {
        "heard": heard_text,
        "moves": moves,
        "events": events,
        "dropped": f.dropped[before_dropped:],
        "muted": f.kept_nothing > before_muted,
        "keys": list(keys(heard_text)),
    }


def main() -> None:
    f = RepetitionFilter()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        op = req.get("op")
        if op == "config":
            for k in ("model", "ollama", "system", "options", "filter"):
                if req.get(k) is not None:
                    CONFIG[k] = req[k]
            out = {"ok": True, "moves": temi_moves.ENABLED}
        elif op == "hear":
            out = hear(f, req.get("text") or "", req.get("user") or "", req.get("spoken") or [])
        elif op == "reset":
            f.reset()
            out = {"ok": True}
        elif op == "filter":
            text = req.get("text") or ""
            before_dropped = len(f.dropped)
            before_muted = f.kept_nothing
            heard = f.filter_reply(text)
            out = {
                "heard": heard,
                "dropped": f.dropped[before_dropped:],
                "muted": f.kept_nothing > before_muted,
                "keys": list(keys(heard)),
            }
        elif op == "keys":
            out = {"keys": list(keys(req.get("text") or ""))}
        else:
            out = {"error": f"unknown op {op!r}"}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
