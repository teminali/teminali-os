/* ═══════════════════════════════════════════════════════════════════
   Reading ffmpeg's progress stream, and turning it into a percentage.

   Pure and on its own, for the same reason `remuxPlan.cjs` is: the
   parsing is the part that breaks, and it can be proven under plain
   `node --test` without an ffmpeg, without a recording and without a
   window to draw into.

   `ffmpeg -progress pipe:1 -nostats` writes plain `key=value` lines to
   stdout, in blocks terminated by a `progress=` line:

       bitrate=2100.0kbits/s
       total_size=1048576
       out_time_us=4000000
       out_time_ms=4000000
       out_time=00:00:04.000000
       speed=12.4x
       progress=continue

   Two traps live in that block. `out_time_ms` is a misnomer — ffmpeg
   has always written MICROseconds into it, so reading it as
   milliseconds reports a take as finished a thousand times too early.
   And a block arrives over the pipe in whatever pieces the OS felt
   like, so a line can be split across two reads; anything that parses
   a chunk on its own eventually loses a digit off a number.
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Split whatever has arrived so far into completed samples.
 *
 * Returns the leftover to hand back in on the next call, so a line cut
 * in half by the pipe is rejoined rather than parsed twice.
 *
 * A sample is only emitted on a `progress=` line, which is ffmpeg's own
 * terminator for a block — that is what makes a half-written block
 * impossible to read as a whole one.
 */
function readProgress(carry, chunk) {
  const text = String(carry ?? "") + String(chunk ?? "");

  const samples = [];
  let block = {};
  /*
    Two cursors, and the second one is the whole trick.

    `cursor` walks whole lines. `consumed` only moves to the end of a
    block that actually terminated. What is carried forward is therefore
    the entire OPEN block — not merely the half-line at the end — because
    a read can just as easily stop after `out_time_us=4000000\n` as in
    the middle of it, and keeping only the partial line throws away every
    complete line that came before it in the same block.
  */
  let cursor = 0;
  let consumed = 0;
  for (;;) {
    const newline = text.indexOf("\n", cursor);
    if (newline < 0) break;
    const line = text.slice(cursor, newline);
    cursor = newline + 1;

    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();

    if (key !== "progress") { block[key] = value; continue; }

    samples.push({
      /* `out_time_us` is the honest one; `out_time_ms` is microseconds
         too, and is only read when the build is old enough to omit the
         first. Both are divided by a thousand. */
      outTimeMs: micros(block.out_time_us ?? block.out_time_ms),
      bytes: whole(block.total_size),
      /* "N/A" until the first frame is written, and `speed` is the one
         number that tells a slow convert from a stalled one. */
      speed: block.speed && block.speed !== "N/A" ? block.speed : null,
      done: value === "end",
    });
    block = {};
    consumed = cursor;
  }

  const rest = text.slice(consumed);
  /* A pipe that produces no terminator at all must not grow a buffer
     for twenty minutes. A block is eight short lines; anything past
     this is not one. */
  return { rest: rest.length > 64 * 1024 ? "" : rest, samples };
}

function micros(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n / 1000) : null;
}

function whole(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * How far through, as a whole percent, or null when it cannot be known.
 *
 * Null rather than a guess: a take whose duration was never recorded
 * gets an indeterminate bar, and an indeterminate bar is honest. A bar
 * that invents a number is the thing this whole change exists to stop.
 *
 * Capped at 99 while ffmpeg is still running, because it is not
 * finished until the process exits — `-movflags +faststart` does a
 * second pass over the whole output AFTER the last frame is written,
 * and that pass reports nothing. A bar that sits full for four seconds
 * reads as hung, which is exactly the complaint.
 */
function convertPercent(outTimeMs, durationMs) {
  if (!Number.isFinite(outTimeMs)) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor((outTimeMs / durationMs) * 100)));
}

/**
 * One percentage out of several files converting at once.
 *
 * Screen and camera are two independent ffmpegs, and the panel has one
 * bar. Summing the converted time over the summed expected time weights
 * them the way the wait actually feels, rather than averaging two
 * percentages that started at different moments.
 *
 * Never goes backwards. A stream copy that turns out to be impossible
 * falls back to a re-encode and starts its clock again at zero, and a
 * bar that retreats to 12% having reached 80% looks like a fault.
 */
function aggregatePercent(perStreamMs, durationMs, streamCount, floor = 0) {
  const total = durationMs * Math.max(1, streamCount);
  const done = Object.values(perStreamMs).reduce(
    (sum, ms) => sum + (Number.isFinite(ms) ? ms : 0),
    0,
  );
  const percent = convertPercent(done, total);
  if (percent === null) return floor > 0 ? floor : null;
  return Math.max(percent, floor);
}

module.exports = { readProgress, convertPercent, aggregatePercent };
