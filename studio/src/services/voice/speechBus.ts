/**
 * The one node every reply is heard through, and the tap hung off it.
 *
 * The assistant's replies are synthesised in THIS renderer and played straight
 * at the speakers, so no input device on the machine hears them: a screen take
 * records the operator and — on Windows only — the system's own output, and
 * the assistant is silent in every one. macOS has no loopback input at all, so
 * there is no device to select instead. The signal has to be taken where it
 * already exists, which is here.
 *
 * A bus is needed because a tap cannot hang off `destination`: a destination
 * node has no output to read back from. So every path connects to a unity-gain
 * node in front of it, and the tap becomes that node's second consumer.
 *
 * Deliberately free of imports, and it never creates a context of its own —
 * `clausePlayer` owns the single output context and passes it in. That keeps
 * this file testable against a fake context, which matters: every rule below
 * is one whose failure is silent.
 */

/** Both are rebuilt whenever the context they belong to is not the live one. */
let bus: GainNode | null = null;
let tap: MediaStreamAudioDestinationNode | null = null;

/**
 * The node to connect a speaking source to. Unity gain and never adjusted —
 * this is a fan-out point, not a mixer. Falls back to the destination itself
 * on a context too minimal to make a gain node, which costs the recording but
 * never the audibility.
 */
export function speechBus(context: AudioContext): AudioNode {
  if (typeof context.createGain !== "function") return context.destination;
  if (!bus || bus.context !== context) {
    bus = context.createGain();
    bus.connect(context.destination);
    if (tap && tap.context === context) bus.connect(tap);
  }
  return bus;
}

/**
 * A live audio track carrying everything the assistant says. Silent while
 * nothing is speaking and alive as long as the context is, so a recorder can
 * open it before the first reply and hold it for a whole take.
 *
 * What comes back is a CLONE, never the tap's own track: the caller owns what
 * it is handed and will stop it when its take ends, and stopping the tap's own
 * track would end the tap for the life of the renderer — the second take would
 * record silence with nothing to show for it. A context that cannot clone gets
 * null rather than a track that is unsafe to stop.
 */
export function openSpeechTap(context: AudioContext): MediaStreamTrack | null {
  if (typeof context.createMediaStreamDestination !== "function") return null;
  if (!tap || tap.context !== context) {
    tap = context.createMediaStreamDestination();
    // A bus built before the tap existed has to be rebuilt to feed it.
    bus = null;
  }
  speechBus(context);

  const live = tap.stream.getAudioTracks()[0];
  if (!live || typeof live.clone !== "function") return null;
  return live.clone();
}

/**
 * Play a whole-file reply through the bus rather than straight out of the
 * media element, so the tap hears that path too.
 *
 * False means the element was left alone and the caller must not assume this
 * reply is recorded. That happens when the context is not running: routing a
 * suspended graph would make the reply INAUDIBLE, which is a worse failure
 * than one that is merely unrecorded.
 */
export function routeElementToBus(context: AudioContext, element: HTMLMediaElement): boolean {
  if (context.state !== "running") return false;
  if (typeof context.createMediaElementSource !== "function") return false;
  try {
    context.createMediaElementSource(element).connect(speechBus(context));
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the bus and the tap, as a fresh renderer would have. */
export function resetSpeechBus(): void {
  bus = null;
  tap = null;
}
