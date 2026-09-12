/**
 * The two header popovers on the voice stage.
 *
 * They exist because the stage is now the only surface: there is no second
 * chat screen to hold the things a conversation needs — starting a fresh one,
 * reaching the workspace, choosing the voice. Rather than grow a sidebar back,
 * each lives behind one of the two header icons and is closed by default.
 *
 * `TemiChatMenu` is the reference screen's "In this chat" menu. Its Library
 * item opens in place instead of pushing a submenu off the edge: the same
 * panel, one level deep, with a way back.
 */

import React, { useState } from "react";
import { Check, ChevronLeft, FileCode, Library, Plug, Plus } from "lucide-react";

import { useStudioStore } from "../../store/studioStore";
import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import type { EditorTab } from "../../types";

const PANEL =
  "absolute right-0 top-full z-50 mt-2 w-[264px] overflow-hidden rounded-2xl border border-[#3a3a3a] bg-[#2f2f2f] py-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.65)]";

const ITEM =
  "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-[#ececec] transition-colors hover:bg-[#3f3f3f]";

const SECTION = "px-3.5 pb-1 pt-2.5 text-[12px] font-normal text-[#9b9b9b]";

export interface TemiChatMenuProps {
  onClose: () => void;
  /** Clear the conversation and the live session's history, and start over. */
  onCreateNew: () => void;
  onOpenWorkspace?: () => void;
  onConnectGitHub?: () => void;
}

export const TemiChatMenu: React.FC<TemiChatMenuProps> = ({
  onClose,
  onCreateNew,
  onOpenWorkspace,
  onConnectGitHub,
}) => {
  const [view, setView] = useState<"root" | "library">("root");
  const tabs = useStudioStore((state) => state.tabs);
  const activeTabId = useStudioStore((state) => state.activeTabId);
  const setActiveTab = useStudioStore((state) => state.setActiveTab);

  if (view === "library") {
    return (
      <div role="menu" className={PANEL}>
        <button type="button" onClick={() => setView("root")} className={`${ITEM} text-[#9b9b9b]`}>
          <ChevronLeft size={16} />
          <span>Library</span>
        </button>
        <div className="max-h-[280px] overflow-y-auto px-1.5 pb-1">
          {tabs.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-[#8f8f8f]">No open workspace files</p>
          ) : (
            tabs.map((tab: EditorTab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setActiveTab(tab.id);
                  onOpenWorkspace?.();
                  onClose();
                }}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[#3f3f3f]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileCode size={14} className="flex-shrink-0 text-emerald-400" />
                  <span className="truncate font-mono text-[12px] text-[#ececec]">{tab.name}</span>
                </span>
                {tab.id === activeTabId && <Check size={13} className="flex-shrink-0 text-emerald-400" />}
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div role="menu" className={PANEL}>
      <p className={SECTION}>In this chat</p>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCreateNew();
          onClose();
        }}
        className={ITEM}
      >
        <Plus size={17} className="text-[#c9c9c9]" />
        <span>Create new</span>
      </button>
      <button type="button" role="menuitem" onClick={() => setView("library")} className={ITEM}>
        <Library size={17} className="text-[#c9c9c9]" />
        <span>Open from Library</span>
      </button>

      <p className={SECTION}>Sources</p>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onConnectGitHub?.();
          onClose();
        }}
        className={ITEM}
      >
        <Plug size={17} className="text-[#c9c9c9]" />
        <span>Connect plugins</span>
      </button>
    </div>
  );
};

/*
   Gemini Live's prebuilt voices, named as Gemini names them: the key is sent
   verbatim as `prebuiltVoiceConfig.voiceName`, so these are not labels we are
   free to invent. They replace the four Kokoro blends the Python lane mixed
   ("Royal Velvet" and friends), which no longer exist anywhere.

   The descriptions are speaking rate, because that is the one thing that was
   actually measured -- auditions read the same passage, 2026-09-12 -- and
   because pace is what an operator notices first. A conversational norm is
   140-160 wpm, which is why Sulafat is the default. Nothing here claims a
   timbre; that was not measured and would be invention.
*/
const VOICE_OPTIONS = [
  { key: "Sulafat", name: "Sulafat", desc: "Even conversational pace — 153 wpm" },
  { key: "Gacrux", name: "Gacrux", desc: "Measured and deliberate — 129 wpm" },
  { key: "Aoede", name: "Aoede", desc: "Slower, unhurried — 115 wpm" },
  { key: "Callirrhoe", name: "Callirrhoe", desc: "Quick and bright — 208 wpm" },
];

export interface TemiStageSettingsProps {
  onClose: () => void;
  onSelectVoice: (voiceKey: string) => void;
  machineLabel: string;
}

export const TemiStageSettings: React.FC<TemiStageSettingsProps> = ({
  onClose,
  onSelectVoice,
  machineLabel,
}) => {
  const selectedVoice = useAssistantActivityStore((state) => state.selectedVoice);
  const setSelectedVoice = useAssistantActivityStore((state) => state.setSelectedVoice);

  /* No round trip to ask which voice is speaking. The Python pipeline held
     that as server state and served it from `/api/voices`; Gemini Live takes
     the voice as session config and has nothing to ask. The store is now the
     only record, and it is the durable one -- the engine reads it when it
     opens a session, and changing it reopens one. */

  return (
    <div role="menu" className={PANEL}>
      <p className={SECTION}>Voice</p>
      <div className="px-1.5 pb-1">
        {VOICE_OPTIONS.map((voice) => (
          <button
            key={voice.key}
            type="button"
            role="menuitemradio"
            aria-checked={selectedVoice === voice.key}
            onClick={() => {
              setSelectedVoice(voice.key);
              onSelectVoice(voice.key);
              onClose();
            }}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[#3f3f3f]"
          >
            <span className="min-w-0">
              <span className="block truncate text-[13px] text-[#ececec]">{voice.name}</span>
              <span className="block truncate text-[11px] text-[#8f8f8f]">{voice.desc}</span>
            </span>
            {selectedVoice === voice.key && <Check size={14} className="flex-shrink-0 text-emerald-400" />}
          </button>
        ))}
      </div>
      <div className="mt-1 border-t border-[#3f3f3f] px-3.5 py-2 text-[11px] text-[#8f8f8f]">
        Turns run on {machineLabel}
      </div>
    </div>
  );
};
