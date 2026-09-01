import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { ModelProfileId, ModelProfile, SpecialistSkill, EditorTab, FileItem, ChatMessage, ToolCall } from "../types";
import { purgeOllamaMemory } from "../services/aiService";
import { findTabByFileIdentity } from "./tabIdentity";

export const PROFILES_LIST: ModelProfile[] = [
  {
    id: "flash",
    name: "Teminali Flash",
    provider: "ollama",
    modelName: "Teminali Flash · fast local execution",
    costLabel: "$0.00 local",
    badge: "Fast · private · resource-safe",
    badgeColor: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    description: "Uses the lightweight local coding model for every request and releases model memory after completion.",
  },
  {
    id: "auto",
    name: "Teminali Auto",
    provider: "hybrid",
    modelName: "Teminali Auto · adaptive local routing",
    costLabel: "$0.00 local",
    badge: "Flagship · adaptive routing",
    badgeColor: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    description: "Routes simple work to Flash and may escalate complex work only after the exact Max model path is qualified.",
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

export const SKILLS_LIST: SpecialistSkill[] = [
  {
    id: "website-builder",
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

export const FILE_CONTENTS: Record<string, string> = {
  "package.json": "{\n  \"name\": \"@teminali/studio\",\n  \"version\": \"1.0.0\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"tsc && vite build\",\n    \"preview\": \"vite preview\",\n    \"server\": \"node server/api-server.js\",\n    \"start\": \"concurrently -k \\\"vite\\\" \\\"electron electron/main.cjs\\\"\",\n    \"desktop\": \"electron electron/main.cjs\"\n  },\n  \"dependencies\": {\n    \"@monaco-editor/react\": \"^4.7.0\",\n    \"clsx\": \"^2.1.1\",\n    \"framer-motion\": \"^12.4.7\",\n    \"immer\": \"^10.1.1\",\n    \"lucide-react\": \"^0.475.0\",\n    \"monaco-editor\": \"^0.52.2\",\n    \"react\": \"^19.0.0\",\n    \"react-dom\": \"^19.0.0\",\n    \"tailwind-merge\": \"^3.0.1\",\n    \"zustand\": \"^5.0.3\"\n  },\n  \"devDependencies\": {\n    \"@types/node\": \"^22.13.4\",\n    \"@types/react\": \"^19.0.10\",\n    \"@types/react-dom\": \"^19.0.4\",\n    \"@vitejs/plugin-react\": \"^4.3.4\",\n    \"autoprefixer\": \"^10.4.20\",\n    \"concurrently\": \"^9.1.2\",\n    \"electron\": \"^44.0.0\",\n    \"electron-builder\": \"^26.15.3\",\n    \"postcss\": \"^8.5.2\",\n    \"tailwindcss\": \"^3.4.17\",\n    \"typescript\": \"^5.7.3\",\n    \"vite\": \"^6.1.0\",\n    \"vite-plugin-electron\": \"^1.1.1\",\n    \"vite-plugin-electron-renderer\": \"^1.0.0\"\n  },\n  \"main\": \"electron/main.cjs\"\n}",
  "README.md": "# Teminali Studio ⚡\n\n> **The local-first, skill-native autonomous coding agent.**  \n> Sub-second local execution at zero token cost, paired with deterministic cloud escalation.\n\n---\n\n## 🌟 Core Pillars\n\n1. **Local-First Speed (Devstral 24B via Ollama Loopback)**\n   - High-throughput mechanical edits and test loops run locally with **0 token cost**.\n   \n2. **Deterministic Cloud Escalation**\n   - Complex architectural decisions escalate cleanly under strict process-scoped budgets.\n\n3. **Deep Integration with Teminali Cut**\n   - Native AI Copilot engine for video editing.\n\n---\n\n## 🚀 Quick Start\n\n```bash\nnpm run dev\n```\n\n---\n\n## 📄 License\nMIT © 2026 Teminali\n",
  "vite.config.ts": "import { defineConfig } from \"vite\";\nimport react from \"@vitejs/plugin-react\";\n\nexport default defineConfig({\n  plugins: [react()],\n  server: {\n    port: 3000,\n    host: true,\n    proxy: {\n      \"/ollama\": {\n        target: \"http://127.0.0.1:11434\",\n        changeOrigin: true,\n        rewrite: (path) => path.replace(/^\\/ollama/, \"\"),\n      },\n    },\n  },\n});\n",
  "src/App.tsx": "import React, { useState } from \"react\";\nimport { Header } from \"./components/header/Header\";\nimport { ActivityBar } from \"./components/sidebar/ActivityBar\";\nimport { Sidebar } from \"./components/sidebar/Sidebar\";\nimport { EditorPane } from \"./components/editor/EditorPane\";\nimport { TerminalPanel } from \"./components/editor/TerminalPanel\";\nimport { VideoStudio } from \"./components/video/VideoStudio\";\nimport { ChatDrawer } from \"./components/chat/ChatDrawer\";\nimport { StatusBar } from \"./components/sidebar/StatusBar\";\nimport { SkillsModal } from \"./components/modals/SkillsModal\";\n\nexport default function App() {\n  const [activeView, setActiveView] = useState(\"explorer\");\n  const [studioMode, setStudioMode] = useState<\"code\" | \"video\">(\"code\");\n  const [isTerminalOpen, setTerminalOpen] = useState(true);\n\n  return (\n    <div className=\"h-screen w-screen flex flex-col bg-[#08090b] text-[#dcdfe4] overflow-hidden select-none font-mono\">\n      {/* Top VS Code Window Titlebar with Studio Mode Switcher */}\n      <Header studioMode={studioMode} setStudioMode={setStudioMode} />\n\n      {/* Main IDE Workspace */}\n      <div className=\"flex-1 flex overflow-hidden\">\n        {/* Leftmost Activity Bar */}\n        <ActivityBar \n          activeView={activeView} \n          setActiveView={setActiveView} \n          studioMode={studioMode}\n          setStudioMode={setStudioMode}\n        />\n\n        {/* Dynamic Primary Sidebar (Explorer / Search / Git / Debug / Extensions) */}\n        <Sidebar activeView={activeView} />\n\n        {/* Center Canvas: Render Video Studio or Monaco Code Editor */}\n        <div className=\"flex-1 flex flex-col h-full overflow-hidden bg-[#08090b]\">\n          {studioMode === \"video\" ? (\n            <VideoStudio />\n          ) : (\n            <>\n              <EditorPane />\n              <TerminalPanel isOpen={isTerminalOpen} onClose={() => setTerminalOpen(false)} />\n            </>\n          )}\n        </div>\n\n        {/* Right AI Copilot Studio Drawer */}\n        <ChatDrawer />\n      </div>\n\n      {/* Bottom VS Code Status Bar */}\n      <StatusBar isTerminalOpen={isTerminalOpen} toggleTerminal={() => setTerminalOpen(!isTerminalOpen)} />\n\n      {/* Specialist Skills Modal */}\n      <SkillsModal />\n    </div>\n  );\n}\n",
  "src/index.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n@layer base {\n  /* Default sharp square panels & containers */\n  div, header, footer, aside, main, section, nav, textarea, input, select {\n    border-color: #232833;\n  }\n  \n  body {\n    background-color: #08090b;\n    color: #dcdfe4;\n    font-family: \"JetBrains Mono\", Menlo, Monaco, Consolas, monospace;\n    letter-spacing: -0.01em;\n  }\n}\n\n/* Sharp Technical Scrollbar */\n::-webkit-scrollbar {\n  width: 5px;\n  height: 5px;\n}\n\n::-webkit-scrollbar-track {\n  background: #08090b;\n}\n\n::-webkit-scrollbar-thumb {\n  background: #1e222b;\n  border-radius: 0px;\n}\n\n::-webkit-scrollbar-thumb:hover {\n  background: #38bdf8;\n}\n\n/* Badge Exception: Smooth rounded pills for micro-tags */\n.badge-pill, .rounded-full {\n  border-radius: 9999px !important;\n}\n\n.badge-tag, .rounded-md {\n  border-radius: 4px !important;\n}\n\n.badge-sm, .rounded-sm {\n  border-radius: 2px !important;\n}\n\n.status-dot {\n  border-radius: 9999px !important;\n}\n",
  "OpenCode_Groq_Codex_Handover.md": "# OpenCode + Groq Coding Agent \u2014 Codex Handover\n\n## Instructions to the receiving Codex\n\nYou are taking over the local setup and development of an OpenCode-based coding agent on my Mac.\n\nWork with me interactively **one step at a time**:\n\n1. Give me exactly one small action.\n2. Wait for my result or screenshot.\n3. Inspect the evidence before giving the next action.\n4. Do not give me a long batch of setup commands.\n5. Do not declare something working until we have tested it.\n6. Never ask me to paste an API key into chat, a source file, or a command that exposes it.\n\nDo not restart the setup from the beginning. Continue from the confirmed state below.\n\n## Strategic objective\n\nThe first milestone is to build an OpenCode-based coding system that can match or exceed **Google Antigravity when Antigravity is running GPT-OSS-120B Medium**.\n\nThis is deliberately narrower than claiming superiority over every Antigravity model. We need an honest, controlled same-model comparison first. After achieving parity, enhance the OpenCode system with specialized agents, verification workflows, local models, and low-cost model routing.\n\nThe longer-term objective is a potentially commercial coding agent that can eventually compete with Claude Code, Codex, Kimi Code, and Antigravity on selected software-engineering benchmarks. For now, do not overbuild a commercial platform. Establish the strongest reliable local harness and measurable baseline first.\n\n## My hardware and environment\n\n- Machine: 14-inch MacBook Pro, November 2024\n- Chip: Apple M4 Pro\n- Memory: 24 GB\n- OS shown previously: macOS Tahoe 26.1 Beta\n- OpenCode is running in the integrated terminal of my local Codex/editor environment.\n- Current project path shown by OpenCode: `/Users/teminali/Documents/my_projects/commercial-editor`\n- The actual frontier model will run through Groq, so the 24 GB RAM is not expected to run GPT-OSS-120B locally.\n- Ollama may later run smaller local helper models.\n\n## Confirmed completed setup\n\n1. OpenCode installed successfully.\n2. Installed OpenCode version: `1.18.25`.\n3. Groq provider connected successfully through OpenCode's `/connect` interface.\n4. The Groq API key was entered inside OpenCode and must remain secret.\n5. Groq model selected successfully in OpenCode:\n   - UI label: `GPT OSS 120B`\n   - Provider shown: `Groq`\n   - Groq model identifier: `openai/gpt-oss-120b`\n6. OpenCode UI showed: `Build \u00b7 GPT OSS 120B \u00b7 Groq`.\n\nDo not ask me to reinstall OpenCode, reconnect Groq, or re-enter the key unless direct evidence proves the stored connection is broken.\n\n## Current unresolved problem\n\nWe attempted a harmless API health check with this prompt:\n\n```text\nReply with exactly: GROQ GPT OSS 120B CONNECTED. Do not inspect, run, or modify any project files.\n```\n\nOpenCode did not return the requested response. It entered compaction and displayed:\n\n```text\nSession too large to compact - context exceeds model limit even after stripping media\n```\n\nThe screenshot still showed `Build \u00b7 GPT OSS 120B \u00b7 Groq`.\n\nNo project edit or command action was approved. Treat model/API functionality as **not yet verified**.\n\n## Exact next step\n\nFirst ask me to start a clean OpenCode conversation by entering:\n\n```text\n/new\n```\n\nExplain that this clears only OpenCode conversation context and should not modify project files. Then wait for me to report what appears. Do not combine this with several additional actions.\n\nAfter a clean session is confirmed, retry the harmless health-check prompt. If it succeeds, record the result and move to safe configuration. If the same compaction error returns in a genuinely fresh session, investigate model metadata, context-limit configuration, project instructions, plugins, and startup context before changing anything.\n\nBecause OpenCode is currently opened inside a real repository, prefer moving setup experiments to a dedicated clean test repository before allowing edits. Do not delete, reset, or overwrite anything in `commercial-editor`.\n\n## Phase 1 architecture\n\nUse this initial stack:\n\n| Component | Initial choice |\n| --- | --- |\n| Agent harness | OpenCode stable |\n| Primary model | Groq `openai/gpt-oss-120b` |\n| Primary role | Architecture, implementation, difficult debugging |\n| Local runtime | Ollama, later and only for smaller helper models |\n| Long-task state | Repository-backed task and handoff files |\n| Code intelligence | OpenCode search, LSP, editing, shell, diagnostics |\n| UI verification | Playwright in an isolated browser profile |\n| Recovery | OpenCode snapshots plus Git checkpoints/worktrees |\n| Evaluation | Reproducible tasks, logs, tests, time, tokens, cost |\n\nDo not add another paid model provider during the controlled baseline unless I explicitly approve it.\n\n## Two configurations we must preserve\n\n### A. Controlled same-model baseline\n\nUse GPT-OSS-120B as the only reasoning/coding model. This is the configuration to compare with Antigravity's GPT-OSS-120B mode.\n\nThe purpose is to answer:\n\n> With the same principal model, can our OpenCode agent harness and workflow outperform Antigravity on our target tasks?\n\nDo not silently use Codex, Claude, Gemini, Qwen, or a local model to help solve benchmark tasks in this baseline.\n\n### B. Enhanced OpenCode system\n\nAfter the baseline is working and measured, allow specialized low-cost or local models for bounded roles such as repository mapping, classification, summarization, and test-log triage. Retain GPT-OSS-120B for high-value engineering decisions and use a separate reviewer where useful.\n\nKeep the results of this enhanced system separate from the controlled same-model comparison.\n\n## Required long-task workflow\n\nThe eventual agent should enforce this loop for significant tasks:\n\n1. Read repository instructions and inspect the relevant structure.\n2. Reproduce the bug or establish a measurable baseline.\n3. Write a persistent plan with acceptance criteria.\n4. Implement one bounded milestone.\n5. Run the narrowest relevant tests, then broader checks.\n6. Diagnose failures and retry without repeating failed actions blindly.\n7. Verify UI behavior with Playwright when applicable.\n8. Review the final diff independently.\n9. Save a recoverable checkpoint.\n10. Report evidence: changed files, commands run, tests passed, failures, risks, and next actions.\n\nGenerated code alone is not completion. Require verification evidence.\n\n## Antigravity capability mapping\n\n| Antigravity concept | Planned OpenCode equivalent |\n| --- | --- |\n| Plan artifact | Persistent task plan and acceptance criteria |\n| Walkthrough | Completion/handoff report with evidence |\n| Rules | Root and directory-level `AGENTS.md` |\n| Workflows | OpenCode custom commands and skills |\n| Screenshots | Playwright screenshot evidence |\n| Browser verification | Isolated Playwright profile and safe URL policy |\n| Checkpoints | OpenCode snapshots and Git commits/worktrees |\n| Long tasks | Persistent state, milestones, and resumable sessions |\n| Review | Independent reviewer role |\n| Model selection | Explicit routing by task, after baseline |\n| Usage visibility | Per-task latency, token, error, and cost logs |\n\n## Configuration goals after the API health check\n\nDo not write configuration until the model connection test succeeds. Then build and validate configuration incrementally.\n\nDesired eventual settings include:\n\n- Disable session sharing for proprietary repositories.\n- Keep snapshots enabled where repository size permits.\n- Enable LSP and appropriate formatters.\n- Enable automatic compaction and pruning with a safe reserved token buffer.\n- Ignore noisy generated folders such as `node_modules`, build output, and `.git` in watchers.\n- Require approval for risky shell commands and deployments.\n- Deny destructive or credential-exposing operations.\n- Maintain explicit repository instructions instead of putting enormous policies in every prompt.\n- Add structured architect, builder, verifier, and reviewer roles only after the simple single-agent baseline works.\n\nUse the current OpenCode configuration schema and validate it against the installed version. Do not copy obsolete configuration keys from old tutorials.\n\n## Safety rules\n\n- Never display or echo the Groq API key.\n- Never commit secrets, `.env` files, credentials, or private certificates.\n- Never run destructive Git commands such as `git reset --hard` without explicit approval.\n- Never delete directories or bulk files without resolving and confirming exact targets.\n- Never deploy, publish, push, open a pull request, or contact an external service without my approval.\n- Begin in an isolated test repository, not my production project.\n- Use read-only inspection before any significant modification.\n- Preserve unrelated existing changes in dirty worktrees.\n- Keep OpenCode session sharing disabled for proprietary work.\n\n## Benchmark integrity\n\nRunning OpenCode from a terminal visible inside Codex is acceptable for setup and logging, but Codex must not help OpenCode solve a benchmark task.\n\nFor controlled comparisons:\n\n- Use identical clean Git worktrees or repository snapshots.\n- Use exactly the same task statement and acceptance tests.\n- Keep secrets and environment dependencies equivalent.\n- Fix time, retry, and human-intervention budgets.\n- Do not let one agent inspect another agent's solution.\n- Record every intervention.\n- Use hidden or independently maintained tests where possible.\n- Separate harness failures from model failures.\n- Preserve raw execution logs and final diffs.\n\nTrack at least:\n\n- Acceptance-test pass rate\n- Regression-test pass rate\n- Human interventions\n- Completion time\n- Input and output tokens\n- Estimated API cost\n- Tool-call errors\n- Unnecessary code churn\n- Security or destructive-action violations\n- First-attempt success\n\nStart with approximately 10 representative tasks before expanding to 30\u201350. Include bug repair, multi-file implementation, refactoring, tests, screenshot-to-UI work, browser debugging, dependency migration, unfamiliar-repository onboarding, and interrupted-task recovery.\n\n## Cost and rate-limit assumptions\n\nWe are initially using the existing Groq account and free allowance. Do not require another provider account for Phase 1.\n\nGroq's published GPT-OSS-120B paid rates previously checked were approximately:\n\n- Input: `$0.15` per million tokens\n- Cached input: `$0.075` per million tokens\n- Output: `$0.60` per million tokens\n\nFree-tier limits can prevent a large benchmark from completing even when model context is large. Distinguish provider rate limits from model context limits and from OpenCode compaction errors. Re-check current official limits before making cost or capacity decisions.\n\n## Official references\n\n- OpenCode installation and overview: <https://opencode.ai/docs/>\n- OpenCode providers and Groq connection: <https://opencode.ai/docs/providers/>\n- OpenCode TUI commands: <https://opencode.ai/docs/tui/>\n- OpenCode configuration: <https://opencode.ai/docs/config/>\n- OpenCode agents: <https://opencode.ai/docs/agents/>\n- OpenCode permissions: <https://opencode.ai/docs/permissions/>\n- OpenCode CLI: <https://opencode.ai/docs/cli/>\n- Groq GPT-OSS-120B model details: <https://console.groq.com/docs/model/openai/gpt-oss-120b>\n- Groq rate limits: <https://console.groq.com/docs/rate-limits>\n- Antigravity model documentation: <https://antigravity.google/docs/models/>\n\n## Definition of the first successful milestone\n\nPhase 1 is successful only when all of the following are true:\n\n1. A fresh OpenCode session can call Groq GPT-OSS-120B successfully.\n2. A clean test repository is used instead of experimenting on production code.\n3. The single-model baseline can inspect, edit, test, and report safely.\n4. Long-task state survives session interruption through repository-backed artifacts.\n5. Browser/UI tasks can be verified with reproducible evidence.\n6. At least 10 controlled benchmark tasks have been executed and scored.\n7. Results can distinguish OpenCode harness quality, model limitations, provider limits, and human assistance.\n\nContinue from the **Exact next step** above and guide me one action at a time.\n"
};

export type ScreenshotToCodeStack = "react-tailwind" | "html-css" | "nextjs" | "vue";

interface StudioState {
  currentProfile: ModelProfileId;
  setProfile: (profile: ModelProfileId) => void;
  
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
  activeWorkspaceId: "teminali" | "teminali-code-tests" | "antigravity-vpn";
  setWorkspace: (ws: "teminali" | "teminali-code-tests" | "antigravity-vpn") => void;
  files: FileItem[];
  setFiles: (files: FileItem[]) => void;
  
  tabs: EditorTab[];
  activeTabId: string | null;
  openFile: (file: { path: string; name: string; content?: string; language?: string; encoding?: "utf8" | "base64"; mimeType?: string; size?: number; modified?: string }) => void;
  addUntitledTab: () => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  syncFileContent: (file: { path: string; content: string; modified?: string; size?: number; mimeType?: string }) => void;
  
  frontierMessages: ChatMessage[];
  antigravityMessages: ChatMessage[];
  claudeMessages: ChatMessage[];
  codexMessages: ChatMessage[];
  isStreaming: boolean;
  addMessageToEngine: (engine: "frontier" | "antigravity" | "claude" | "codex", message: Omit<ChatMessage, "id" | "timestamp">) => void;
  updateLastMessageInEngine: (engine: "frontier" | "antigravity" | "claude" | "codex", updater: (msg: ChatMessage) => Partial<ChatMessage>) => void;
  clearEngineSession: (engine: "frontier" | "antigravity" | "claude" | "codex") => void;
  setStreaming: (streaming: boolean) => void;
  
  isSkillsModalOpen: boolean;
  setSkillsModalOpen: (open: boolean) => void;
  isDiffViewerOpen: boolean;
  isNearbyMeshOpen: boolean;
  isBenchmarkModalOpen: boolean;
  setBenchmarkModalOpen: (open: boolean) => void;
  setNearbyMeshOpen: (open: boolean) => void;
  setDiffViewerOpen: (open: boolean) => void;
  activeDiff: { file: string; oldCode: string; newCode: string } | null;
  setActiveDiff: (diff: { file: string; oldCode: string; newCode: string } | null) => void;
  purgeVRAM: () => Promise<void>;
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => ({
      currentProfile: "auto",
      setProfile: (profile) => set({ currentProfile: profile }),
      
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
      workspacePath: "/Users/teminali/Documents/my_projects/frontier",
      setWorkspace: (ws) => {
        if (ws === "teminali-code-tests") {
          set({
            activeWorkspaceId: "teminali-code-tests",
            workspacePath: "/Users/teminali/Downloads/frontier code tests",
            activeTabId: "tab-frontier-hypercar",
          });
        } else if (ws === "antigravity-vpn") {
          set({
            activeWorkspaceId: "antigravity-vpn",
            workspacePath: "/Users/teminali/Documents/my_projects/antigravity-vpn-landing",
            activeTabId: "tab-agy-vpn",
          });
        } else {
          set({
            activeWorkspaceId: "teminali",
            workspacePath: "/Users/teminali/Documents/my_projects/frontier",
          });
        }
      },
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
      
      tabs: [
      {
        id: "tab-banner",
        name: "banner.tsx",
        path: "src/components/banner.tsx",
        language: "typescript",
        isDirty: false,
        content: `import React from "react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import bannerImg from "../assets/savanna-hero-banner-image.png";
import bannerBgImg from "../assets/banner-bg-image.png";

const slides = [
  {
    id: 1,
    image: bannerImg,
    bgImg: bannerBgImg,
    title: "AT TAXFARM. WE TURN YOUR CRYPTO TAXES INTO ACTUAL FARMLAND",
    subtitle:
      "EVERY $FARM TOKEN YOU HOLD BUYS REAL LAND, GROWS REAL FOOD, AND PAYS YOU REAL MONEY FROM EACH HARVEST.",
    buttonText: "Shop now",
  },
  {
    id: 2,
  },
  {
    id: 3,
  }
];

useEffect(() => {
  // Real-time animation cycle
}, []);

return (
  <div>
    <div className="relative h-[480px] w-full rounded-2xl overflow-hidden shadow-2xl">
      {/* Slides */}
      {slides.map((slide, index) => (
        <div key={index} className="w-full h-full">
          {/* Banner content */}
        </div>
      ))}
    </div>
  </div>
);`,
      },
      {
        id: "tab-product",
        name: "product.js",
        path: "src/product.js",
        language: "javascript",
        isDirty: false,
        content: `export const products = [
  { id: 1, name: "Farmland Plot A", price: 1200, yield: "14.2%" },
  { id: 2, name: "Organic Honey Harvest", price: 45, yield: "8.5%" }
];`,
      },
      {
        id: "tab-package",
        name: "package.js",
        path: "package.json",
        language: "json",
        isDirty: false,
        content: `{
  "name": "codient-ai-ide",
  "version": "2.4.0",
  "dependencies": {
    "react": "^18.3.1",
    "lucide-react": "^0.475.0"
  }
}`,
      },
      {
        id: "tab-index",
        name: "index.html",
        path: "index.html",
        language: "html",
        isDirty: false,
        content: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Codient App</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>`,
      },
      {
        id: "node-frontier",
        name: "node-frontier.html",
        path: "test-node-editor-frontier/index.html",
        language: "html",
        content: "<!-- Frontier node editor benchmark -->",
        isDirty: false,
      },
      {
        id: "node-agy",
        name: "node-agy.html",
        path: "test-node-editor-agy/index.html",
        language: "html",
        content: "<!-- Antigravity node editor benchmark -->",
        isDirty: false,
      },
      {
        id: "tab-teminali-cut-download",
        name: "🎬 Teminali_Cut_v2.0.html",
        path: "preview/teminali-cut-download.html",
        content: "<!-- Teminali Cut v2.0 Official GitHub Release & Download Page -->\n<!-- Preview at: http://localhost:3000/preview/teminali-cut-download.html -->",
        isDirty: false,
        language: "html",
      },
      {
        id: "tab-frontier-hypercar",
        name: "⚡ Aether_Mach_1.html",
        path: "preview/frontier-hypercar.html",
        content: "<!-- Aether Mach 1 Hypercar Launch Page -->\n<!-- Generated autonomously by Teminali Auto ($0.00 / Local GPU) -->\n<!-- Preview at: http://localhost:3000/preview/frontier-hypercar.html -->",
        isDirty: false,
        language: "html",
      },
      {
        id: "tab-gemini-hypercar",
        name: "🌌 Gemini_Mach_1.html",
        path: "preview/gemini-hypercar.html",
        content: "<!-- Aether Mach 1 Hypercar Launch Page -->\n<!-- Generated by Gemini 3.1 Pro (High Reasoning) -->\n<!-- Preview at: http://localhost:3000/preview/gemini-hypercar.html -->",
        isDirty: false,
        language: "html",
      },

        {
          id: "tab-codex-diff",
          name: "Codex Diff",
          path: "Codex Diff",
          language: "diff",
          content: "",
          isDirty: false,
        },
        {
          id: "tab-readme",
          name: "README.md",
          path: "README.md",
          language: "markdown",
          content: FILE_CONTENTS["README.md"] || "# Frontier Studio ⚡\n",
          isDirty: false,
        },
        {
          id: "tab-app",
          name: "App.tsx",
          path: "src/App.tsx",
          language: "typescript",
          content: FILE_CONTENTS["src/App.tsx"] || "// App.tsx\n",
          isDirty: false,
        },
      ],
      activeTabId: "tab-frontier-hypercar",
      
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

        const resolvedContent = content ?? FILE_CONTENTS[filePath] ?? FILE_CONTENTS[name] ?? "";

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
      
      frontierMessages: [
        {
          id: "front-1",
          role: "assistant",
          content: "**Teminali Auto** is ready. Auto is the flagship local router; while Max is unqualified it uses the resource-safe Flash model and reports the selected route.",
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

      clearEngineSession: (engine) => {
        set((state) => {
          const defaultMsg: ChatMessage = {
            id: `msg_init_${Date.now()}`,
            role: "assistant",
            content: engine === "frontier" 
              ? "**Teminali session ready.** Select Flash, Auto, or Max in the composer. Max remains locked until qualification passes."
              : engine === "antigravity"
              ? "🌌 **Antigravity**: New session started with Google DeepMind Gemini 3.7 Pro."
              : engine === "claude"
              ? "🏛️ **Claude Code**: New session started."
              : "🧠 **Codex**: New session started.",
            timestamp: "Just now",
            costUsd: 0,
            costLabel: "$0.00",
          };
          if (engine === "frontier") return { frontierMessages: [defaultMsg] };
          if (engine === "antigravity") return { antigravityMessages: [defaultMsg] };
          if (engine === "claude") return { claudeMessages: [defaultMsg] };
          return { codexMessages: [defaultMsg] };
        });
      },
      
      setStreaming: (isStreaming) => set({ isStreaming }),
      
      isSkillsModalOpen: false,
      setSkillsModalOpen: (open) => set({ isSkillsModalOpen: open }),
      
      isDiffViewerOpen: false,
      isNearbyMeshOpen: false,
      isBenchmarkModalOpen: false,
      setBenchmarkModalOpen: (open) => set({ isBenchmarkModalOpen: open }),
      setNearbyMeshOpen: (open) => set({ isNearbyMeshOpen: open }),
      setDiffViewerOpen: (open) => set({ isDiffViewerOpen: open }),
      
      activeDiff: null,
      setActiveDiff: (diff) => set({ activeDiff: diff, isDiffViewerOpen: !!diff }),
    }),
    {
      name: "teminali-studio-sessions-cache-v3",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        frontierMessages: state.frontierMessages,
        antigravityMessages: state.antigravityMessages,
        claudeMessages: state.claudeMessages,
        codexMessages: state.codexMessages,
        budgetUsd: state.budgetUsd,
        spentUsd: state.spentUsd,
        currentProfile: state.currentProfile,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
    }
  )
);
