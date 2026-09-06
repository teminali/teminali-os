import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ModelProfileId, ModelProfile, SpecialistSkill, EditorTab, FileItem, ChatMessage, ToolCall } from "../types";
import { purgeOllamaMemory } from "../services/aiService";
import { findTabByFileIdentity } from "./tabIdentity";
import { DEFAULT_EXPANDED_PATHS, expandForReveal, toggleExpansion } from "./treeExpansion";

export interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  timestamp: string;
  messages: ChatMessage[];
}


export const PROFILES_LIST: ModelProfile[] = [
  {
    id: "flash",
    name: "Frontier Flash",
    provider: "ollama",
    modelName: "Frontier Flash · fast local execution",
    costLabel: "$0.00 local",
    badge: "Fast · lightweight · resource-safe",
    badgeColor: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    description: "Official lightweight, high-throughput dedicated single-model execution wrapper. Optimized for instant local edits, high-speed token streaming, and automatic VRAM memory release on Apple Silicon without multi-model routing overhead.",
  },
  {
    id: "auto",
    name: "Frontier Auto",
    provider: "hybrid",
    modelName: "Frontier Auto · adaptive local routing",
    costLabel: "$0.00 local",
    badge: "Flagship · official router wrapper",
    badgeColor: "bg-[#FF6C37]/15 text-[#FF6C37] border-[#FF6C37]/30",
    description: "Official flagship engineered wrapper. Dynamically orchestrates best-fit model execution, planning, and multi-file code tools.",
  },
  {
    id: "max",
    name: "Teminali Max",
    provider: "ollama",
    modelName: "Teminali Max · qualification pending",
    costLabel: "$0.00 local",
    badge: "Locked until safety qualification",
    badgeColor: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    description: "Uses the heavyweight local model for every request. It stays locked until its exact artifact and product path pass safety canaries.",
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
  activeWorkspaceId: "teminali" | "teminali-code-tests" | "argus-vpn";
  setWorkspace: (ws: "teminali" | "teminali-code-tests" | "argus-vpn") => void;
  /**
   * Points the shell at a root the gateway has already been rebound to.
   *
   * `setWorkspace` above only knows three hardcoded ids, which cannot serve
   * a recent list read off disk. This one takes the path and nothing else;
   * the caller is responsible for `WorkspaceService.openProject` first, as
   * the gateway — not this store — owns which root the routes read.
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
  isSkillsModalOpen: boolean;
  setSkillsModalOpen: (open: boolean) => void;
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
      // Changing agent resets the permission: the two CLIs do not share a
      // vocabulary, so carrying "acceptEdits" onto Codex would be meaningless.
      setAgentSelection: (agentSelection) => set({ agentSelection, agentPermission: null }),
      agentPermission: null,
      setAgentPermission: (agentPermission) => set({ agentPermission }),
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
      
      activeWorkspaceId: "teminali",
      workspacePath: "/Users/teminali/Documents/my_projects/teminali/teminaliCode",
      workspaceRootConfirmed: false,
      // Switching workspace moves the root, and nothing else. It used to also
      // select that workspace's canned demo tab; those tabs are gone, so a
      // per-workspace activeTabId would only ever name a tab that does not
      // exist. Open tabs survive the switch, so the selection does too.
      setWorkspace: (ws) => {
        if (ws === "teminali-code-tests") {
          set({
            activeWorkspaceId: "teminali-code-tests",
            workspacePath: "/Users/teminali/Downloads/frontier code tests",
          });
        } else if (ws === "argus-vpn") {
          set({
            activeWorkspaceId: "argus-vpn",
            workspacePath: "/Users/teminali/Documents/my_projects/argus-vpn-landing",
          });
        } else {
          set({
            activeWorkspaceId: "teminali",
            workspacePath: "/Users/teminali/Documents/my_projects/teminali/teminaliCode",
          });
        }
      },

      setWorkspacePath: (workspacePath) => set({
        workspacePath,
        // Every caller of this setter has the root from the gateway — a
        // projects response, an `openProject`, or an agent event. Reaching
        // here is what makes the root a fact rather than the boot guess.
        workspaceRootConfirmed: true,
        // A new root means a new tree: paths from the old one open nothing.
        expandedPaths: new Set<string>(DEFAULT_EXPANDED_PATHS),
        revealTarget: null,
      }),

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
      
      chatSessions: [
        {
          id: "session-1",
          title: "Project analysis & Landing page",
          workspace: "teminali",
          timestamp: "Just now",
          messages: [],
        },
        {
          id: "session-2",
          title: "Coffee shop website build",
          workspace: "teminali",
          timestamp: "2h ago",
          messages: [],
        },
        {
          id: "session-3",
          title: "General architecture & UI exploration",
          workspace: "Home",
          timestamp: "1d ago",
          messages: [],
        }
      ],
      activeSessionId: "session-1",
      sessionHistory: [],
      sessionHistoryIndex: -1,

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

        const session = state.chatSessions.find((entry) => entry.id === sessionId);
        set({
          activeSessionId: sessionId,
          sessionHistory: history,
          sessionHistoryIndex: history.length - 1,
          ...(session?.messages?.length ? { frontierMessages: session.messages } : {}),
        });
      },

      /** Moves through the visit stack without pushing onto it. */
      goBackSession: () => {
        const state = get();
        const target = state.sessionHistoryIndex - 1;
        const sessionId = state.sessionHistory[target];
        if (target < 0 || !sessionId) return;
        const session = state.chatSessions.find((entry) => entry.id === sessionId);
        set({
          activeSessionId: sessionId,
          sessionHistoryIndex: target,
          ...(session?.messages?.length ? { frontierMessages: session.messages } : {}),
        });
      },

      goForwardSession: () => {
        const state = get();
        const target = state.sessionHistoryIndex + 1;
        const sessionId = state.sessionHistory[target];
        if (!sessionId) return;
        const session = state.chatSessions.find((entry) => entry.id === sessionId);
        set({
          activeSessionId: sessionId,
          sessionHistoryIndex: target,
          ...(session?.messages?.length ? { frontierMessages: session.messages } : {}),
        });
      },
      frontierMessages: [
        {
          id: "front-1",
          role: "assistant",
          content: "**Frontier Auto** is ready. Frontier Auto is our official flagship engineered wrapper routing to best-fit local and specialized engines.",
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

      setStreaming: (isStreaming) => set({ isStreaming }),

      isSplitOpen: false,
      setSplitOpen: (open) => set({ isSplitOpen: open }),
      splitTab: "browser",
      setSplitTab: (tab) => set({ splitTab: tab }),
      browserPreviewUrl: "/preview/frontier-hypercar.html",
      setBrowserPreviewUrl: (url) => set({ browserPreviewUrl: url }),
      openBrowserPreview: (urlOrPath) => {
        const state = get();
        let targetUrl = urlOrPath;
        if (!targetUrl && state.activeTabId) {
          const tab = state.tabs.find((t) => t.id === state.activeTabId);
          if (tab && (tab.name.endsWith(".html") || tab.name.endsWith(".htm"))) {
            targetUrl = tab.path;
          }
        }
        set({
          // Legacy split flags, kept for anything still reading them.
          isSplitOpen: true,
          splitTab: "browser",
          ...(targetUrl ? { browserPreviewUrl: targetUrl } : {}),
        });
        // The redesigned shell renders panels, not the old single split slot,
        // so an artifact preview has to open one — and navigate its view,
        // which a store update alone does not do. Imported lazily to keep the
        // stores from depending on each other at module load.
        void import("../services/browserNavigation").then(({ openBrowserAt }) => {
          if (targetUrl) openBrowserAt(targetUrl);
          else void import("./panelStore").then(({ usePanelStore }) => usePanelStore.getState().open({ kind: "browser" }));
        });
      },
      
      isSkillsModalOpen: false,
      setSkillsModalOpen: (open) => set({ isSkillsModalOpen: open }),
      
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
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
    }
  )
);
