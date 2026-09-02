import React, { createContext, useContext } from "react";
import type { UseAssistantResult } from "../../hooks/useAssistant";

/**
 * The one assistant, reachable from any composer.
 *
 * There are four composers in this application — the empty state, the follow-up
 * bar, the side chat and each agent pane — and every one of them has a
 * microphone. Threading the session down to all four as a prop would have meant
 * the panes that sit deepest quietly got a different microphone from the one
 * the global shortcut opens, which is the exact failure the single-session rule
 * exists to prevent. A context makes "there is one assistant" structural rather
 * than something each new surface has to remember.
 *
 * `null` is a legitimate value: a composer rendered outside the shell has no
 * assistant, and its microphone falls back to dictating into its own field.
 * That is a different thing from a second assistant, and the fallback is
 * deliberately the least surprising one available.
 */
const AssistantContext = createContext<UseAssistantResult | null>(null);

export const AssistantProvider: React.FC<{
  assistant: UseAssistantResult;
  children: React.ReactNode;
}> = ({ assistant, children }) => (
  <AssistantContext.Provider value={assistant}>{children}</AssistantContext.Provider>
);

export function useAssistantSession(): UseAssistantResult | null {
  return useContext(AssistantContext);
}
