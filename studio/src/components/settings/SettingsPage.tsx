import React, { useState, useEffect } from "react";
import { VoiceSettingsPanel } from "../voice/VoiceSettingsPanel";
import { AssistantSettingsPanel, ASSISTANT_ROWS } from "../assistant/AssistantSettingsPanel";
import { useAssistantSession } from "../assistant/AssistantContext";
import { useVoice } from "../../hooks/useVoice";
import { ModelsPane, MODELS_ROWS } from "../models/ModelsPane";
import { AppearancePane, APPEARANCE_ROWS } from "./AppearancePane";
import { GeneralPane, GENERAL_ROWS } from "./GeneralPane";
import { LicencePane, LICENCE_ROWS } from "./LicencePane";
import { ProfilePane, PROFILE_ROWS } from "./ProfilePane";
import { GitPane, GIT_ROWS } from "./GitPane";
import { AgentsPane, AGENTS_ROWS } from "./AgentsPane";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CreditCard,
  FlaskConical,
  GitBranch,
  Layers,
  Mic,
  MousePointer2,
  Palette,
  Search,
  Settings,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { useStudioStore } from "../../store/studioStore";

/**
 * The width of the settings rail, in CSS pixels.
 *
 * A number rather than a Tailwind class because the title bar has to land its
 * own divider on exactly this edge while the page is open, and a class name is
 * not a value another file can read. Change it here and the bar follows.
 */
export const SETTINGS_RAIL_WIDTH = 240;

/**
 * A settings pane: a rail entry that renders something. `render` is not
 * optional, which is the whole point — the rail is built from this array, so
 * a category cannot be advertised without a screen behind it.
 */
interface SettingsPane {
  id: string;
  label: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
  /**
   * The rows this pane actually contains, for the rail's search. These are row
   * labels, not topics: if a row is renamed, rename it here in the same edit,
   * or the search will offer a row that is not on the screen.
   */
  rows?: string[];
}

/**
 * A rail entry. Either a pane, or an action that hands off to another modal
 * and closes settings — never a category that quietly renders the wrong pane.
 */
type SettingsRailItem =
  | { kind: "pane"; id: string; label: string; icon: LucideIcon; rows?: string[] }
  | { kind: "action"; id: string; label: string; icon: LucideIcon; run: () => void };

export const SettingsPage: React.FC = () => {
  const { settingsView, setSettingsCategory, closeSettings, setBenchmarkModalOpen, setSkillsModalOpen } =
    useStudioStore();
  const activeCategory = settingsView.category;
  const [searchQuery, setSearchQuery] = useState("");

  /* Escape leaves the page the way Back does. It is a page, so this is a
     navigation, not a dismissal: the shell puts the workspace back exactly
     as it was. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  /* The rail and the content pane are both derived from this one registry, so
     a category that renders nothing cannot exist: an entry has to carry a
     `render` to be in the array at all, and the rail maps over the same array.

     That is why the rail is shorter than it was. Seventeen categories were
     advertised and five rendered; Worktrees, Tab Autocomplete, AST Indexing
     and Cloud Agents had no backing code anywhere in `src/` or `server/`, and
     Docs pointed at a documentation site that does not exist. Profile,
     Appearance, Plan & Usage, Teminali OS and Browser silently fell through to
     this General screen. Each of those was a control for a capability we do
     not have, which is a lie in the interface; they come back one at a time as
     their pane is built (see `docs/SETTINGS_AND_CHROME_PLAN.md` §5). */
  const panes: SettingsPane[] = [
    {
      id: "general",
      label: "General",
      icon: Settings,
      rows: GENERAL_ROWS,
      render: () => <GeneralPane />,
    },
    {
      id: "profile",
      label: "Profile",
      icon: UserRound,
      rows: PROFILE_ROWS,
      render: () => <ProfilePane />,
    },
    {
      id: "licence",
      label: "Licence & Usage",
      icon: CreditCard,
      rows: LICENCE_ROWS,
      render: () => <LicencePane />,
    },
    {
      id: "appearance",
      label: "Appearance",
      icon: Palette,
      rows: APPEARANCE_ROWS,
      render: () => <AppearancePane />,
    },
    {
      id: "agents",
      label: "Agents",
      icon: Bot,
      rows: AGENTS_ROWS,
      render: () => <AgentsPane />,
    },
    {
      id: "models",
      label: "Local Models & Weights",
      icon: Layers,
      rows: MODELS_ROWS,
      render: () => <ModelsPane />,
    },
    {
      id: "git",
      label: "Git & PRs",
      icon: GitBranch,
      rows: GIT_ROWS,
      render: () => <GitPane />,
    },
    {
      id: "voice",
      label: "Voice & Conversation",
      icon: Mic,
      rows: [
        "Speech engine",
        "Language",
        "Only respond to my voice",
        "Require my name",
        "Read replies aloud",
        "Greet me when it starts",
        "Narrate progress",
        "Summarise long replies",
        "Remember what it overhears",
        "Let me interrupt",
        "Confirm before sending",
        "Auto-send after",
        "Pause before I'm finished",
        "Voice",
        "Speaking rate",
      ],
      render: () => (
        <div className="space-y-5">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-bright">
              <Mic size={16} className="text-accent" />
              Voice &amp; Conversation
            </h1>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
              Dictate a prompt, or hold a hands-free conversation. Everything you say is cleaned up and shown to you
              before it reaches the chat.
            </p>
          </div>
          <VoiceSection />
        </div>
      ),
    },
    {
      id: "assistant",
      label: "Screen Assistant",
      icon: MousePointer2,
      rows: ASSISTANT_ROWS,
      render: () => <AssistantSection />,
    },
  ];

  /* Rail order: every pane, then the two entries that hand off to another
     modal rather than rendering here. An action is a different kind of thing
     from a pane and is typed as one, so it can never be selected as content. */
  const railItems: SettingsRailItem[] = [
    ...panes.map((pane) => ({
      kind: "pane" as const,
      id: pane.id,
      label: pane.label,
      icon: pane.icon,
      rows: pane.rows,
    })),
    {
      kind: "action",
      id: "customize",
      label: "Skills & MCP",
      icon: SlidersHorizontal,
      run: () => {
        closeSettings();
        setSkillsModalOpen(true);
      },
    },
    {
      kind: "action",
      id: "beta",
      label: "Benchmark Qualification",
      icon: FlaskConical,
      run: () => {
        closeSettings();
        setBenchmarkModalOpen(true);
      },
    },
  ];

  const activePane = panes.find((pane) => pane.id === activeCategory) ?? panes[0];

  /* Search matches rows, not just category labels: typing "interrupt" has to
     find the row on the voice screen, because nobody searching settings knows
     which category the developers filed a switch under. A rail entry that
     matched on its own label lists no rows; one that matched on its contents
     lists the rows that did. */
  const query = searchQuery.trim().toLowerCase();
  const matches = railItems
    .map((item) => {
      const labelHit = item.label.toLowerCase().includes(query);
      const rowHits =
        item.kind === "pane" && query ? (item.rows ?? []).filter((row) => row.toLowerCase().includes(query)) : [];
      return { item, rows: labelHit ? [] : rowHits, hit: !query || labelHit || rowHits.length > 0 };
    })
    .filter((entry) => entry.hit);


  return (
    <div className="flex-1 min-h-0 flex bg-frame-mid text-ink-prose antialiased font-sans">
      {/* ── The rail ─────────────────────────────────────────────────────
          Back sits at the top of the rail rather than as a close button in a
          corner, because this is a page: leaving it returns you to the work
          you came from, and Escape does the same thing. */}
      <aside
        className="bg-frame-bot border-r border-edge-chrome flex flex-col justify-between p-3 flex-shrink-0"
        style={{ width: SETTINGS_RAIL_WIDTH }}
      >
        <div className="space-y-4 min-h-0 flex flex-col">
          <button
            type="button"
            onClick={closeSettings}
            className="flex items-center gap-2 px-2 py-1 rounded-lg text-ink-muted hover:text-ink-high hover:bg-surface-chip transition-colors duration-ds ease-ds"
          >
            <ArrowLeft size={14} />
            <span className="text-sm font-semibold tracking-tight">Settings</span>
          </button>

          <div className="relative px-1">
            <Search size={13} className="absolute left-3.5 top-2.5 text-ink-muted" />
            <input
              type="text"
              placeholder="Search settings…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="lit lit-inner w-full pl-8 pr-3 py-1.5 bg-surface-sunken rounded-lg text-xs text-ink-bright placeholder:text-ink-placeholder focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-0.5 min-h-0 flex-1 overflow-y-auto pr-1">
            {matches.map(({ item, rows }) => {
              const Icon = item.icon;
              const isSelected = item.kind === "pane" && activeCategory === item.id;
              return (
                <div key={item.id}>
                  <button
                    onClick={() => (item.kind === "pane" ? setSettingsCategory(item.id) : item.run())}
                    className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      isSelected
                        ? "bg-accent/12 text-accent border border-accent/25"
                        : "text-ink-muted hover:bg-surface-chip hover:text-ink-high"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 truncate">
                      <Icon size={14} className={isSelected ? "text-accent" : "text-ink-muted"} />
                      <span className="truncate">{item.label}</span>
                    </div>
                    {item.kind === "action" && (
                      <ArrowUpRight size={11} className="text-ink-placeholder flex-shrink-0" />
                    )}
                  </button>
                  {/* The rows that matched, so a search for "font" says which
                      screen the font controls are on rather than only that
                      Appearance matched something. */}
                  {rows.length > 0 && (
                    <div className="pl-9 pr-3 pb-1 space-y-0.5">
                      {rows.map((row) => (
                        <div key={row} className="truncate text-3xs text-ink-faint">
                          {row}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {matches.length === 0 && (
              <p className="px-3 py-2 text-2xs text-ink-faint">Nothing matches “{searchQuery}”.</p>
            )}
          </div>
        </div>

        <div className="pt-2 border-t border-edge-chrome flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="lit lit-inner w-6 h-6 rounded-full bg-surface text-ink-prose font-bold flex items-center justify-center text-2xs shadow-sm">
              T
            </div>
            <div className="flex flex-col">
              <span className="text-2xs font-semibold text-ink-bright leading-tight">Teminali Developer</span>
              <span className="text-3xs text-accent">Local Unified Flagship</span>
            </div>
          </div>
        </div>
      </aside>

      {/* One column, centred, capped — the page reflows with the window
          instead of sitting in a fixed 1040×680 box. */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-8 py-7 space-y-6">{activePane.render()}</div>
      </main>
    </div>
  );
};

/**
 * The screen assistant section of Settings.
 *
 * Unlike the voice section below it, this reads the shell's assistant rather
 * than mounting one of its own: there is exactly one assistant session in the
 * application, and a settings panel that edited a second copy would show the
 * operator switches that changed nothing.
 */
const AssistantSection: React.FC = () => {
  const assistant = useAssistantSession();
  if (!assistant) {
    return <p className="text-2xs text-ink-faint">The assistant is not available on this surface.</p>;
  }
  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-bright">
          <MousePointer2 size={16} className="text-accent" />
          Screen Assistant
        </h1>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
          Press the shortcut or the microphone, say what you need, and it looks at your screen. It reads the controls
          from macOS rather than guessing their positions from the picture, so what it points at is where the control
          actually is.
        </p>
      </div>
      <AssistantSettingsPanel assistant={assistant} />
    </div>
  );
};

/**
 * The voice section of Settings.
 *
 * It mounts its own engine rather than reaching into the chat's, because the
 * only things it needs are the probe result and enrolment capture — neither of
 * which depends on a conversation. The engine stops itself on unmount.
 */
const VoiceSection: React.FC = () => {
  const voice = useVoice({
    submit: () => {},
    lastAssistantText: () => "",
    isBusy: () => false,
  });

  return (
    <VoiceSettingsPanel
      settings={voice.settings}
      update={voice.update}
      capabilities={voice.providers?.capabilities ?? null}
      activeAsrTier={voice.providers?.asrTier ?? null}
      hasProfile={voice.hasProfile}
      captureClip={voice.captureEnrolmentClip}
      finishEnrolment={voice.finishEnrolment}
      clearEnrolment={voice.clearEnrolment}
      onProbe={() => void voice.probe()}
    />
  );
};
