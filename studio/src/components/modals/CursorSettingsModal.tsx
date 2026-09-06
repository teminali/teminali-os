import React, { useState, useEffect } from "react";
import { VoiceSettingsPanel } from "../voice/VoiceSettingsPanel";
import { AssistantSettingsPanel } from "../assistant/AssistantSettingsPanel";
import { useAssistantSession } from "../assistant/AssistantContext";
import { useVoice } from "../../hooks/useVoice";
import { ModelsPane } from "../models/ModelsPane";
import { MacCloseButton } from "../ui";
import { GitHubConnect } from "../github/GitHubConnect";
import {
  Search,
  Settings,
  User,
  SunMoon,
  CreditCard,
  Bot,
  Cloud,
  Layers,
  GitBranch,
  GitFork,
  SlidersHorizontal,
  Globe,
  Binary,
  Database,
  FlaskConical,
  FileText,
  ExternalLink,
  Zap,
  Check,
  ShieldCheck,
  Download,
  Loader2,
  HardDrive,
  Cpu,
  RefreshCw,
  Sparkle,
  CheckCircle2,
  AlertCircle, Mic, MousePointer2 } from "lucide-react";
import { useStudioStore } from "../../store/studioStore";

interface LocalOllamaModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface RecommendedModel {
  tag: string;
  name: string;
  paramSize: string;
  estSize: string;
  family: string;
  description: string;
  recommendedRole: string;
}

const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    tag: "qwen2.5-coder:14b",
    name: "Qwen 2.5 Coder 14B",
    paramSize: "14.8B",
    estSize: "9.0 GB",
    family: "Qwen",
    description: "Flagship coding and tool-calling model. Best for full-stack builds and refactoring.",
    recommendedRole: "Primary Flagship Coder",
  },
  {
    tag: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder 7B",
    paramSize: "7.6B",
    estSize: "4.7 GB",
    family: "Qwen",
    description: "Lightweight, ultra-fast coding model for rapid edits and autocomplete.",
    recommendedRole: "Fast Local Autocomplete",
  },
  {
    tag: "deepseek-r1:8b",
    name: "DeepSeek R1 8B",
    paramSize: "8.0B",
    estSize: "4.9 GB",
    family: "DeepSeek",
    description: "Reasoning and architecture planning model with chain-of-thought verification.",
    recommendedRole: "Logic & Planning Specialist",
  },
  {
    tag: "devstral-small-2:24b-instruct-2512-q4_K_M",
    name: "Devstral 24B",
    paramSize: "24.0B",
    estSize: "15.2 GB",
    family: "Mistral",
    description: "High-context 32k window developer model for large multi-file refactoring.",
    recommendedRole: "Multi-File Refactoring",
  },
  {
    tag: "llama3.2:3b",
    name: "Llama 3.2 3B",
    paramSize: "3.2B",
    estSize: "2.0 GB",
    family: "Llama",
    description: "Ultra-compact model with minimal RAM footprint for laptops.",
    recommendedRole: "Ultra-Lightweight Helper",
  },
  {
    tag: "qwen3-vl:2b",
    name: "Qwen3 VL 2B",
    paramSize: "2.1B",
    estSize: "1.9 GB",
    family: "Qwen Vision",
    description: "Visual understanding and UI screenshot inspector for visual verification.",
    recommendedRole: "Visual UI Auditor",
  },
];

export const CursorSettingsModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const [activeCategory, setActiveCategory] = useState("general");
  const [searchQuery, setSearchQuery] = useState("");
  const [tipsEnabled, setTipsEnabled] = useState(true);
  const [systemNotifs, setSystemNotifs] = useState(true);
  const [warningNotifs, setWarningNotifs] = useState(false);
  const [menuBarIcon, setMenuBarIcon] = useState(true);
  const [completionSound, setCompletionSound] = useState(false);

  // Local models state
  const [localModels, setLocalModels] = useState<LocalOllamaModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [ollamaConnected, setOllamaConnected] = useState(true);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [customModelTag, setCustomModelTag] = useState("");
  const [activeModelName, setActiveModelName] = useState("qwen2.5-coder:14b");
  const [pullError, setPullError] = useState<string | null>(null);
  const [pullSuccess, setPullSuccess] = useState<string | null>(null);

  const { setBenchmarkModalOpen, setSkillsModalOpen } = useStudioStore();

  const fetchLocalModels = async () => {
    setIsLoadingModels(true);
    setPullError(null);
    try {
      const res = await fetch("/api/models/local");
      if (res.ok) {
        const data = await res.json();
        setOllamaConnected(data.connected);
        setLocalModels(data.models || []);
      } else {
        // Fallback direct check if proxy is not yet reloaded
        const direct = await fetch("http://127.0.0.1:11434/api/tags").catch(() => null);
        if (direct && direct.ok) {
          const directData = await direct.json();
          setOllamaConnected(true);
          setLocalModels(directData.models || []);
        } else {
          setOllamaConnected(false);
        }
      }
    } catch {
      setOllamaConnected(false);
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLocalModels();
    }
  }, [isOpen, activeCategory]);

  const handlePullModel = async (tag: string) => {
    if (!tag.trim() || pullingModel) return;
    const modelTag = tag.trim();
    setPullingModel(modelTag);
    setPullError(null);
    setPullSuccess(null);

    try {
      const res = await fetch("http://127.0.0.1:11434/api/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelTag, stream: false }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Failed to download ${modelTag}`);
      }

      setPullSuccess(`Successfully downloaded ${modelTag}!`);
      await fetchLocalModels();
      setActiveModelName(modelTag);
    } catch (err: any) {
      setPullError(err?.message || `Failed to pull model ${modelTag}. Ensure Ollama is running.`);
    } finally {
      setPullingModel(null);
    }
  };

  if (!isOpen) return null;

  const isModelDownloaded = (tag: string) => {
    return localModels.some(
      (m) => m.name === tag || m.model === tag || m.name.startsWith(tag) || tag.startsWith(m.name)
    );
  };

  const formatBytes = (bytes: number) => {
    if (!bytes) return "0 B";
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  };

  const categories = [
    { id: "general", label: "General", icon: Settings },
    { id: "models", label: "Local Models & Weights", icon: Layers },
    { id: "profile", label: "Profile", icon: User },
    { id: "appearance", label: "Appearance & Tokens", icon: SunMoon },
    { id: "plan", label: "Plan & Usage", icon: CreditCard },
    { id: "agents", label: "Teminali OS", icon: Bot },
    { id: "cloud-agents", label: "Cloud Agents", icon: Cloud, isExternal: true },
    { id: "git", label: "Git & PRs", icon: GitBranch },
    { id: "worktrees", label: "Worktrees", icon: GitFork },
    { id: "customize", label: "Skills & MCP", icon: SlidersHorizontal },
    { id: "voice", label: "Voice & Conversation", icon: Mic },
    { id: "assistant", label: "Screen Assistant", icon: MousePointer2 },
    { id: "browser", label: "Browser & Preview", icon: Globe },
    { id: "tab", label: "Tab Autocomplete", icon: Binary },
    { id: "indexing", label: "AST Indexing", icon: Database },
    { id: "beta", label: "Benchmark Qualification", icon: FlaskConical },
    { id: "docs", label: "Docs", icon: FileText, isExternal: true },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div className="lit lit-inner relative bg-frame-mid rounded-xl w-[1040px] h-[680px] max-w-[94vw] max-h-[88vh] shadow-modal flex overflow-hidden text-ink-prose antialiased font-sans">
        <div className="absolute top-3 right-3 z-20">
          <MacCloseButton onClose={onClose} size={14} />
        </div>
        {/* Left Settings Categories Sidebar */}
        <aside className="w-60 bg-frame-bot border-r border-edge-chrome flex flex-col justify-between p-3 flex-shrink-0">
          <div className="space-y-4">
            {/* Back Button & Title */}
            <div className="flex items-center gap-2 px-2 py-1">

              <span className="text-sm font-semibold text-ink-bright tracking-tight">Teminali OS Settings</span>
            </div>

            {/* Settings Search Bar */}
            <div className="relative px-1">
              <Search size={13} className="absolute left-3.5 top-2.5 text-ink-muted" />
              <input
                type="text"
                placeholder="Search settings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="lit lit-inner w-full pl-8 pr-3 py-1.5 bg-surface -chrome rounded-lg text-xs text-ink-bright placeholder:text-ink-placeholder focus:outline-none transition-colors"
              />
            </div>

            {/* Categories List */}
            <div className="space-y-0.5 max-h-[400px] overflow-y-auto pr-1">
              {categories
                .filter((cat) => cat.label.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((cat) => {
                  const Icon = cat.icon;
                  const isSelected = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => {
                        if (cat.id === "customize") {
                          onClose();
                          setSkillsModalOpen(true);
                          return;
                        }
                        if (cat.id === "beta") {
                          onClose();
                          setBenchmarkModalOpen(true);
                          return;
                        }
                        if (cat.isExternal) return;
                        setActiveCategory(cat.id);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        isSelected
                          ? "bg-accent/12 text-accent border border-accent/25"
                          : "text-ink-muted hover:bg-surface-chip hover:text-ink-high"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <Icon size={14} className={isSelected ? "text-accent" : "text-ink-muted"} />
                        <span className="truncate">{cat.label}</span>
                      </div>
                      {cat.isExternal && <ExternalLink size={11} className="text-ink-placeholder flex-shrink-0" />}
                    </button>
                  );
                })}
            </div>
          </div>

          {/* User Profile Pill at Bottom */}
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
            <span className="px-2 py-0.5 rounded-full bg-accent/15 text-accent font-semibold text-3xs border border-accent/30">
              Pro
            </span>
          </div>
        </aside>

        {/* Right Settings Content Canvas */}
        <main className="flex-1 bg-frame-mid p-7 overflow-y-auto space-y-6 font-sans">
          {activeCategory === "assistant" ? (
            <AssistantSection />
          ) : activeCategory === "voice" ? (
            <div className="space-y-5">
              <div>
                <h1 className="text-md font-semibold text-ink-bright tracking-tight flex items-center gap-2">
                  <Mic size={16} className="text-accent" />
                  Voice &amp; Conversation
                </h1>
                <p className="text-2xs text-ink-faint mt-1 max-w-lg leading-relaxed">
                  Dictate a prompt, or hold a hands-free conversation. Everything you say is cleaned up and shown to you
                  before it reaches the chat.
                </p>
              </div>
              <VoiceSection />
            </div>
          ) : activeCategory === "git" ? (
            <div className="space-y-4">
              <div>
                <h1 className="text-md font-semibold text-ink-bright tracking-tight flex items-center gap-2">
                  <GitBranch size={16} className="text-accent" />
                  Git &amp; GitHub
                </h1>
                <p className="text-2xs text-ink-faint mt-1 max-w-xl leading-relaxed">
                  The studio uses your existing GitHub CLI sign-in where it can, so it never has to hold a credential of
                  its own.
                </p>
              </div>
              <GitHubConnect />
            </div>
          ) : activeCategory === "models" ? (
            <ModelsPane />
          ) : (
            /* ========================================================================= */
            /* ⚙️ GENERAL SETTINGS SCREEN                                                */
            /* ========================================================================= */
            <>
              <div>
                <h1 className="text-lg font-semibold text-ink-bright tracking-tight">Teminali OS Settings</h1>
                <p className="text-xs text-ink-muted mt-1">Configure your local gateway, model execution lanes, and editor preferences.</p>
              </div>

              {/* Section: Account & Gateway Card */}
              <div className="lit lit-inner bg-surface -chrome rounded-xl divide-y divide-edge-chrome">
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-semibold text-ink-bright">Teminali Local Gateway</h3>
                    <p className="text-2xs text-ink-muted mt-0.5">Running locally at http://127.0.0.1:4310 · Ollama connected</p>
                  </div>
                  <span className="px-2.5 py-1 rounded-md bg-success/10 text-success border border-success/25 text-xs font-medium">
                    Connected
                  </span>
                </div>

                <div className="p-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-semibold text-ink-bright">Model Management & Local Weights</h3>
                    <p className="text-2xs text-ink-muted mt-0.5">
                      Select active coding models or download new models directly to disk.
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveCategory("models")}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-frame-top text-xs font-semibold shadow-sm transition-colors"
                  >
                    <Layers size={13} />
                    <span>Manage Models</span>
                  </button>
                </div>
              </div>

              {/* Section: Startup */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Startup & Windows</h2>
                <div className="lit lit-inner bg-surface -chrome rounded-xl divide-y divide-edge-chrome">
                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-ink-bright">Tips</h3>
                      <p className="text-2xs text-ink-muted mt-0.5">Show rotating tips on the empty screen</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTipsEnabled((prev) => !prev)}
                      className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                        tipsEnabled ? "bg-accent" : "bg-surface-hover"
                      }`}
                    >
                      <div
                        className={`bg-ink-high w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          tipsEnabled ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-ink-bright">Window Restoration</h3>
                      <p className="text-2xs text-ink-muted mt-0.5">Controls which workspace tabs Teminali restores on startup</p>
                    </div>
                    <select className="lit lit-inner px-3 py-1.5 bg-surface-raised rounded-lg text-xs text-ink-prose focus:outline-none">
                      <option>Restore Active Workspace</option>
                      <option>Restore All Tabs</option>
                      <option>Start Blank</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Section: Notifications */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Notifications</h2>
                <div className="lit lit-inner bg-surface -chrome rounded-xl divide-y divide-edge-chrome">
                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-ink-bright">System Notifications</h3>
                      <p className="text-2xs text-ink-muted mt-0.5">
                        Show notifications when Teminali agents complete builds
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSystemNotifs((prev) => !prev)}
                      className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                        systemNotifs ? "bg-accent" : "bg-surface-hover"
                      }`}
                    >
                      <div
                        className={`bg-ink-high w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          systemNotifs ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-ink-bright">Completion Sound</h3>
                      <p className="text-2xs text-ink-muted mt-0.5">Play audio feedback when tasks pass verification</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCompletionSound((prev) => !prev)}
                      className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                        completionSound ? "bg-accent" : "bg-surface-hover"
                      }`}
                    >
                      <div
                        className={`bg-ink-high w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          completionSound ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* Section: Privacy */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">Privacy & Security</h2>
                <div className="lit lit-inner bg-surface -chrome rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-bright">
                      <ShieldCheck size={14} className="text-success" />
                      <span>100% Local Execution · Zero Telemetry Exfiltration</span>
                    </div>
                    <p className="text-2xs text-ink-muted mt-0.5">
                      Your codebase, prompt context, and file mutations never leave this machine.
                    </p>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-success/12 text-success border border-success/25 text-2xs font-semibold">
                    Strict Local
                  </span>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
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
        <h1 className="text-md font-semibold text-ink-bright tracking-tight flex items-center gap-2">
          <MousePointer2 size={16} className="text-accent" />
          Screen Assistant
        </h1>
        <p className="text-2xs text-ink-faint mt-1 max-w-lg leading-relaxed">
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
