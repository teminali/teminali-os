"""How much of the conversation the model is allowed to see.

The window used to be twenty messages -- ten exchanges -- chosen to keep the
prompt small and to stop the model copying its own past replies. Both concerns
are real. The size was not: twenty short spoken turns is roughly four hundred
tokens against a context window of eight thousand, so the assistant was being
made to forget things it had ample room to remember.

What that cost was measured on 2026-09-10, over a twenty-eight turn live
conversation. Three facts were stated early -- a name, a day, a preference -- and
asked for again nineteen turns later. All three had fallen out of the window, and
none of the three answers was "I do not know":

    "How do I take my coffee?"  -> "Take it with a dash of sugar."   (black, no sugar)
    "What was I rebuilding?"    -> "A better world, one cup at a time."

Forgetting is recoverable and honest. Inventing a replacement for the forgotten
fact is neither, and a window this tight makes the second one common.

So the budget is counted in what actually constrains it -- context -- rather than
in messages, which vary in size by an order of magnitude and constrain nothing.
"""

# Characters per token, near enough for English prose. Deliberately pessimistic:
# under-estimating the divisor over-estimates the tokens and trims early, which
# is the safe direction.
CHARS_PER_TOKEN = 3.5

# Per-message overhead the chat template adds around every turn (role markers and
# separators). Small, but it is paid per message and a long window has many.
TOKENS_PER_MESSAGE = 4

# Trimming down to exactly the budget means the next turn trims again, and every
# trim changes the prompt prefix and throws away the KV cache built for it. Cut
# to this fraction instead, so a trim buys many turns of stable prefix.
TRIM_TO = 0.75

# However much room there is, a window longer than this is not remembering, it is
# giving an 8B model more of its own prose to imitate.
MAX_MESSAGES = 120

# And never fewer than this, whatever the arithmetic says.
MIN_MESSAGES = 8


def budget_tokens(num_ctx, system_prompt_chars, reply_tokens):
    """Tokens left for history once the prompt and the reply have their room.

    The reply has to fit in the same window it is generated from, so it is
    subtracted here rather than discovered as a truncation later.
    """
    system_tokens = int(system_prompt_chars / CHARS_PER_TOKEN) + TOKENS_PER_MESSAGE
    # A margin for the template's own wrapper and for the estimate being an
    # estimate. Cheap insurance against the one failure that has no good
    # symptom: silent truncation from the front, which drops the system prompt.
    margin = 256
    return max(0, num_ctx - system_tokens - reply_tokens - margin)


def cost(messages):
    """Estimated tokens for a list of chat messages."""
    return sum(int(len(m.get("content", "")) / CHARS_PER_TOKEN) + TOKENS_PER_MESSAGE
               for m in messages)


def window(history, budget, max_messages=MAX_MESSAGES, min_messages=MIN_MESSAGES):
    """The tail of `history` that fits in `budget` tokens.

    Returns the whole history when it fits, which is the common case and the one
    worth being fast and allocation-free about.
    """
    if not history:
        return []
    kept = history[-max_messages:] if len(history) > max_messages else list(history)
    if cost(kept) <= budget:
        return kept

    # Over budget: drop from the front, past the target, so this does not repeat
    # on the very next turn.
    target = budget * TRIM_TO
    while len(kept) > min_messages and cost(kept) > target:
        kept.pop(0)
    return kept
