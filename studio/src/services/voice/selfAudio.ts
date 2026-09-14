/**
 * The app must not hear itself.
 *
 * `echoGuard.ts` answers a related but different question: it recognises the
 * assistant's *own words* coming back through the microphone, textually, by
 * remembering what was just spoken. That works because we know the text.
 *
 * This is the other half, and nothing textual can catch it. The Files panel
 * plays video and audio, and the Browser panel loads pages that do; both come
 * out of the speakers and back in through the microphone as speech that is
 * real, correctly transcribed, and addressed to nobody in this room. The
 * addressing gate cannot tell it from an operator — it *is* a person speaking,
 * just not this one. Reported as "it was literally listening and responding to
 * the video": a film's dialogue arrived as an operator prompt and was answered.
 *
 * So the rule is not acoustic and not textual, it is about provenance: while
 * the app is making sound, the microphone is only taken seriously when the
 * turn names the assistant. "Temy, pause the video" still works — which is why
 * this is a raised bar and not a closed microphone — and the film does not.
 *
 * Two things feed the monitor. Media elements in this document are watched in
 * the capture phase, because `play` and `pause` do not bubble. The browser
 * panel's pages are not in this document at all, so main reports their
 * audibility over the state channel (`electron/browserView.cjs`).
 */

/**
 * How long after the app goes quiet the microphone is still suspect.
 *
 * A recogniser hands back a final transcript some way behind the audio it was
 * built from, so a turn that arrives just after a video was paused can still
 * be made of that video. Slightly longer than `ECHO_TAIL_MS` for the same
 * reason it exists there.
 */
export const SELF_AUDIO_TAIL_MS = 2000;

/** Anything with the parts of `HTMLMediaElement` that decide whether it is heard. */
export interface AudibleElement {
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  readyState: number;
  isConnected: boolean;
}

/**
 * Is this element putting sound into the room right now?
 *
 * `readyState` matters: an element that has been told to play but has no data
 * yet is silent, and a video the operator has just opened sits there for a
 * moment before its first frame.
 */
export function isElementAudible(element: AudibleElement): boolean {
  return (
    element.isConnected &&
    !element.paused &&
    !element.ended &&
    !element.muted &&
    element.volume > 0 &&
    element.readyState >= 2
  );
}

/**
 * What the app is playing, and when it last stopped.
 *
 * Sources are named rather than counted so that a source which disappears
 * without saying so — a `<video>` React unmounts mid-playback fires no `pause`
 * — can be dropped by name rather than leaving the count stuck above zero and
 * the microphone deaf for the rest of the session. `refresh` is the escape
 * hatch for exactly that: the DOM watcher re-reads its elements on every read.
 */
export class SelfAudioMonitor {
  private readonly sources = new Map<string, boolean>();
  private quietSince = 0;
  private refresh: (() => void) | null = null;

  /** Called before every read, so a watcher can prune what it can no longer see. */
  onRefresh(refresh: (() => void) | null): void {
    this.refresh = refresh;
  }

  set(id: string, audible: boolean, now = Date.now()): void {
    const was = this.playing;
    this.sources.set(id, audible);
    if (was && !this.playing) this.quietSince = now;
  }

  drop(id: string, now = Date.now()): void {
    const was = this.playing;
    this.sources.delete(id);
    if (id !== "assistant:tts" && was && !this.playing) this.quietSince = now;
    else if (id === "assistant:tts" && !this.playing) this.quietSince = 0;
  }

  clear(now = Date.now()): void {
    const was = this.playing;
    this.sources.clear();
    if (was) this.quietSince = now;
  }

  /** The ids currently held, for a watcher pruning what it no longer owns. */
  ids(): string[] {
    return [...this.sources.keys()];
  }

  private get playing(): boolean {
    for (const audible of this.sources.values()) if (audible) return true;
    return false;
  }

  /** True while any source is making sound. */
  get audible(): boolean {
    this.refresh?.();
    return this.playing;
  }

  /**
   * Was the app making sound at any point that could be in this turn?
   *
   * Three ways it could have been: it is playing now; it stopped after the
   * turn began, so part of the turn is made of it; or it stopped so recently
   * that the recogniser's own lag still covers it.
   */
  audibleSince(since: number, now = Date.now()): boolean {
    this.refresh?.();
    if (this.playing) return true;
    if (this.quietSince === 0) return false;
    if (since > 0 && this.quietSince >= since) return true;
    return now - this.quietSince <= SELF_AUDIO_TAIL_MS;
  }
}

/** The app has one set of speakers, so the monitor is shared rather than per-engine. */
export const selfAudio = new SelfAudioMonitor();

interface MediaEventTarget {
  addEventListener(type: string, handler: () => void, options?: { capture?: boolean }): void;
  removeEventListener(type: string, handler: () => void, options?: { capture?: boolean }): void;
  querySelectorAll(selector: string): Iterable<unknown>;
}

/** The events that can change whether an element is heard. `timeupdate` cannot. */
const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "volumechange", "loadeddata", "waiting"];

/**
 * Watch every media element in this document, however it got there.
 *
 * A capture-phase listener on the document is the only way to see these: media
 * events do not bubble, but they are still dispatched down the capture path.
 * The sweep re-reads every element rather than tracking transitions, because
 * an element can also stop being audible without an event — by being removed.
 */
export function watchMediaElements(
  monitor: SelfAudioMonitor,
  doc: MediaEventTarget | null = typeof document === "undefined" ? null : (document as unknown as MediaEventTarget),
): () => void {
  if (!doc) return () => {};

  const ids = new WeakMap<object, string>();
  let next = 0;

  const sweep = (): void => {
    const seen = new Set<string>();
    for (const node of doc.querySelectorAll("video, audio")) {
      const element = node as unknown as AudibleElement & object;
      let id = ids.get(element);
      if (!id) {
        id = `media:${(next += 1)}`;
        ids.set(element, id);
      }
      seen.add(id);
      monitor.set(id, isElementAudible(element));
    }
    // Anything this document owned and can no longer see is gone, not paused.
    for (const id of monitor.ids()) {
      if (id.startsWith("media:") && !seen.has(id)) monitor.drop(id);
    }
  };

  for (const event of MEDIA_EVENTS) doc.addEventListener(event, sweep, { capture: true });
  monitor.onRefresh(sweep);
  sweep();

  return () => {
    for (const event of MEDIA_EVENTS) doc.removeEventListener(event, sweep, { capture: true });
    monitor.onRefresh(null);
  };
}

/**
 * Watch the browser panel's pages, which are not in this document.
 *
 * Subscribed once for the whole app rather than by the pane, because a tab
 * playing a video in the background is unmounted and still audible — that is
 * the point of a view outliving its pane.
 */
export function watchBrowserAudio(
  monitor: SelfAudioMonitor,
  bridge: { onState(handler: (state: { id: string; audible?: boolean }) => void): () => void } | null,
): () => void {
  if (!bridge) return () => {};
  return bridge.onState((state) => {
    if (typeof state?.audible !== "boolean") return;
    monitor.set(`browser:${state.id}`, state.audible);
  });
}

/**
 * Watch the video editor's timeline, which is not in this document either.
 *
 * For a different reason than the browser panel's. Its voices *are* media
 * elements, but detached ones: created to be Web Audio source nodes and never
 * added to the document, so `watchMediaElements` cannot find them and
 * `isElementAudible` would call them silent if it did. The operator's own
 * footage therefore played into the room past every guard here — reported as
 * a line of film dialogue arriving in the pane as something they had said.
 *
 * The engine reports rather than being discovered, so nothing in the video
 * domain has to know a microphone exists.
 */
export function watchTimelineAudio(
  monitor: SelfAudioMonitor,
  engine: { onAudibleChange(handler: (audible: boolean) => void): () => void } | null,
): () => void {
  if (!engine) return () => {};
  const stop = engine.onAudibleChange((audible) => monitor.set("timeline", audible));
  return () => {
    stop();
    monitor.drop("timeline");
  };
}
