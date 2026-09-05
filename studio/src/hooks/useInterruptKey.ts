import { useEffect, type RefObject } from "react";
import { interruptsRun } from "../services/interruption";

/**
 * Escape stops the run, on every chat surface.
 *
 * The judgement — is this keystroke an interrupt, or does it belong to an IME,
 * a menu, or a text field that is not a chat — lives in
 * `services/interruption.ts` and is tested there without a DOM. What this hook
 * owns is only the wiring: where the keystroke landed, and the listener's life.
 *
 * It is a hook rather than three copies of the same effect because the main
 * chat, an agent tab and a side chat are three chat surfaces with one rule
 * between them, and the last time interruption was written out by hand in
 * several places the copies drifted until Escape worked in none of them.
 *
 * `surface` is the root of *this* chat. A keystroke inside it is an interrupt
 * even from the composer's textarea — the composer is the one place the
 * operator actually presses Escape. Outside it, a text field keeps Escape:
 * the terminal's command line and a search box are not this conversation.
 *
 * The listener is on `window` and only while `active`, so an idle surface
 * costs nothing and a surface that is not streaming cannot swallow Escape
 * from one that is.
 */
export function useInterruptKey(
  active: boolean,
  surface: RefObject<HTMLElement | null>,
  stop: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const stroke = {
        key: event.key,
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
        inTextField: Boolean(target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)),
        inChat: Boolean(target && surface.current?.contains(target)),
      };
      if (!interruptsRun(stroke)) return;
      event.preventDefault();
      stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, surface, stop]);
}
