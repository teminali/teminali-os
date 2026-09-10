"""The candidate fix, kept separate from the harness so both arms and (if it earns it)
temi_moves.py call the SAME predicate.

`weakness` already ranks a `repeat` fault alongside fabrication, but `_all_already_said`
demands the WHOLE reply be something she has said before. The lock this lane is chasing is
narrower and commoner: the same opening sentence with one noun swapped --

    turn 3  You are not in the room, so I do not know where your keys are.
    turn 9  You are not in the room, so I do not know where your phone is.

-- which is eleven identical leading tokens and slips through every existing check
(`repetition_filter` compares whole replies, `_all_already_said` needs the whole reply,
`tails.copies` compares trailing sentences).

CIRCULARITY WARNING. This predicate is the same comparison `lock.locks` scores, so the
lock metric is partly tautological for any arm that installs it. Read the tail-copy count
-- an independent detector -- as the primary evidence, and watch `repair_failed` and reply
length for the cost: a guard that only makes repairs fail buys a duller assistant.
"""
import os
import sys

# Import the siblings that live beside this file. This used to point at the authoring
# session's scratchpad, which outlived the session only by luck: `lock` was still being
# loaded from /private/tmp long after the harness was copied into the repo, and would
# have vanished with the next temp sweep. Resolve relative to __file__ instead.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lock import head            # noqa: E402
from tails import shared_prefix  # noqa: E402

# Eight tokens. The four transcripts already collected separate at every threshold from 5
# to 10 (5/13 locked vs 0/13, 0/14, 0/14), so this sits in the middle of the plateau
# rather than on either edge of it.
RECITE_THRESH = 8


def recites(text, spoken_recently=()):
    """True when `text` opens on the opening of something she has already said."""
    h = head(text)
    if not h or len(h) < RECITE_THRESH:
        return False
    for prev in spoken_recently or ():
        p = head(prev or "")
        if p and len(p) >= RECITE_THRESH and shared_prefix(h, p) >= RECITE_THRESH:
            return True
    return False
