#!/usr/bin/env python3
"""The hand review, made durable: which admitted turns a human cut, and why.

`grounding.py` states its own blind spot -- it cannot see MISATTRIBUTION. "Flash mode
routes quickly" uses only words the `modes-three` row owns and says the opposite of
what the table says Flash is. Every token is in vocabulary; the sentence is false.
The lane's standing rule is that every admitted turn is read by hand, and this file is
where that reading is written down instead of being done again from memory next time.

MEASURED, first durable run: the six automated gates admitted 91 of 302 candidates and
a human cut 26 of the 91 -- 28.6%. That number is the argument for the rule. It is not
a gate failure: every one of the 26 is fluent, in voice, in vocabulary, and wrong in a
way no regex reaches. The cuts fall into four kinds, and the reason strings say which:

  swap      a fact from another row, stated about this one. The dangerous kind.
  invent    a mechanism, procedure or requirement the table does not contain
            ("download it from the website", "check the system log").
  contra    an answer that contradicts its own row, usually by answering "no" to a
            question the row answers "yes" (voice-streams turn 69 is the clearest).
  dup       true, in voice, and a second copy of a turn already admitted.

A cut is keyed by (fact id, question) rather than by line number, so re-vetting from
the cache -- which reorders nothing but may admit a different set as the gates move --
keeps every verdict attached to the turn it was made about. A key that no longer
matches anything is reported, not silently dropped: it means the run changed under the
review, and the review is then stale.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "data", "instruct-vetted.jsonl")
DEST = os.path.join(HERE, "data", "instruct-admitted.jsonl")

CUT = {
 ("os-desktop", "Does Terminali OS come as a desktop app?"): "invent: 'no other forms are offered' is exclusivity the row does not claim",
 ("os-desktop", "How do you install Terminali OS?"): "invent: a website and an installer, neither in the table",
 ("modes-three", "What does the Flash mode do in Frontier?"): "swap: Flash takes the whole task; Auto is the router",
 ("modes-three", "How does the Auto mode differ from the Max mode?"): "invent: 'Auto scales with demand' is not what adaptive routing is",
 ("modes-three", "What makes the Max mode unique compared to the others?"): "swap: Max does not route, and 'not trained models' garbles modes-not-models",
 ("mode-flash", "Is Flash responsible for all the editing tasks?"): "invent: 'the system decides what needs editing'",
 ("mode-auto", "How can I know which path Auto chose?"): "invent: a system log; the row says Auto reports it, not where",
 ("mode-max", "Is Max locked until it produces a specific output?"): "contra: locked until its artifact QUALIFIES, not until Max produces one",
 ("mode-max", "Why is Max considered a local model that handles everything?"): "contra: same inversion of qualification",
 ("no-auto-flagship", "Is the flagship model always left to the user to select manually?"): "contra: 'no model is ever chosen automatically' overstates a row about flagships",
 ("run-switch", "Does the app handle status checks during a running process?"): "contra: she answers from the run; 'not by me' is the opposite",
 ("run-switch", "Can I interrupt the current run with a 'stop' command?"): "invent: 'you must speak it clearly' is a requirement nothing states",
 ("panel-kinds", "I noticed a tab called Guardian—what's that for?"): "swap: Guardian shows what the machine holds; 'blocking unauthorized access' is invented security",
 ("panel-kinds", "What's the purpose of the Codex tab in the workspace?"): "swap: Codex is a command-line tool's panel, not a knowledge store",
 ("search-one-field", "Does the app allow searching through all its features like panels and projects?"): "dup: the other search-one-field turn says the same 25 words",
 ("rail-stays", "Is there a way to quickly reopen the sidebar?"): "contra: the simile inverts the sentence into nonsense",
 ("the-browser-is-ours", "Can I use Safari instead of the app's browser?"): "contra: the row says a named browser IS honoured",
 ("assistant-autonomy", "Can the app operate without any user input at all?"): "contra: 'no input, no action' denies the auto rung it just named",
 ("screen-tools", "Do these tools cover all the basic interactions I need?"): "swap: 'guide the pointer' is the coordinate model no-coordinates forbids",
 ("screen-tools", "Is there a tool for launching other applications?"): "contra: 'it does not ask questions' denies the confirm rung",
 ("no-coordinates", "Does the app work by identifying elements on the screen?"): "contra: answers 'no' and then describes the row's yes",
 ("no-terminal-launch", "Is there a way to execute code without using a terminal?"): "contra: 'unless you're using a script editor' offers the thing the row blocks",
 ("launch-is-last", "Why is launching the app considered the final action in any workflow?"): "invent: 'no plan to resist, only the screen to claim' is not a sentence about anything",
 ("voice-streams", "Is there a feature that makes the app speak as it processes the response?"): "contra: the row is clause-by-clause streaming; this denies it outright",
 ("ledger-null-cost", "What's the significance of null in the context of unreported costs?"): "contra: 'not absence' contradicts the turn admitted beside it",
 ("arena-ground-truth", "What makes the sandbox benchmark the true measure?"): "contra: 'reflects the agent's claimed actions' is the transcript, not the diff",
}


def main():
    rows = [json.loads(l) for l in open(SRC)]
    keys = {(r["conv"], r["user"]) for r in rows}
    stale = [k for k in CUT if k not in keys]
    kept = [r for r in rows if (r["conv"], r["user"]) not in CUT]

    kinds = {}
    for reason in CUT.values():
        kinds[reason.split(":")[0]] = kinds.get(reason.split(":")[0], 0) + 1

    print(f"read {len(rows)} admitted turns by hand")
    print(f"cut  {len(rows) - len(kept)}  ({', '.join(f'{k} {n}' for k, n in sorted(kinds.items()))})")
    print(f"kept {len(kept)} = {100*len(kept)/len(rows):.1f}% of what the gates admitted")
    if stale:
        print(f"\nSTALE: {len(stale)} cut(s) match no admitted turn -- the run has moved "
              f"under the review; re-read before trusting this file:")
        for c, u in stale:
            print(f"    {c}: {u}")

    words = sorted(len(r["reply"].split()) for r in kept)
    print(f"length: median {words[len(words)//2]} words, mean {sum(words)/len(words):.1f}, "
          f"range {words[0]}-{words[-1]}")
    covered = len({r["conv"] for r in kept})
    print(f"facts covered {covered}/35")

    with open(DEST, "w") as fh:
        for r in kept:
            fh.write(json.dumps(r) + "\n")
    print(f"wrote {DEST}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
