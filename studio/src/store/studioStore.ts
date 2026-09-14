import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { applySessionSwitch, forkSession, rememberAgentSession, restampWorkspace, workspaceLabel } from "../utils/chatSessions";
import { settleRestoredTurns } from "../services/interruption";
import { ModelProfileId, ModelProfile, SpecialistSkill, EditorTab, FileItem, ChatMessage, ToolCall } from "../types";
import { purgeOllamaMemory } from "../services/aiService";
import { findTabByFileIdentity } from "./tabIdentity";
import { DEFAULT_EXPANDED_PATHS, expandForReveal, toggleExpansion } from "./treeExpansion";
import { applyAppearance, DEFAULT_APPEARANCE, type AppearanceSettings } from "../services/appearance";
import { applyPreferences, DEFAULT_PREFERENCES, type Preferences } from "../services/preferences";
import { announceTurn, latestSettledTurn } from "../services/notifications";

/**
 * The two halves of a chat switch, in the shape `set` wants them.
 *
 * `applySessionSwitch` holds the rule and `tests/chat-sessions.test.mjs` pins
 * it; this only adapts it to the store's field names, so the three places that
 * navigate between chats cannot drift apart.
 */
function swap(
  state: { chatSessions: ChatSession[]; activeSessionId: string; frontierMessages: ChatMessage[] },
  toId: string,
): { chatSessions: ChatSession[]; frontierMessages: ChatMessage[] } {
  const { sessions, messages } = applySessionSwitch(
    state.chatSessions,
    state.activeSessionId,
    toId,
    state.frontierMessages,
  );
  return { chatSessions: sessions, frontierMessages: messages };
}

export interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  timestamp: string;
  messages: ChatMessage[];
  /**
   * The agent CLI's own resumable thread for this chat, if one has been
   * started. Held here rather than in the component so it survives a remount,
   * a switch to another chat and back, and a restart of the app — the chat is
   * one continuous thread for the agent for as long as it is one for the
   * operator.
   */
  agentSessionId?: string | null;
  /**
   * Which engine that id belongs to — `claude` or `codex`. A Codex thread
   * cannot be resumed by Claude Code, and resuming the wrong one fails rather
   * than politely starting fresh, so the id is only offered back when this
   * matches the engine selected now. The *model* is deliberately not part of
   * it: switching model inside one CLI keeps the conversation. Before the id
   * was persisted a remount cleared it; now it outlives the mount, so the check
   * has to be written down.
   */
  agentSessionKey?: string | null;
  /**
   * Set on a chat made by forking another: its next turn resumes the parent's
   * thread with `--fork-session` (Codex: `exec fork`), so the answer opens a new
   * thread and the chat it was forked from keeps its own. Cleared by the turn
   * that reports the new id.
   */
  agentForkPending?: boolean;
}


export const PROFILES_LIST: ModelProfile[] = [
  {
    id: "flash",
    name: "Flash",
    provider: "ollama",
    modelName: "Flash · fast local execution",
    costLabel: "$0.00 local",
    badge: "Fast · lightweight · resource-safe",
    badgeColor: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    description: "Official lightweight, high-throughput dedicated single-model execution wrapper. Optimized for instant local edits, high-speed token streaming, and automatic VRAM memory release on Apple Silicon without multi-model routing overhead.",
  },
  {
    id: "auto",
    name: "Auto",
    provider: "hybrid",
    modelName: "Auto · adaptive local routing",
    costLabel: "$0.00 local",
    badge: "Flagship · official router wrapper",
    badgeColor: "bg-[#FF6C37]/15 text-[#FF6C37] border-[#FF6C37]/30",
    description: "Official flagship engineered wrapper. Dynamically orchestrates best-fit model execution, planning, and multi-file code tools.",
  },
  {
    id: "max",
    name: "Max",
    provider: "gemini",
    modelName: "Max · Google Gemini 3.8 Flash",
    costLabel: "Online (Included)",
    badge: "Gemini 3.8 Flash",
    badgeColor: "bg-purple-500/15 text-purple-300 border-purple-500/30",
    description: "Online flagship model powered by Google Gemini 3.8 Flash via Claude Code with Teminali OS built-in key.",
  },
];

/**
 * The one skill catalogue: IDE/code skills and video skills in a single list,
 * split into groups by `category` where they are shown.
 *
 * The Cut's own bundled skills (`teminaliCut/skills/*` — Beat Montage,
 * Tutorial) are deliberately NOT copied in here. They are recipes over tools
 * that this app does not have: the ported registry defines exactly three
 * (`describe_timeline`, `patch_clip`, `set_effect_param`), and a catalogue row
 * whose first tool call cannot resolve teaches the operator that rows in this
 * list might not work. They arrive when the tools do — see
 * `src/video/P3-import-gate.md`.
 */
export const SKILLS_LIST: SpecialistSkill[] = [
  {
    id: "website-builder",
    category: "code",
    name: "Website Builder",
    tagline: "Modern responsive web apps & design systems",
    icon: "Layout",
    description: "Information architecture, design tokens, responsive CSS, WCAG AA accessibility audits, and automated conversion optimizations.",
    starterPrompts: [
      "Build a modern SaaS landing page with dark glassmorphism",
      "Design a responsive dashboard with charts and data tables",
      "Refactor CSS variables into a unified design token system",
      "Run an accessibility and performance audit on current layout",
    ],
  },
  {
    id: "teminali-cut-copilot",
    category: "video",
    name: "Teminali Cut Video Copilot",
    tagline: "Timeline editing & audio beat sync via MCP",
    icon: "Film",
    description: "Direct control over Teminali Cut video timelines: detect beats, split clips, apply cinematic looks, reflow kinetic captions, and export video.",
    starterPrompts: [
      "Inspect what is currently on the Teminali Cut timeline",
      "Detect silence in audio track and cut out dead pauses",
      "Generate word-by-word kinetic highlight captions",
      "Apply a cinematic teal-and-orange grade across all clips",
    ],
  },
  {
    id: "tutorial-builder",
    category: "video",
    name: "Tutorial Builder",
    tagline: "Turns a raw take into a cut tutorial",
    icon: "Clapperboard",
    description: "The recorder's auto edit, as a skill. Builds the take waiting on the review screen onto the timeline: zooms on the moments the pointer track found, the camera full-frame while the operator is explaining, narration on its own track, the cursor drawn, ticks and whooshes. Runs through the cut server's build_recording tool — record first, then ask; it builds, it does not record.",
    starterPrompts: [
      "Build the take I just recorded as a tutorial",
      "Lay the recording down raw, with no zooms or camera moves",
      "Rebuild the take with the cursor hidden and no sound effects",
      "Build the take, then describe the timeline it produced",
    ],
  },
  {
    id: "qa-verifier",
    category: "code",
    name: "QA & Test Verifier",
    tagline: "Autonomous test runner & regression preventer",
    icon: "ShieldCheck",
    description: "Executes unit test suites, discovers edge cases, verifies zero-regression invariants, and generates reproducible test fixtures.",
    starterPrompts: [
      "Run all test suites and fix any failing unit tests",
      "Add edge-case tests for async error handling and timeouts",
      "Verify zero-regression invariants across modified files",
    ],
  },
  {
    id: "screenshot-to-code",
    category: "code",
    name: "Screenshot to Code (UI Cloner)",
    tagline: "Instant visual-to-code compiler & design reverse-engineer",
    icon: "Camera",
    description: "Drop any UI screenshot, Figma design mockup, or app frame to generate production React/Tailwind/HTML components, exact design tokens, CSS grids, and colorimetry.",
    starterPrompts: [
      "Convert attached screenshot to a responsive React + Tailwind component",
      "Extract exact color palette, typography, and spacing tokens from image",
      "Clone this landing page hero section with pixel-perfect CSS",
      "Audit visual layout deviations between current component and reference mockup",
    ],
  },
  {
    id: "visual-verification-tester",
    category: "code",
    name: "E2E Visual Verification Tester",
    tagline: "Autonomous screenshot & visual regression self-healer",
    icon: "ScanEye",
    description: "Runs continuous visual regression suites, checks computed style assertions against reference specs, and applies recursive CSS patches until fidelity reaches >=98.5%.",
    starterPrompts: [
      "Run full visual verification suite on active workspace",
      "Assert 6-column grid alignment and topbar height constraints",
      "Self-heal layout deviations and report final visual fidelity score",
    ],
  },
];

export type ScreenshotToCodeStack = "react-tailwind" | "html-css" | "nextjs" | "vue";

interface StudioState {
  currentProfile: ModelProfileId;
  setProfile: (profile: ModelProfileId) => void;
  /**
   * The agent CLI the composer is pointed at, when it is not pointed at a
   * Frontier lane. Selecting a Claude Code or Codex model here sends the main
   * conversation through that CLI instead of the local engine — `currentProfile`
   * still holds the Frontier lane so switching back restores the previous
   * choice rather than resetting it.
   */
  agentSelection: { engine: "claude" | "codex"; model: string | null; label: string } | null;
  setAgentSelection: (selection: { engine: "claude" | "codex"; model: string | null; label: string } | null) => void;
  /**
   * How much the selected agent CLI may do without asking, for turns sent from
   * the main composer. Null means the CLI's own safe default. The agent tabs
   * keep their own setting; this is the composer's.
   */
  agentPermission: string | null;
  setAgentPermission: (permission: string | null) => void;
  /**
   * How hard the selected agent CLI works before answering, and how much of
   * its reasoning comes back — the composer's copy of the two knobs its own
   * CLI already has. Null on both means "say nothing on the command line",
   * which leaves whatever the operator configured in `~/.claude` or
   * `~/.codex/config.toml` in force. That is the reason the default is null
   * and not "medium": a picker that quietly overrides a config file is worse
   * than one that offers nothing.
   */
  agentEffort: string | null;
  setAgentEffort: (effort: string | null) => void;
  agentThinking: string | null;
  setAgentThinking: (thinking: string | null) => void;
  /**
   * Text handed to the main composer by another surface.
   *
   * A one-way drop-box, not shared state: StudioChat takes it, puts it in the
   * field and clears it. That keeps the composer's own input local — sharing it
   * would make every keystroke a store write — while still letting a panel hand
   * something over for the operator to send, edit, or discard.
   */
  chatDraft: string | null;
  setChatDraft: (draft: string | null) => void;
  
  activeSkill: SpecialistSkill | null;
  setSkill: (skill: SpecialistSkill | null) => void;

  screenshotToCodeStack: ScreenshotToCodeStack;
  setScreenshotToCodeStack: (stack: ScreenshotToCodeStack) => void;
  referenceScreenshotUrl: string | null;
  setReferenceScreenshotUrl: (url: string | null) => void;
  
  budgetUsd: number;
  spentUsd: number;
  setBudget: (budget: number) => void;
  
  workspacePath: string;
  /**
   * Whether `workspacePath` is a root the gateway has confirmed, or still the
   * boot-time guess.
   *
   * The initial `workspacePath` is a hardcoded path, not knowledge: the real
   * root arrives with `/api/workspace/projects`, a fetch later. Most readers
   * can live with a guess for that moment, but anything that resolves a
   * workspace-relative path against the root cannot — under the wrong root the
   * same relative path is a different file, or no file at all. Deliberately
   * not persisted: a root is confirmed for a session, by that session.
   */
  workspaceRootConfirmed: boolean;
  /**
   * Points the shell at a root the gateway has already been rebound to.
   *
   * The only way to change workspace. There used to be a `setWorkspace` beside
   * it offering three hardcoded ids whose paths were one developer's own
   * folders — on anybody else's install it pointed the shell at three
   * directories that do not exist. The gateway, not this store, owns which
   * root the routes read, so the caller runs `WorkspaceService.openProject`
   * first and passes the path it confirms.
   */
  setWorkspacePath: (path: string) => void;
  files: FileItem[];
  setFiles: (files: FileItem[]) => void;

  /**
   * Which folders the file tree has open, by workspace-relative path.
   *
   * Held here rather than in each row so something other than a click can open
   * a folder — `revealPath` is what the agent's workspace `reveal` tool drives.
   * Deliberately not persisted: the tree it describes belongs to whichever
   * project is open, and a stale set from another root would open nothing.
   */
  expandedPaths: Set<string>;
  toggleExpanded: (path: string) => void;
  /** Open every folder on the way to `path` and scroll the tree to it. */
  revealPath: (path: string) => void;
  /**
   * Put a file in front of the operator: revealed and highlighted in the tree,
   * and open in the file panel, which is the surface that actually renders one
   * — including the images and PDFs an editor tab cannot show.
   *
   * `revealPath` only scrolls and `openFile` only records which file is
   * current, so neither alone is what someone means by "show me this file".
   * Drives the agent's `open_file` tool; a click in the tree still takes its
   * own road because it owns a spinner and an error line this cannot reach.
   */
  showFile: (path: string) => Promise<void>;
  /**
   * Put a *folder* in front of the operator, as a gallery of its contents —
   * and, when it holds videos, as a series. The tree is revealed and the
   * folder opened, exactly as `showFile` does for a file: the two are one
   * gesture from the outside, and `FileTree` and the agent's `open_file` reach
   * one or the other on the same rule.
   *
   * An empty path is the project root, which is a real destination.
   *
   * No read: the tree the sidebar already holds *is* the folder's contents, so
   * there is nothing to fetch and nothing that can fail.
   */
  showFolder: (path: string) => void;
  /** The row the tree should scroll to; timestamped so a repeat reveal re-fires. */
  revealTarget: { path: string; timestamp: number } | null;
  clearRevealTarget: () => void;
  
  tabs: EditorTab[];
  activeTabId: string | null;
  targetEditorScroll: { path: string; lineNumber: number; endLineNumber?: number; timestamp: number } | null;
  setTargetEditorScroll: (target: { path: string; lineNumber: number; endLineNumber?: number; timestamp: number } | null) => void;
  openFileAtSnippet: (filePath: string, snippetCode: string) => Promise<void>;
  openFile: (file: { path: string; name: string; content?: string; language?: string; encoding?: "utf8" | "base64"; mimeType?: string; size?: number; modified?: string }) => void;
  addUntitledTab: () => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  syncFileContent: (file: { path: string; content: string; modified?: string; size?: number; mimeType?: string }) => void;
  
  chatSessions: ChatSession[];
  activeSessionId: string;
  switchSession: (sessionId: string) => void;
  /**
   * Records — or clears — the agent CLI thread belonging to a chat.
   *
   * `key` is the engine that owns the id; passing a null id forgets the thread,
   * which is what switching engine does and what "Start fresh" does on purpose.
   */
  setAgentSession: (sessionId: string, agentSessionId: string | null, key: string | null) => void;
  /** Start a new conversation in the current workspace and switch to it. */
  newChatSession: () => void;
  /**
   * Fork the active chat: a second chat holding the same transcript and the
   * same agent thread, whose next turn branches off it rather than extending
   * it. The chat being forked is left exactly as it was.
   */
  forkChatSession: () => void;
  /**
   * Where you have been, so the title bar's arrows can take you back.
   *
   * A visit stack, not a list of sessions: it behaves like browser history, so
   * going back and then opening a different chat discards what was ahead rather
   * than leaving a forward path to a chat you did not come from.
   */
  sessionHistory: string[];
  sessionHistoryIndex: number;
  goBackSession: () => void;
  goForwardSession: () => void;
  frontierMessages: ChatMessage[];
  /**
   * Replaces the active chat's transcript.
   *
   * The voice stage owns the conversation on screen and needs to write it
   * somewhere the sidebar can read: `switchSession` swaps this array, so a
   * stage that renders it is a stage whose chat rows open. Takes an updater so
   * the stage's existing `setState(prev => ...)` call sites survive unchanged.
   */
  setFrontierMessages: (update: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[])) => void;
  antigravityMessages: ChatMessage[];
  claudeMessages: ChatMessage[];
  codexMessages: ChatMessage[];
  isStreaming: boolean;
  addMessageToEngine: (engine: "frontier" | "antigravity" | "claude" | "codex", message: Omit<ChatMessage, "id" | "timestamp">) => void;
  updateLastMessageInEngine: (engine: "frontier" | "antigravity" | "claude" | "codex", updater: (msg: ChatMessage) => Partial<ChatMessage>) => void;
  clearEngineSession: (engine: "frontier" | "antigravity" | "claude" | "codex") => void;
  setStreaming: (streaming: boolean) => void;
  
  isSplitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
  splitTab: "terminal" | "editor" | "browser";
  setSplitTab: (tab: "terminal" | "editor" | "browser") => void;
  browserPreviewUrl: string;
  setBrowserPreviewUrl: (url: string) => void;
  openBrowserPreview: (urlOrPath?: string) => void;
  /* The settings surface is a page, not a dialog: the shell renders it in
     place of the workspace, so which pane is open is shell state and belongs
     here rather than in an `App.tsx` `useState`. The category is persisted;
     `open` deliberately is not, because a reload should return you to your
     work, not to the screen you were configuring it from. */
  settingsView: { open: boolean; category: string };
  openSettings: (category?: string) => void;
  closeSettings: () => void;
  setSettingsCategory: (category: string) => void;
  /* How the shell looks. Persisted whole, and applied to the document by
     `services/appearance.ts` — the store holds the intent, that module makes
     it true, so the recorder window can read the same settings without the
     store. */
  appearance: AppearanceSettings;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  resetAppearance: () => void;
  /* What the shell *does*, as opposed to how it looks. Persisted whole and
     settled through `services/preferences.ts`, which publishes them for the
     callers that have no store to reach — the markdown renderer's link
     handler and the turn announcer both run outside React. */
  preferences: Preferences;
  setPreferences: (patch: Partial<Preferences>) => void;
  resetPreferences: () => void;
  isSkillsModalOpen: boolean;
  setSkillsModalOpen: (open: boolean) => void;
  isGeminiKeyModalOpen: boolean;
  setGeminiKeyModalOpen: (open: boolean) => void;
  /* How many provider keys have been saved since this window opened.
     A counter rather than a boolean, because the interesting event is "another
     one just landed" and that has to be distinguishable from the one before it.
     The voice stage builds its Gemini engine once, on mount, and a key pasted
     after that reaches the gateway immediately but reaches the renderer never:
     the lane stayed dead until the app was quit and reopened. This is the one
     signal the save sites can raise and the stage can watch. Not persisted:
     a reload rebuilds the engine anyway, so a count carried across one would
     only fire a retry nobody asked for. */
  providerKeySaves: number;
  noteProviderKeySaved: () => void;
  isDiffViewerOpen: boolean;
  isBenchmarkModalOpen: boolean;
  setBenchmarkModalOpen: (open: boolean) => void;
  setDiffViewerOpen: (open: boolean) => void;
  activeDiff: { file: string; oldCode: string; newCode: string } | null;
  setActiveDiff: (diff: { file: string; oldCode: string; newCode: string } | null) => void;
  purgeVRAM: () => Promise<void>;
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => ({
      currentProfile: "auto",
      // Choosing a Frontier lane is also how you leave an agent.
      setProfile: (profile) => set({ currentProfile: profile, agentSelection: null }),
      agentSelection: null,
      // Changing agent resets the permission, the effort and the thinking: the
      // two CLIs share no vocabulary in any of the three, so carrying
      // "acceptEdits" or "minimal" onto the other one would be meaningless —
      // and the server would drop it, leaving the menu showing a level that is
      // not in force.
      setAgentSelection: (agentSelection) =>
        set({ agentSelection, agentPermission: null, agentEffort: null, agentThinking: null }),
      agentPermission: null,
      setAgentPermission: (agentPermission) => set({ agentPermission }),
      agentEffort: null,
      setAgentEffort: (agentEffort) => set({ agentEffort }),
      agentThinking: null,
      setAgentThinking: (agentThinking) => set({ agentThinking }),
      chatDraft: null,
      setChatDraft: (chatDraft) => set({ chatDraft }),
      
      activeSkill: null,
      setSkill: (skill) => set({ activeSkill: skill }),

      screenshotToCodeStack: "react-tailwind",
      setScreenshotToCodeStack: (stack) => set({ screenshotToCodeStack: stack }),
      referenceScreenshotUrl: null,
      setReferenceScreenshotUrl: (url) => set({ referenceScreenshotUrl: url }),
      
      budgetUsd: 0.50,
      spentUsd: 0.02,
      setBudget: (budget) => set({ budgetUsd: budget }),
      purgeVRAM: purgeOllamaMemory,
      
      // Empty until the gateway says what it is bound to — which it does on
      // boot, through `setWorkspacePath`. A literal here would be one machine's
      // folder on everybody's install.
      workspacePath: "",
      workspaceRootConfirmed: false,

      setWorkspacePath: (workspacePath) => set((state) => ({
        workspacePath,
        // Every caller of this setter has the root from the gateway — a
        // projects response, an `openProject`, or an agent event. Reaching
        // here is what makes the root a fact rather than the boot guess.
        workspaceRootConfirmed: true,
        // A new root means a new tree: paths from the old one open nothing.
        expandedPaths: new Set<string>(DEFAULT_EXPANDED_PATHS),
        revealTarget: null,
        /*
          And the chat moves with it.

          Placed in the setter rather than at any one caller because six routes
          change the root — a sidebar repository row, the Projects panel, the
          composer's recent projects, global search, the native Open Folder
          menu, and the agent's own `open-project` — and all six funnel here.
          Fixing them one at a time is how five of them stay broken.
        */
        chatSessions: restampWorkspace(state.chatSessions, state.activeSessionId, workspacePath),
      })),

      files: [
        {
          id: "root-1",
          name: "src",
          path: "src",
          type: "directory",
          children: [
            { id: "f-1", name: "App.tsx", path: "src/App.tsx", type: "file" },
            { id: "f-2", name: "index.css", path: "src/index.css", type: "file" },
            { id: "f-3", name: "main.tsx", path: "src/main.tsx", type: "file" },
          ],
        },
        { id: "f-4", name: "package.json", path: "package.json", type: "file" },
        { id: "f-5", name: "README.md", path: "README.md", type: "file" },
        { id: "f-6", name: "vite.config.ts", path: "vite.config.ts", type: "file" },
        { id: "f-7", name: "OpenCode_Groq_Codex_Handover.md", path: "OpenCode_Groq_Codex_Handover.md", type: "file" },
      ],
      setFiles: (files) => set({ files }),

      expandedPaths: new Set<string>(DEFAULT_EXPANDED_PATHS),
      toggleExpanded: (path) => set((state) => ({ expandedPaths: toggleExpansion(state.expandedPaths, path) })),
      revealPath: (path) => set((state) => ({
        expandedPaths: expandForReveal(state.expandedPaths, path),
        revealTarget: { path, timestamp: Date.now() },
      })),
      revealTarget: null,
      clearRevealTarget: () => set({ revealTarget: null }),

      showFolder: (folderPath) => {
        const { revealPath, workspacePath } = get();
        if (folderPath) revealPath(folderPath);
        const name = folderPath.split("/").pop() || workspacePath.split("/").filter(Boolean).pop() || "Gallery";
        void import("./panelStore").then(({ usePanelStore }) => {
          usePanelStore.getState().focusOrOpen({ kind: "gallery", path: folderPath, label: name });
        });
      },

      showFile: async (filePath) => {
        const { revealPath, openFile } = get();
        revealPath(filePath);
        const name = filePath.split("/").pop() || filePath;

        /*
          The panel first, and unconditionally. It reads the path itself, so it
          shows the file whether or not the read below succeeds — and when the
          read fails it is the panel, not this action, that has somewhere to
          put the reason. Imported lazily for the reason `openBrowserPreview`
          gives: the two stores must not depend on each other at module load.
        */
        void import("./panelStore").then(({ usePanelStore }) => {
          usePanelStore.getState().focusOrOpen({ kind: "file", path: filePath, label: name });
        });

        /*
          Then the tab, which is what makes the tree row read as selected.
          Exactly what a click does — same route, same limits, base64 and all —
          so an agent-opened file and a clicked one are the same file. A failed
          read opens no tab at all: an empty one would claim the file is empty.
        */
        try {
          const { WorkspaceService } = await import("../services/workspaceService");
          const { languageForPath } = await import("../services/language");
          const file = await WorkspaceService.readFile(filePath);
          openFile({ ...file, language: languageForPath(file.name) });
        } catch {
          /* The panel is already showing, and it will show the error too. */
        }
      },
      
      /**
       * No seeded tabs.
       *
       * This used to boot with fourteen invented ones — "banner.tsx" holding a
       * crypto-marketing carousel, "Farmland Plot A", "Organic Honey Harvest" —
       * leftovers from an unrelated project. They were not inert: `FileTree`
       * highlights the active tab and `CopilotLiveEditController` acts on it,
       * so the app started up pointed at a file that does not exist.
       */
      tabs: [],
      activeTabId: null,
      
      openFile: ({ path: filePath, name, content, language, encoding, mimeType, size, modified }) => {
        const { tabs } = get();
        const existing = findTabByFileIdentity(tabs, filePath, name);
        if (existing) {
          set({
            activeTabId: existing.id,
            tabs: content !== undefined && !existing.isDirty
              ? tabs.map((tab) => tab.id === existing.id ? { ...tab, content, language: language || tab.language, encoding, mimeType, size, modified } : tab)
              : tabs,
          });
          return;
        }

        let detectedLang = language || "typescript";
        if (name.endsWith(".md")) detectedLang = "markdown";
        else if (name.endsWith(".json")) detectedLang = "json";
        else if (name.endsWith(".css")) detectedLang = "css";
        else if (name.endsWith(".html")) detectedLang = "html";

        // No fallback to a canned copy. A tab with no content yet is empty and
        // fills in when the real file is read; showing a hardcoded stand-in
        // means the editor can display text that is not what is on disk.
        const resolvedContent = content ?? "";

        const newTab: EditorTab = {
          id: `tab_${Date.now()}`,
          name,
          path: filePath,
          language: detectedLang,
          content: resolvedContent,
          isDirty: false,
          encoding,
          mimeType,
          size,
          modified,
        };
        set({ tabs: [...tabs, newTab], activeTabId: newTab.id });
      },

      addUntitledTab: () => {
        const { tabs } = get();
        const untitledCount = tabs.filter((tab) => tab.path.startsWith("untitled:")).length + 1;
        const id = `untitled_${Date.now()}`;
        const newTab: EditorTab = {
          id,
          name: `Untitled-${untitledCount}`,
          path: `untitled:${id}`,
          language: "plaintext",
          content: "",
          isDirty: true,
          encoding: "utf8",
          mimeType: "text/plain",
        };
        set({ tabs: [...tabs, newTab], activeTabId: id });
      },
      
      closeTab: (tabId) => {
        const { tabs, activeTabId } = get();
        const nextTabs = tabs.filter((t) => t.id !== tabId);
        let nextActive = activeTabId;
        if (activeTabId === tabId) {
          nextActive = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
        }
        set({ tabs: nextTabs, activeTabId: nextActive });
      },
      
      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      targetEditorScroll: null,
      setTargetEditorScroll: (target) => set({ targetEditorScroll: target }),
      openFileAtSnippet: async (filePath, snippetCode) => {
        const { tabs, openFile, setActiveTab, setSplitTab, setSplitOpen } = get();
        let existing = findTabByFileIdentity(tabs, filePath);
        let fileContent = existing?.content;
        let tabId = existing?.id;

        if (!existing) {
          try {
            const { WorkspaceService } = await import("../services/workspaceService");
            const loaded = await WorkspaceService.readFile(filePath);
            openFile(loaded);
            fileContent = loaded.content;
            const state = get();
            existing = findTabByFileIdentity(state.tabs, filePath);
            tabId = existing?.id;
          } catch {
            openFile({
              name: filePath.split("/").pop() || filePath,
              path: filePath,
              content: snippetCode,
              language: filePath.endsWith(".tsx") || filePath.endsWith(".ts") ? "typescript" : filePath.endsWith(".css") ? "css" : filePath.endsWith(".html") ? "html" : "javascript"
            });
            fileContent = snippetCode;
            const state = get();
            existing = findTabByFileIdentity(state.tabs, filePath);
            tabId = existing?.id;
          }
        }

        if (tabId) {
          setActiveTab(tabId);
        }
        setSplitTab("editor");
        setSplitOpen(true);

        let targetLine = 1;
        let targetEndLine = 1;

        if (fileContent && snippetCode) {
          const cleanSnippet = snippetCode.trim();
          const snippetLines = cleanSnippet.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
          const fileLines = fileContent.split("\n");

          if (snippetLines.length > 0) {
            const firstLine = snippetLines[0];
            for (let i = 0; i < fileLines.length; i++) {
              if (fileLines[i].includes(firstLine)) {
                targetLine = i + 1;
                targetEndLine = Math.min(fileLines.length, targetLine + snippetLines.length - 1);
                break;
              }
            }
          }
        }

        set({
          targetEditorScroll: {
            path: existing?.path || filePath,
            lineNumber: targetLine,
            endLineNumber: targetEndLine,
            timestamp: Date.now(),
          },
        });
      },

      
      updateTabContent: (tabId, content) => {
        const { tabs } = get();
        set({
          tabs: tabs.map((t) => (t.id === tabId ? { ...t, content, isDirty: true } : t)),
        });
      },

      syncFileContent: ({ path, content, modified, size, mimeType }) => {
        const { tabs } = get();
        set({
          tabs: tabs.map((tab) => tab.path === path && !tab.isDirty
            ? { ...tab, content, modified, size, mimeType: mimeType || tab.mimeType, isDirty: false }
            : tab),
        });
      },
      
      /*
        One real conversation, not three invented ones.

        This used to boot with "Project analysis & Landing page", "Coffee shop
        website build" and "General architecture & UI exploration" — titles of
        work nobody in this app had done, each with an empty `messages` array.
        They were the same fiction the fourteen seeded editor tabs were, and
        they were worse than decorative: clicking one moved the highlight and
        left the transcript alone, so the sidebar taught the operator that its
        rows do nothing. `newChatSession` is how the list grows now.
      */
      chatSessions: [
        {
          id: "session-1",
          title: "New chat",
          workspace: "No Repo",
          timestamp: new Date().toISOString(),
          messages: [],
        },
      ],
      activeSessionId: "session-1",
      sessionHistory: [],
      sessionHistoryIndex: -1,

      setAgentSession: (sessionId, agentSessionId, key) => {
        set((state) => ({
          chatSessions: rememberAgentSession(state.chatSessions, sessionId, agentSessionId, key),
        }));
      },

      switchSession: (sessionId) => {
        const state = get();
        // Re-opening the chat you are already on is not a navigation, and
        // pushing it would stack duplicate entries the arrows have to walk.
        if (state.activeSessionId === sessionId) return;

        // The session the app booted into was never navigated *to*, so it is
        // not in the stack yet. Seeding it here is what makes the very first
        // navigation something you can come back from — without this, Back is
        // still disabled after your first chat switch.
        const seeded =
          state.sessionHistory.length === 0 && state.activeSessionId
            ? [state.activeSessionId]
            : state.sessionHistory;

        const truncated = seeded.slice(0, state.sessionHistory.length === 0 ? seeded.length : state.sessionHistoryIndex + 1);
        const history = [...truncated, sessionId].slice(-50);

        set({
          activeSessionId: sessionId,
          sessionHistory: history,
          sessionHistoryIndex: history.length - 1,
          /*
            Both halves, and the second one unconditionally.

            This used to load the incoming session's messages only when it had
            some — so switching to a chat you had not written in yet left the
            previous conversation on screen, and the only thing that changed
            was which row was highlighted. Reported as clicking a chat and
            nothing happening, which is exactly what it looked like. An empty
            session is a real answer: it is a conversation you have not started.

            And nothing wrote the outgoing conversation back, so a switch away
            discarded it. Saving on the way out is what makes these rows a
            history rather than three labels over one transcript.
          */
          ...swap(state, sessionId),
        });
      },

      /**
       * A new conversation, in the repository the operator is standing in.
       *
       * The sidebar groups chats by `workspace`, so a new one has to be
       * stamped with the current root's folder name or it lands under
       * "No Repo" — the group for chats whose repository is gone.
       */
      newChatSession: () => {
        const state = get();
        const workspace = workspaceLabel(state.workspacePath);
        const session: ChatSession = {
          id: `session-${Date.now().toString(36)}`,
          title: "New chat",
          workspace,
          timestamp: new Date().toISOString(),
          messages: [],
        };
        set({
          chatSessions: [
            session,
            // The one being left keeps what was said in it.
            ...state.chatSessions.map((entry) =>
              entry.id === state.activeSessionId ? { ...entry, messages: state.frontierMessages } : entry,
            ),
          ],
          activeSessionId: session.id,
          frontierMessages: [],
        });
      },

      /**
       * The same conversation, twice, from here on.
       *
       * Both CLIs can branch a thread — `claude --resume <id> --fork-session`
       * and `codex exec fork <id>` — and both write the answer to a new id
       * without touching the one they read. Doing that in place would be
       * invisible: the operator would press Fork, send a turn, and see nothing
       * change. So the fork is a chat, and the sidebar shows both.
       */
      forkChatSession: () => {
        const state = get();
        const source = state.chatSessions.find((entry) => entry.id === state.activeSessionId);
        if (!source) return;
        /*
          Forked from the live transcript, not the stored one.

          The active chat's messages live in `frontierMessages` until a switch
          writes them back (§6.40), so `source.messages` is the conversation as
          it stood when this chat was last left — everything said since would be
          missing from the copy, which is the one thing a fork must not do.
        */
        const fork: ChatSession = {
          ...forkSession(source, `session-${Date.now().toString(36)}`, state.frontierMessages),
          title: `${source.title} (fork)`,
          timestamp: new Date().toISOString(),
        };
        set({
          chatSessions: [
            fork,
            ...state.chatSessions.map((entry) =>
              entry.id === state.activeSessionId ? { ...entry, messages: state.frontierMessages } : entry,
            ),
          ],
          activeSessionId: fork.id,
          // Already what is on screen; assigned rather than left alone so this
          // reads as the switch it is instead of relying on the two matching.
          frontierMessages: fork.messages,
        });
      },

      /** Moves through the visit stack without pushing onto it. */
      goBackSession: () => {
        const state = get();
        const target = state.sessionHistoryIndex - 1;
        const sessionId = state.sessionHistory[target];
        if (target < 0 || !sessionId) return;
        set({
          activeSessionId: sessionId,
          sessionHistoryIndex: target,
          // Same rule as `switchSession`: save the one being left, load the
          // one being entered even when it is empty.
          ...swap(state, sessionId),
        });
      },

      goForwardSession: () => {
        const state = get();
        const target = state.sessionHistoryIndex + 1;
        const sessionId = state.sessionHistory[target];
        if (!sessionId) return;
        set({
          activeSessionId: sessionId,
          sessionHistoryIndex: target,
          // Same rule as `switchSession`: save the one being left, load the
          // one being entered even when it is empty.
          ...swap(state, sessionId),
        });
      },
      frontierMessages: [
        {
          id: "front-1",
          role: "assistant",
          content: "**Frontier Auto** is ready — the flagship wrapper that routes to best-fit local and specialized engines.",
          timestamp: "Just now",
          costUsd: 0.0000,
          costLabel: "$0.0000",
        },
      ],
      antigravityMessages: [
        {
          id: "ag-1",
          role: "assistant",
          content: "🌌 **Google Antigravity (Gemini 3.7 Pro)**: DeepMind planning loop active with subagent orchestration.",
          timestamp: "Just now",
          costUsd: 0.0000,
          costLabel: "$0.0000",
        },
      ],
      claudeMessages: [
        {
          id: "cl-1",
          role: "assistant",
          content: "🏛️ **Claude Code (Direct)**: Connected directly to Anthropic cloud session. (Subject to Anthropic weekly usage limits).",
          timestamp: "Just now",
          costUsd: 0.0000,
          costLabel: "$0.0000",
        },
      ],
      codexMessages: [
        {
          id: "cdx-1",
          role: "assistant",
          content: "🧠 **OpenAI Codex**: Connected to OpenAI API stream. Ready for precision code diffs.",
          timestamp: "Just now",
          costUsd: 0.0000,
          costLabel: "$0.0000",
        },
      ],
      isStreaming: false,
      
      setFrontierMessages: (update) => {
        set((state) => ({
          frontierMessages: typeof update === "function" ? update(state.frontierMessages) : update,
        }));
      },

      addMessageToEngine: (engine, msg) => {
        const newMsg: ChatMessage = {
          ...msg,
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        set((state) => {
          if (engine === "frontier") return { frontierMessages: [...state.frontierMessages, newMsg] };
          if (engine === "antigravity") return { antigravityMessages: [...state.antigravityMessages, newMsg] };
          if (engine === "claude") return { claudeMessages: [...state.claudeMessages, newMsg] };
          return { codexMessages: [...state.codexMessages, newMsg] };
        });
      },
      
      updateLastMessageInEngine: (engine, updater) => {
        set((state) => {
          const key = engine === "frontier" ? "frontierMessages" : engine === "antigravity" ? "antigravityMessages" : engine === "claude" ? "claudeMessages" : "codexMessages";
          const targetList = state[key];
          if (targetList.length === 0) return state;
          const copy = [...targetList];
          const lastIndex = copy.length - 1;
          const updatedFields = updater(copy[lastIndex]);
          copy[lastIndex] = { ...copy[lastIndex], ...updatedFields };
          return { [key]: copy } as any;
        });
      },

      /**
       * Starts a new chat: empty, for any engine.
       *
       * It used to seed a canned greeting per engine, which made the empty
       * state unreachable and put words in the model's mouth that nobody had
       * asked it for. Only "frontier" was ever passed; the other three branches
       * had been unreachable for as long as they existed.
       */
      clearEngineSession: (engine) => {
        set(
          engine === "antigravity"
            ? { antigravityMessages: [] }
            : engine === "claude"
              ? { claudeMessages: [] }
              : engine === "codex"
                ? { codexMessages: [] }
                : { frontierMessages: [] },
        );
      },

      /* The falling edge is the end of a turn, and the only place in the app
         that knows it without being told. Announcing here rather than at the
         eleven `setStreaming(false)` call sites keeps the streaming path — the
         most load-bearing path we have — free of edits made for a settings
         row; `services/notifications.ts` explains the trade in full. */
      setStreaming: (isStreaming) => {
        const wasStreaming = get().isStreaming;
        set({ isStreaming });
        if (wasStreaming && !isStreaming) {
          const state = get();
          announceTurn(
            latestSettledTurn([
              state.frontierMessages,
              state.antigravityMessages,
              state.claudeMessages,
              state.codexMessages,
            ]),
          );
        }
      },

      isSplitOpen: false,
      setSplitOpen: (open) => set({ isSplitOpen: open }),
      splitTab: "browser",
      setSplitTab: (tab) => set({ splitTab: tab }),
      browserPreviewUrl: "/preview/frontier-hypercar.html",
      setBrowserPreviewUrl: (url) => set({ browserPreviewUrl: url }),
      openBrowserPreview: (urlOrPath) => {
        const state = get();
        let target = urlOrPath;
        if (!target && state.activeTabId) {
          const tab = state.tabs.find((t) => t.id === state.activeTabId);
          if (tab && (tab.name.endsWith(".html") || tab.name.endsWith(".htm"))) {
            target = tab.path;
          }
        }
        if (!target) {
          const htmlTab = state.tabs.find((t) => t.name.endsWith(".html") || t.name.endsWith(".htm"));
          if (htmlTab) target = htmlTab.path;
          else target = "demo-website/index.html";
        }

        // Transform local file paths or workspace-relative paths into gateway HTTP preview URLs
        let previewUrl = target;
        if (!/^https?:\/\//i.test(target)) {
          let rel = target;
          const ws = state.workspacePath || "";
          if (ws && rel.startsWith(ws)) {
            rel = rel.slice(ws.length);
          }
          rel = rel.replace(/^\/+/, "");
          previewUrl = `http://127.0.0.1:4310/api/workspace/preview/${rel}`;
        }

        set({
          // Legacy split flags, kept for anything still reading them.
          isSplitOpen: true,
          splitTab: "browser",
          browserPreviewUrl: previewUrl,
        });

        // The redesigned shell renders panels, not the old single split slot,
        // so an artifact preview opens a browser panel and navigates its view.
        void import("../services/browserNavigation").then(({ openBrowserAt }) => {
          openBrowserAt(previewUrl);
        });
      },
      
      settingsView: { open: false, category: "general" },
      openSettings: (category) =>
        set((state) => ({
          settingsView: { open: true, category: category ?? state.settingsView.category },
        })),
      closeSettings: () => set((state) => ({ settingsView: { ...state.settingsView, open: false } })),
      setSettingsCategory: (category) =>
        set((state) => ({ settingsView: { ...state.settingsView, category } })),

      appearance: DEFAULT_APPEARANCE,
      setAppearance: (patch) =>
        set((state) => ({ appearance: applyAppearance({ ...state.appearance, ...patch }) })),
      resetAppearance: () => set({ appearance: applyAppearance(DEFAULT_APPEARANCE) }),

      preferences: DEFAULT_PREFERENCES,
      setPreferences: (patch) =>
        set((state) => ({ preferences: applyPreferences({ ...state.preferences, ...patch }) })),
      resetPreferences: () => set({ preferences: applyPreferences(DEFAULT_PREFERENCES) }),

      isSkillsModalOpen: false,
      setSkillsModalOpen: (open: boolean) => void set({ isSkillsModalOpen: open }),
      isGeminiKeyModalOpen: false,
      setGeminiKeyModalOpen: (open) => set({ isGeminiKeyModalOpen: open }),

      providerKeySaves: 0,
      noteProviderKeySaved: () => set((state) => ({ providerKeySaves: state.providerKeySaves + 1 })),
      
      isDiffViewerOpen: false,
      isBenchmarkModalOpen: false,
      setBenchmarkModalOpen: (open) => set({ isBenchmarkModalOpen: open }),
      setDiffViewerOpen: (open) => set({ isDiffViewerOpen: open }),
      
      activeDiff: null,
      setActiveDiff: (diff) => set({ activeDiff: diff, isDiffViewerOpen: !!diff }),
    }),
    {
      name: "teminali-studio-sessions-cache-v3",
      storage: createJSONStorage(() => localStorage),
      /*
        A turn that was live when the app stopped is not live now.

        `isStreaming` rides along with the message, so a restart brings back a
        spinner saying "Working", a frozen clock, and a stop button pointing at
        a run that died with the process. A restart is an interruption; it is
        recorded as one here, on the way out of storage, because there is no
        moment at which the restored state was true. Every engine's list and
        every stored session, since switching to an old one would find the same
        thing waiting. See services/interruption.ts.
      */
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.frontierMessages = settleRestoredTurns(state.frontierMessages) ?? [];
        state.antigravityMessages = settleRestoredTurns(state.antigravityMessages) ?? [];
        state.claudeMessages = settleRestoredTurns(state.claudeMessages) ?? [];
        state.codexMessages = settleRestoredTurns(state.codexMessages) ?? [];
        state.chatSessions = (state.chatSessions ?? []).map((session) => {
          const messages = settleRestoredTurns(session.messages) ?? [];
          return messages === session.messages ? session : { ...session, messages };
        });
        // Nothing is running in this process yet, whatever the last one was doing.
        state.isStreaming = false;
        /* Appearance is the one persisted slice that has to reach the DOM, not
           just the store: a restored accent or type size that nothing applies
           is a setting the operator can see checked and cannot see working.
           `applyAppearance` also normalises a slice persisted by an older
           build that is missing keys this one has. */
        state.appearance = applyAppearance(state.appearance);
        /* Same contract for the preferences, and for the same reason: a
           restored preference nothing has settled is one `currentPreferences()`
           cannot see, so every non-React caller would quietly run on defaults. */
        state.preferences = applyPreferences(state.preferences);
        /* Start clean if that is what was asked for. Editor tabs and the tab
           you were on are layout, so they go; chat transcripts are documents
           and stay, because a layout preference that silently deletes work is
           not a layout preference. */
        if (!state.preferences.restoreSession) {
          state.tabs = [];
          state.activeTabId = null;
        }
      },
      partialize: (state) => ({
        chatSessions: state.chatSessions,
        activeSessionId: state.activeSessionId,
        frontierMessages: state.frontierMessages,
        antigravityMessages: state.antigravityMessages,
        claudeMessages: state.claudeMessages,
        codexMessages: state.codexMessages,
        budgetUsd: state.budgetUsd,
        spentUsd: state.spentUsd,
        currentProfile: state.currentProfile,
        agentSelection: state.agentSelection,
        agentPermission: state.agentPermission,
        agentEffort: state.agentEffort,
        agentThinking: state.agentThinking,
        settingsView: { open: false, category: state.settingsView.category },
        appearance: state.appearance,
        preferences: state.preferences,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
    }
  )
);
