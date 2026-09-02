import React, { useEffect, useRef } from "react";
import type { UseAssistantResult } from "../../hooks/useAssistant";
import type { AssistantBridgeCommand } from "../layout/WindowControls";

/**
 * Keeps the desktop shell and the assistant session in step.
 *
 * Three one-way flows, and the direction of each one is the point:
 *
 *  - **Commands come in.** The global shortcut and the menu bar item can ask
 *    the assistant to start listening or to change a setting. They never hold
 *    the setting themselves — the renderer owns it, and two owners of one
 *    setting is two places that can disagree about what mode you are in.
 *  - **State goes out**, so the menu bar item can show what the renderer
 *    decided rather than what it last guessed.
 *  - **The drawing goes out**, one target at a time, in the global screen
 *    coordinates the accessibility API reported. The overlay window converts
 *    them to window coordinates; nothing here estimates anything.
 *
 * Renders nothing. In a browser build there is no bridge and every effect is a
 * no-op, which is exactly the right degradation: the in-window panel still
 * works, and the shortcut and menu bar item simply do not exist.
 */

const SETTING_KEYS = ["mode", "autonomy", "engine", "frontierMode", "speak", "overlay"] as const;

export const AssistantBridge: React.FC<{ assistant: UseAssistantResult }> = ({ assistant }) => {
  // Read through a ref so the command subscription survives every turn: it is
  // registered once, and re-registering it mid-sentence would drop a hotkey
  // press that arrived while the assistant was thinking.
  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;

  /* Commands in. */
  useEffect(() => {
    const bridge = window.teminali?.assistant;
    if (!bridge) return;
    return bridge.onCommand((command: AssistantBridgeCommand) => {
      const patch: Record<string, unknown> = {};
      for (const key of SETTING_KEYS) {
        if (command[key] !== undefined) patch[key] = command[key];
      }
      if (Object.keys(patch).length > 0) assistantRef.current.update(patch);
      if (command.activate) void assistantRef.current.beginListening();
    });
  }, []);

  /* Settings out. */
  const { settings, phase } = assistant;
  useEffect(() => {
    // Swallowed rather than awaited. `ipcRenderer.invoke` rejects when the main
    // process has no handler for the channel — which happens in a shell built
    // without the assistant, and in any harness that loads the page directly —
    // and an unhandled rejection on every settings change is noise that hides
    // the failures worth reading.
    window.teminali?.assistant?.setState({ ...settings, phase }).catch(() => {});
  }, [settings, phase]);

  /* The hotkey the operator chose. */
  useEffect(() => {
    window.teminali?.assistant?.setHotkey(settings.hotkey).catch(() => {});
  }, [settings.hotkey]);

  /* The drawing out. */
  const { target, turn, open } = assistant;
  useEffect(() => {
    const bridge = window.teminali?.assistant;
    if (!bridge) return;

    // Nothing to draw is not the same as an empty drawing. An always-on-top
    // window over the operator's whole screen for the length of a session,
    // showing nothing, is a window they will notice and cannot dismiss.
    const nothingToDraw = !target && !turn?.say;
    if (!settings.overlay || !open || nothingToDraw) {
      bridge.hideOverlay().catch(() => {});
      return;
    }

    const acting = phase === "acting";
    const index = turn?.outcomes.findIndex((outcome) => "element" in outcome.step && outcome.step.element === target?.id);
    bridge.showOverlay({
      visible: true,
      acting,
      // Spoken and drawn together: the caption is the sentence being read
      // aloud, so someone watching the screen and someone listening get the
      // same answer at the same moment.
      caption: turn?.say ?? "",
      target: target
        ? {
            frame: target.frame,
            label: target.label ?? target.role.replace(/^AX/, ""),
          }
        : null,
      step:
        turn && typeof index === "number" && index >= 0 && turn.outcomes.length > 1
          ? { index: index + 1, total: turn.outcomes.length }
          : null,
    }).catch(() => {});
  }, [open, phase, settings.overlay, target, turn]);

  /* Nothing left on screen when the session closes or the window unmounts. */
  useEffect(() => () => {
    window.teminali?.assistant?.hideOverlay().catch(() => {});
  }, []);

  return null;
};
