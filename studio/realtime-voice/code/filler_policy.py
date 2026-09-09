"""Filled-pause policy: when Bella breathes, and which breath.

A filler is NOT text handed to the TTS. Kokoro renders "hmm" with Kokoro's own
contour, and that contour is the whole problem -- the reference cold line spans
2.34 semitones while the flattest Kokoro voice measures 5.72. One rising, curious
"Hmm?" undoes the character. So the bank is pre-rendered audio, auditioned and
kept only where it came out flat (see resources/bella/render_filler_bank.py), and
this module only decides *whether* and *which*.

Two events, deliberately not one:

  ACK    fires the moment the user's utterance commits, before the model has
         produced anything. It means "I heard you".
  THINK  fires only if the wait runs past `think_after`. It means "I'm still here".

At most one of them fires per turn. On this machine steady-state time-to-first-
audio is ~0.4s and a cold first reply is ~2.64s, so a 0.6s THINK threshold almost
never fires in normal conversation and reliably covers a cold start. Rare by
construction is the intended behaviour, not a limitation: for this character the
silence is the filler, and a breath that arrives every turn stops reading as
restraint and starts reading as a tic.

Selection is least-recently-used, not random: deterministic so it can be tested,
and it rotates the bank on its own. A clip is provisional until `played()`, the
same contract RepetitionFilter uses for a sentence -- a filler the user talked
over never happened, so it costs neither its slot in the rotation nor the turn
gap.
"""

from collections import deque
from typing import Dict, Iterable, List, Optional, Sequence

ACK = "ack"
THINK = "think"


class FillerPolicy:
    """Decides when a filled pause is in character. Holds no audio.

    Not thread-safe, by the same reasoning as RepetitionFilter: one conversation
    is one speaker, and only one turn is ever in flight.
    """

    def __init__(
        self,
        bank: Dict[str, Sequence[str]],
        *,
        think_after: float = 0.6,
        min_turn_gap: int = 2,
        memory: int = 6,
    ):
        self._bank = {k: list(v) for k, v in bank.items()}
        self._think_after = float(think_after)
        self._min_turn_gap = int(min_turn_gap)
        self._recent: deque = deque(maxlen=max(1, int(memory)))

        self._turns = 0             # turns seen
        self._last_fired_turn = None
        self._prev_fired_turn = None
        self._armed_at: Optional[float] = None
        self._fired_this_turn = False
        self._speaking = False
        self._pending: Optional[str] = None

        self.suppressed_gap = 0     # fillers withheld to keep density down
        self.abandoned = 0          # fillers the user talked over

    # -- turn lifecycle ---------------------------------------------------

    def user_committed(self, now: float) -> Optional[str]:
        """The user's utterance is final. Maybe acknowledge it."""
        self._turns += 1
        self._armed_at = float(now)
        self._fired_this_turn = False
        self._speaking = False
        self._pending = None
        return self._take(ACK)

    def poll(self, now: float) -> Optional[str]:
        """Call on a timer. Returns a THINK clip once the wait has run long."""
        if self._armed_at is None or self._speaking or self._fired_this_turn:
            return None
        if float(now) - self._armed_at < self._think_after:
            return None
        return self._take(THINK)

    def speech_started(self, now: float = 0.0) -> None:
        """The first real TTS chunk went out. Nothing more fires this turn."""
        self._speaking = True
        self._armed_at = None
        self.played()

    def barge_in(self, now: float = 0.0) -> None:
        """The user spoke over us. The provisional filler never happened."""
        self._armed_at = None
        self._speaking = False
        if self._pending is not None:
            self._pending = None
            self._fired_this_turn = False
            self._last_fired_turn = self._prev_fired_turn
            self.abandoned += 1

    def played(self) -> None:
        """The filler was delivered in full. Fold it into the rotation."""
        if self._pending is None:
            return
        self._recent.append(self._pending)
        self._pending = None

    def reset(self) -> None:
        """Forget the conversation. Bank and thresholds survive."""
        self._recent.clear()
        self._turns = 0
        self._last_fired_turn = None
        self._prev_fired_turn = None
        self._armed_at = None
        self._fired_this_turn = False
        self._speaking = False
        self._pending = None
        self.suppressed_gap = 0
        self.abandoned = 0

    # -- selection --------------------------------------------------------

    def _take(self, category: str) -> Optional[str]:
        clips = self._bank.get(category) or []
        if not clips:
            return None
        if self._last_fired_turn is not None:
            if self._turns - self._last_fired_turn < self._min_turn_gap:
                self.suppressed_gap += 1
                return None

        clip = self._least_recently_used(clips)
        self._prev_fired_turn = self._last_fired_turn
        self._last_fired_turn = self._turns
        self._fired_this_turn = True
        self._pending = clip
        return clip

    def _least_recently_used(self, clips: List[str]) -> str:
        """The eligible clip used longest ago; unused clips come first."""
        order = list(self._recent)

        def age(clip: str) -> int:
            # Position of the clip's MOST RECENT use. index() would return the
            # first occurrence, which pins the rotation on one clip forever once
            # the bank has cycled once. Unused clips are maximally old.
            if clip not in order:
                return -1
            return len(order) - 1 - order[::-1].index(clip)

        return min(clips, key=lambda c: (age(c), clips.index(c)))

    # -- introspection ----------------------------------------------------

    @property
    def recent(self) -> List[str]:
        return list(self._recent)
