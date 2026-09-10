#!/usr/bin/env python3
"""The platform fact table -- step 1 of DATASET.md's self-instruct route.

Every platform turn in the corpus is generated from a row here, so this file is
where the persona/platform split is actually enforced. A fact is not a fact until
it names the document that owns it: `python facts.py` fails if any `source` path
does not exist, which is the same rule the repo's working agreement puts on docs.

Three kinds, taken straight from DATASET.md's "train the reflex, retrieve the
roster" table. They are not three levels of confidence -- they are three different
destinations:

  durable   What a thing IS. Names, shapes, rules that outlive a release.
            -> WEIGHTS. These generate ordinary in-voice answers.

  roster    Which engine handles what; which route exists. Feels durable and is
            really a routing table that moves whenever the gateway does.
            -> PROMPT / RETRIEVAL, never weights. DATASET.md calls this "the trap
            is row 4": train it and she states last month's architecture with total
            composure. Present here so it is explicitly *excluded*, not forgotten.

  live      A port, a count, a path, a build result, what is on screen now.
            -> NOWHERE. Each row carries `bait`: the question whose correct answer
            is a refusal in her own words. DATASET.md argues these are the
            highest-value rows in the corpus, and they cost nothing to produce --
            the same table that teaches her what a panel is teaches her to decline
            to say what it is doing.

The durable rows deliberately teach *vocabulary* over detail. She must never mangle
or invent a panel name; she does not need the panel's byte cap.
"""
import json, os, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))   # the teminaliCode repo

KINDS = {"durable", "roster", "live"}

FACTS = [
    # ---- identity: what the product is -------------------------------------
    dict(id="os-what", kind="durable", source="README.md", where="intro",
         fact="Teminali OS is an autonomous AI studio that runs on your own machine: "
              "local models, local speech, local screen understanding."),
    dict(id="os-hosted-optional", kind="durable", source="README.md", where="intro",
         fact="Hosted providers are available and never required. Nothing has to leave the machine."),
    dict(id="os-desktop", kind="durable", source="README.md", where="intro",
         fact="Teminali OS ships as a desktop application."),
    dict(id="os-vs-frontier", kind="durable", source="README.md", where="intro note",
         fact="The product is Teminali OS. Frontier is the name of the routing gateway "
              "and the local model wrapper, not the product."),

    # ---- the three local modes ---------------------------------------------
    dict(id="modes-three", kind="durable", source="README.md", where="Product modes",
         fact="Frontier has three modes: Flash, Auto and Max. They are routing "
              "architectures over local engines, not models trained here."),
    dict(id="mode-flash", kind="durable", source="README.md", where="Product modes",
         fact="Flash is a lightweight local model taking the whole task: instant edits, high throughput."),
    dict(id="mode-auto", kind="durable", source="README.md", where="Product modes",
         fact="Auto is the adaptive router. It uses only qualified model paths and reports "
              "which path it selected."),
    dict(id="mode-max", kind="durable", source="README.md", where="Product modes",
         fact="Max is the heavyweight local model taking the whole task, and it is locked "
              "until its exact artifact qualifies."),
    dict(id="modes-not-models", kind="durable", source="GATEWAY_DESIGN.md", where="Model modes",
         fact="The three modes pick a profile. They are not themselves models."),

    # ---- the other hands ----------------------------------------------------
    dict(id="clis-are-real", kind="durable", source="README.md", where="Product modes",
         fact="Claude Code and Codex run as the operator's own command-line tools in the real workspace."),
    dict(id="no-auto-flagship", kind="durable", source="README.md", where="Product modes",
         fact="No provider's flagship model is ever selected automatically."),
    dict(id="voice-is-not-hands", kind="durable", source="studio/README.md", where="Voice",
         fact="In the voice stage one assistant speaks and another works: Temi holds the "
              "conversation, and the Teminali OS assistant does the engineering with no chat "
              "surface of its own."),
    dict(id="run-switch", kind="durable", source="studio/README.md", where="Voice",
         fact="While a run is in flight, asking what is going on is answered from that run "
              "rather than starting a second conversation. 'Stop' lands on the run; "
              "'stop talking' stops only the voice."),

    # ---- the shell ----------------------------------------------------------
    dict(id="sidebar-views", kind="durable", source="studio/README.md", where="The shell",
         fact="The sidebar views are Chats, Explorer, Search, My Projects and Skills."),
    dict(id="panel-kinds", kind="durable", source="studio/README.md", where="The shell",
         fact="The workspace panel strip holds tabs of twelve kinds: File, Terminal, Browser, "
              "Canvas, Side chat, Guardian, Claude Code, Codex, Usage, Benchmark, Release and "
              "Video Editor."),
    dict(id="video-editor-single", kind="durable", source="studio/README.md", where="The shell",
         fact="Video Editor is the one panel limited to a single tab, because it owns a timeline "
              "and a playback clock that a second copy would compete for."),
    dict(id="search-one-field", kind="durable", source="studio/README.md", where="The shell",
         fact="Search covers the whole application from one field: panels, skills, projects, "
              "workspace files by name and by content, chats, bookmarks, history and downloads."),
    dict(id="rail-stays", kind="durable", source="studio/README.md", where="The shell",
         fact="The rail stays on screen when the sidebar panel is collapsed, so a dismissed "
              "sidebar is one click from open."),
    dict(id="the-browser-is-ours", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="'The browser' means this application's own Browser panel, not Safari. A web "
              "address goes there unless another browser is named."),

    # ---- the screen assistant ----------------------------------------------
    dict(id="assistant-modes", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="The screen assistant has three modes: dictate, talk and agent."),
    dict(id="assistant-autonomy", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="Its autonomy has three rungs: guide, confirm and auto."),
    dict(id="screen-tools", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="The screen tools are look, click, type, key, scroll, drag, launch, focus and wait."),
    dict(id="no-coordinates", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="No screen tool takes a coordinate. Everything is aimed at something named on screen."),
    dict(id="no-terminal-launch", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="No terminal, Script Editor or Automator can be launched by the assistant: a shell "
              "prompt plus a type step is arbitrary code execution wearing an allowlist."),
    dict(id="launch-is-last", kind="durable", source="studio/README.md", where="The screen assistant",
         fact="Opening an application is always the last step of a plan, because what it opens has "
              "no window to plan against yet."),

    # ---- voice --------------------------------------------------------------
    dict(id="voice-local-default", kind="durable", source="studio/README.md", where="Voice",
         fact="Voice is local by default: whisper.cpp for recognition, and the system voice for speech."),
    dict(id="voice-streams", kind="durable", source="studio/README.md", where="Voice",
         fact="Speech streams clause by clause, so a long reply starts speaking after its first "
              "clause rather than after all of it."),
    dict(id="voice-reviewed", kind="durable", source="studio/README.md", where="Voice",
         fact="Nothing reaches the chat unreviewed: every spoken utterance passes a repair pass "
              "the operator sees before it sends."),
    dict(id="voice-routed-apart", kind="durable", source="studio/README.md", where="Voice",
         fact="Recognition and speech are routed independently, so upgrading one leaves the other "
              "where it was."),

    # ---- guardian and the honest-number rule --------------------------------
    dict(id="guardian-what", kind="durable", source="studio/README.md", where="Guardian",
         fact="Guardian shows what the machine is holding right now."),
    dict(id="guardian-null", kind="durable", source="studio/README.md", where="Guardian",
         fact="In Guardian every number is measured or it is null. A metric that could not be read "
              "is never drawn as a plausible zero."),
    dict(id="guardian-layers", kind="durable", source="studio/README.md", where="Guardian",
         fact="Guardian has three layers: a snapshot, an auto-unload that evicts idle resident "
              "models, and a governor that can close applications."),
    dict(id="governor-careful", kind="durable", source="studio/README.md", where="Guardian",
         fact="The governor quits an application gracefully and never by signal, never touches the "
              "app you are using, and treats unknown unsaved work as unsafe."),
    dict(id="ledger-null-cost", kind="durable", source="studio/README.md", where="Usage ledger",
         fact="In the usage ledger an unreported cost is null, never zero."),
    dict(id="arena-ground-truth", kind="durable", source="studio/README.md", where="Benchmark arena",
         fact="In the benchmark arena the diff in the sandbox is ground truth; the transcript is "
              "only what the agent claims."),

    # ---- roster: true today, moves tomorrow. PROMPT, NOT WEIGHTS ------------
    dict(id="roster-lane-resolution", kind="roster", source="studio/README.md", where="Engines",
         fact="Which installed model each lane resolves to, decided per machine by planRouting."),
    dict(id="roster-profiles", kind="roster", source="GATEWAY_DESIGN.md", where="Profiles",
         fact="Which profile each mode resolves to, and which model backs that profile."),
    dict(id="roster-endpoints", kind="roster", source="GATEWAY_DESIGN.md", where="Initial endpoints",
         fact="Which routes the gateway exposes."),
    dict(id="roster-who-handles", kind="roster", source="README.md", where="Product modes",
         fact="Which of Frontier, Codex and Claude Code picks up a given kind of job. "
              "DATASET.md's trap row: this feels like design and is a routing table."),
    dict(id="roster-providers", kind="roster", source="README.md", where="Product modes",
         fact="Which hosted providers are configured and which lanes they offer."),
    dict(id="roster-shortcuts", kind="roster", source="studio/README.md", where="The shell",
         fact="Which key opens which panel. Stable in the doc, but rebindable, and a wrong "
              "shortcut spoken with confidence is worse than 'check the panel menu'."),

    # ---- live: never anywhere. Each row is a refusal generator ---------------
    dict(id="live-flash-model", kind="live", source="studio/README.md", where="Engines",
         fact="Which model the Flash lane resolved to on this machine right now.",
         bait="Which model is Flash running right now?"),
    dict(id="live-max-qualified", kind="live", source="GATEWAY_DESIGN.md", where="Model modes",
         fact="Whether Max has qualified yet.",
         bait="Has Max been unlocked yet?"),
    dict(id="live-sidecar-up", kind="live", source="studio/README.md", where="Voice",
         fact="Whether the speech sidecar is running.",
         bait="Is the voice sidecar up?"),
    dict(id="live-open-panels", kind="live", source="studio/README.md", where="The shell",
         fact="Which panels are open at this moment.",
         bait="What tabs do I have open?"),
    dict(id="live-open-project", kind="live", source="studio/README.md", where="The shell",
         fact="Which project is currently open.",
         bait="What project am I in?"),
    dict(id="live-memory", kind="live", source="studio/README.md", where="Guardian",
         fact="How much memory the resident models are holding.",
         bait="How much memory is Ollama holding?"),
    dict(id="live-resident-models", kind="live", source="studio/README.md", where="Guardian",
         fact="Which models are resident right now.",
         bait="What models are loaded at the moment?"),
    dict(id="live-build", kind="live", source="README.md", where="Verification",
         fact="Whether the last build or test run passed.",
         bait="Did the build pass?"),
    dict(id="live-test-count", kind="live", source="README.md", where="Verification",
         fact="How many tests there are, and how many passed.",
         bait="How many tests are in the suite?"),
    dict(id="live-on-screen", kind="live", source="studio/DESIGN.md", where="5. The screen assistant",
         fact="What is on the screen at this moment.",
         bait="What am I looking at?"),
    dict(id="live-port", kind="live", source="GATEWAY_DESIGN.md", where="Initial endpoints",
         fact="Which port the gateway is listening on.",
         bait="What port is the gateway on?"),
    dict(id="live-file-path", kind="live", source="studio/DESIGN.md", where="3. Shell architecture",
         fact="The path of a file, or whether a named file exists.",
         bait="Where does that file live?"),
    dict(id="live-run-outcome", kind="live", source="studio/README.md", where="Voice",
         fact="What the working assistant did on the last run.",
         bait="What did it just change?"),
    dict(id="live-usage-spend", kind="live", source="studio/README.md", where="Usage ledger",
         fact="How much has been spent, or how many tokens have been used.",
         bait="What have I spent today?"),
]


def check():
    """Fail loudly on the two ways this table can rot: a bad kind and a dead path."""
    bad = []
    seen = set()
    for f in FACTS:
        if f["id"] in seen:
            bad.append(f'duplicate id {f["id"]}')
        seen.add(f["id"])
        if f["kind"] not in KINDS:
            bad.append(f'{f["id"]}: unknown kind {f["kind"]}')
        if not os.path.exists(os.path.join(ROOT, f["source"])):
            bad.append(f'{f["id"]}: source does not exist -- {f["source"]}')
        if f["kind"] == "live" and not f.get("bait"):
            bad.append(f'{f["id"]}: a live row must carry the question it baits')
        if f["kind"] != "live" and f.get("bait"):
            bad.append(f'{f["id"]}: only a live row may carry bait')
    return bad


def main():
    bad = check()
    tally = Counter(f["kind"] for f in FACTS)
    for k in ("durable", "roster", "live"):
        print(f"  {tally[k]:5d}  {k}")
    print(f"\n  {len(FACTS):5d}  rows, {len({f['source'] for f in FACTS})} source documents")

    if bad:
        print("\nFAIL")
        for b in bad:
            print("  " + b)
        return 1

    dest = os.path.join(HERE, "data", "facts.jsonl")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as fh:
        for f in FACTS:
            fh.write(json.dumps(f) + "\n")
    print(f"\ntable OK -- wrote {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
