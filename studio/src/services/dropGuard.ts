/**
 * The window is not a drop target.
 *
 * Chromium's default action for a file dropped on a page that did not claim it
 * is to *navigate to that file*. In a browser tab that is a mild surprise; in
 * Electron it looks like the application crashed, because the renderer replaces
 * the whole app with a text file or a blank PDF frame and there is no address
 * bar to go back from. A stray drop anywhere outside a real drop zone — the
 * tab strip, the terminal, the chrome around the panels — does that, so the
 * guard has to be on the window and not on the places we happen to remember.
 *
 * It must not, however, make the window a drop target of its own: the composer
 * takes attachments, the media panel takes assets, the timeline takes clips and
 * the file pane takes files, and those still have to work. The signal that one
 * of them has claimed the drag is the platform's own — a drop zone accepts a
 * `dragover` by calling `preventDefault()`, and the guard runs last (it is on
 * the window; React's handlers are on the root container inside it), so
 * `defaultPrevented` is already true by the time it sees the event.
 *
 * Unclaimed drags are refused *visibly*: `dropEffect = "none"` makes the cursor
 * say so while the file is still over the window, which is the DESIGN.md rule
 * about dead affordances applied to a pointer instead of a button.
 */

/** The minimum of a drag event this guard needs. Not `DragEvent`, so it is testable. */
export interface GuardableDragEvent {
  defaultPrevented: boolean;
  preventDefault: () => void;
  dataTransfer?: { dropEffect: string } | null;
}

export function guardDragOver(event: GuardableDragEvent): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
  // Refuse it where the operator can see the refusal, rather than accepting a
  // drag the window has nothing to do with.
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
}

export function guardDrop(event: GuardableDragEvent): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
}

/**
 * Arms the guard for the lifetime of the document. Returns an unsubscribe so a
 * test — or a second surface — can take it back off.
 */
export function installWindowDropGuard(target: EventTarget = window): () => void {
  const onDragOver = (event: Event) => guardDragOver(event as unknown as GuardableDragEvent);
  const onDrop = (event: Event) => guardDrop(event as unknown as GuardableDragEvent);
  target.addEventListener("dragover", onDragOver);
  target.addEventListener("drop", onDrop);
  return () => {
    target.removeEventListener("dragover", onDragOver);
    target.removeEventListener("drop", onDrop);
  };
}
