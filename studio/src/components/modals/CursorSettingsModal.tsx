import React, { useState, useEffect } from "react";
import {
  ArrowLeft,
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
  Sparkles,
  CheckCircle2,
  AlertCircle
} from "lucide-react";
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
    { id: "agents", label: "Teminali Code", icon: Bot },
    { id: "cloud-agents", label: "Cloud Agents", icon: Cloud, isExternal: true },
    { id: "git", label: "Git & PRs", icon: GitBranch },
    { id: "worktrees", label: "Worktrees", icon: GitFork },
    { id: "customize", label: "Skills & MCP", icon: SlidersHorizontal },
    { id: "browser", label: "Browser & Preview", icon: Globe },
    { id: "tab", label: "Tab Autocomplete", icon: Binary },
    { id: "indexing", label: "AST Indexing", icon: Database },
    { id: "beta", label: "Benchmark Qualification", icon: FlaskConical },
    { id: "docs", label: "Docs", icon: FileText, isExternal: true },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-[#12141C] border border-white/10 rounded-2xl w-[940px] h-[640px] shadow-2xl flex overflow-hidden text-gray-200 antialiased font-sans">
        {/* Left Settings Categories Sidebar */}
        <aside className="w-60 bg-[#0B0D14] border-r border-white/5 flex flex-col justify-between p-3 flex-shrink-0">
          <div className="space-y-4">
            {/* Back Button & Title */}
            <div className="flex items-center gap-2 px-2 py-1">
              <button
                onClick={onClose}
                className="p-1 -ml-1 rounded-md text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                <ArrowLeft size={16} />
              </button>
              <span className="text-sm font-semibold text-white tracking-tight">Teminali Studio Settings</span>
            </div>

            {/* Settings Search Bar */}
            <div className="relative px-1">
              <Search size={13} className="absolute left-3.5 top-2.5 text-gray-400" />
              <input
                type="text"
                placeholder="Search settings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-[#161926] border border-white/5 rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/50 transition-colors"
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
                          ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                          : "text-gray-400 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <Icon size={14} className={isSelected ? "text-blue-400" : "text-gray-400"} />
                        <span className="truncate">{cat.label}</span>
                      </div>
                      {cat.isExternal && <ExternalLink size={11} className="text-gray-500 flex-shrink-0" />}
                    </button>
                  );
                })}
            </div>
          </div>

          {/* User Profile Pill at Bottom */}
          <div className="pt-2 border-t border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-2xs border border-white/10 shadow-sm">
                T
              </div>
              <div className="flex flex-col">
                <span className="text-2xs font-semibold text-white leading-tight">Teminali Developer</span>
                <span className="text-3xs text-blue-400">Local Unified Flagship</span>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-semibold text-3xs border border-blue-500/30">
              Pro
            </span>
          </div>
        </aside>

        {/* Right Settings Content Canvas */}
        <main className="flex-1 bg-[#0E1019] p-7 overflow-y-auto space-y-6 font-sans">
          {activeCategory === "models" ? (
            /* ========================================================================= */
            /* 🧠 LOCAL MODELS & DOWNLOAD MANAGER                                       */
            /* ========================================================================= */
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-semibold text-white tracking-tight flex items-center gap-2">
                    <Layers size={18} className="text-blue-400" />
                    <span>Local AI Models & Weights</span>
                  </h1>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Manage, select, and download offline AI coding models via Ollama.
                  </p>
                </div>
                <button
                  onClick={fetchLocalModels}
                  disabled={isLoadingModels}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-medium text-slate-200 transition-colors"
                >
                  <RefreshCw size={13} className={isLoadingModels ? "animate-spin" : ""} />
                  <span>Refresh</span>
                </button>
              </div>

              {/* Ollama Connection Banner */}
              <div className={`p-4 rounded-xl border flex items-center justify-between ${
                ollamaConnected 
                  ? "bg-[#141828] border-blue-500/20 text-slate-200" 
                  : "bg-red-500/10 border-red-500/20 text-red-300"
              }`}>
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${ollamaConnected ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
                  <div>
                    <h3 className="text-xs font-semibold text-white">
                      {ollamaConnected ? "Local Model Runner Connected" : "Local Model Runner Offline"}
                    </h3>
                    <p className="text-2xs text-gray-400 mt-0.5">
                      {ollamaConnected 
                        ? `Ollama API active at http://127.0.0.1:11434 · ${localModels.length} models detected on disk`
                        : "Ollama is not running. Launch Ollama to enable offline model execution."}
                    </p>
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded-md text-2xs font-semibold border ${
                  ollamaConnected 
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                    : "bg-red-500/10 text-red-400 border-red-500/20"
                }`}>
                  {ollamaConnected ? "Connected" : "Disconnected"}
                </span>
              </div>

              {/* Status Alert Banners */}
              {pullSuccess && (
                <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center gap-2">
                  <CheckCircle2 size={14} className="flex-shrink-0" />
                  <span>{pullSuccess}</span>
                </div>
              )}
              {pullError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                  <AlertCircle size={14} className="flex-shrink-0" />
                  <span>{pullError}</span>
                </div>
              )}

              {/* Custom Model Download Bar */}
              <div className="p-4 bg-[#141724] border border-white/5 rounded-xl space-y-2">
                <h3 className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Download size={14} className="text-blue-400" />
                  <span>Pull Any Custom Model</span>
                </h3>
                <p className="text-2xs text-gray-400">
                  Enter any model tag from the Ollama library (e.g. <code className="text-blue-400">qwen2.5-coder:7b</code>, <code className="text-blue-400">deepseek-r1:8b</code>, <code className="text-blue-400">codellama:7b</code>).
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    placeholder="e.g. qwen2.5-coder:14b"
                    value={customModelTag}
                    onChange={(e) => setCustomModelTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customModelTag) handlePullModel(customModelTag);
                    }}
                    className="flex-1 px-3 py-1.5 bg-[#0B0D14] border border-white/10 rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => handlePullModel(customModelTag)}
                    disabled={!customModelTag || !!pullingModel}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition-all"
                  >
                    {pullingModel === customModelTag ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        <span>Pulling...</span>
                      </>
                    ) : (
                      <>
                        <Download size={13} />
                        <span>Download</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Recommended Coding Models Catalog */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles size={13} className="text-blue-400" />
                  <span>Recommended Coding & Agent Models</span>
                </h2>

                <div className="grid grid-cols-1 gap-2.5">
                  {RECOMMENDED_MODELS.map((rec) => {
                    const downloaded = isModelDownloaded(rec.tag);
                    const isActive = activeModelName === rec.tag || activeModelName.startsWith(rec.tag);
                    const isCurrentlyPulling = pullingModel === rec.tag;

                    return (
                      <div
                        key={rec.tag}
                        className={`p-3.5 rounded-xl border transition-all ${
                          isActive
                            ? "bg-[#161B2E] border-blue-500/40 shadow-lg shadow-blue-500/5"
                            : "bg-[#141724] border-white/5 hover:border-white/10"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-white">{rec.name}</span>
                              <span className="font-mono text-3xs px-2 py-0.5 rounded bg-white/5 text-slate-300 border border-white/10">
                                {rec.tag}
                              </span>
                              <span className="text-3xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
                                {rec.recommendedRole}
                              </span>
                            </div>
                            <p className="text-2xs text-gray-400 leading-relaxed">{rec.description}</p>
                            <div className="flex items-center gap-4 text-3xs text-gray-500 pt-0.5">
                              <span className="flex items-center gap-1">
                                <Cpu size={11} /> {rec.paramSize} Parameters
                              </span>
                              <span className="flex items-center gap-1">
                                <HardDrive size={11} /> {rec.estSize}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 flex-shrink-0">
                            {downloaded ? (
                              <button
                                onClick={() => setActiveModelName(rec.tag)}
                                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                  isActive
                                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                                    : "bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10"
                                }`}
                              >
                                {isActive ? (
                                  <>
                                    <Check size={12} />
                                    <span>Active Model</span>
                                  </>
                                ) : (
                                  <span>Select Active</span>
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={() => handlePullModel(rec.tag)}
                                disabled={isCurrentlyPulling}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition-all"
                              >
                                {isCurrentlyPulling ? (
                                  <>
                                    <Loader2 size={12} className="animate-spin" />
                                    <span>Downloading...</span>
                                  </>
                                ) : (
                                  <>
                                    <Download size={12} />
                                    <span>Download</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* All Installed Models On Disk */}
              <div className="space-y-3 pt-2">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                  <HardDrive size={13} className="text-emerald-400" />
                  <span>All Models Currently on Disk ({localModels.length})</span>
                </h2>

                {localModels.length === 0 ? (
                  <div className="p-6 text-center rounded-xl bg-[#141724] border border-white/5 text-gray-400 text-xs">
                    No models found on disk. Use the download buttons above to install your first local AI model.
                  </div>
                ) : (
                  <div className="bg-[#141724] border border-white/5 rounded-xl divide-y divide-white/5">
                    {localModels.map((m) => {
                      const isActive = activeModelName === m.name;
                      return (
                        <div key={m.digest || m.name} className="p-3.5 flex items-center justify-between">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-white">{m.name}</span>
                              {isActive && (
                                <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 text-3xs font-semibold">
                                  Current Default
                                </span>
                              )}
                            </div>
                            <p className="text-2xs text-gray-400">
                              Format: {m.details?.format || "GGUF"} · Quantization: {m.details?.quantization_level || "Q4_K_M"} · Size: {formatBytes(m.size)}
                            </p>
                          </div>
                          <button
                            onClick={() => setActiveModelName(m.name)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                              isActive
                                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                                : "bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10"
                            }`}
                          >
                            {isActive ? "Active" : "Use Model"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ========================================================================= */
            /* ⚙️ GENERAL SETTINGS SCREEN                                                */
            /* ========================================================================= */
            <>
              <div>
                <h1 className="text-lg font-semibold text-white tracking-tight">Teminali Studio Settings</h1>
                <p className="text-xs text-gray-400 mt-1">Configure your local gateway, model execution lanes, and editor preferences.</p>
              </div>

              {/* Section: Account & Gateway Card */}
              <div className="bg-[#141724] border border-white/5 rounded-xl divide-y divide-white/5">
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-semibold text-white">Teminali Local Gateway</h3>
                    <p className="text-2xs text-gray-400 mt-0.5">Running locally at http://127.0.0.1:4310 · Ollama connected</p>
                  </div>
                  <span className="px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">
                    Connected
                  </span>
                </div>

                <div className="p-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-semibold text-white">Model Management & Local Weights</h3>
                    <p className="text-2xs text-gray-400 mt-0.5">
                      Select active coding models or download new models directly to disk.
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveCategory("models")}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-colors"
                  >
                    <Layers size={13} />
                    <span>Manage Models</span>
                  </button>
                </div>
              </div>

              {/* Section: Startup */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Startup & Windows</h2>
                <div className="bg-[#141724] border border-white/5 rounded-xl divide-y divide-white/5">
                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-white">Tips</h3>
                      <p className="text-2xs text-gray-400 mt-0.5">Show rotating tips on the empty screen</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTipsEnabled((prev) => !prev)}
                      className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                        tipsEnabled ? "bg-[#22c55e]" : "bg-[#333333]"
                      }`}
                    >
                      <div
                        className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          tipsEnabled ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-white">Window Restoration</h3>
                      <p className="text-2xs text-gray-400 mt-0.5">Controls which workspace tabs Teminali restores on startup</p>
                    </div>
                    <select className="px-3 py-1.5 bg-[#1B2032] border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none">
                      <option>Restore Active Workspace</option>
                      <option>Restore All Tabs</option>
                      <option>Start Blank</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Section: Notifications */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Notifications</h2>
                <div className="bg-[#141724] border border-white/5 rounded-xl divide-y divide-white/5">
                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-white">System Notifications</h3>
                      <p className="text-2xs text-gray-400 mt-0.5">
                        Show notifications when Teminali agents complete builds
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSystemNotifs((prev) => !prev)}
                      className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                        systemNotifs ? "bg-[#22c55e]" : "bg-[#333333]"
                      }`}
                    >
                      <div
                        className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          systemNotifs ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-semibold text-white">Completion Sound</h3>
                      <p className="text-2xs text-gray-400 mt-0.5">Play audio feedback when tasks pass verification</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCompletionSound((prev) => !prev)}
                      className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                        completionSound ? "bg-[#22c55e]" : "bg-[#333333]"
                      }`}
                    >
                      <div
                        className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                          completionSound ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* Section: Privacy */}
              <div className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Privacy & Security</h2>
                <div className="bg-[#141724] border border-white/5 rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                      <ShieldCheck size={14} className="text-[#22c55e]" />
                      <span>100% Local Execution · Zero Telemetry Exfiltration</span>
                    </div>
                    <p className="text-2xs text-gray-400 mt-0.5">
                      Your codebase, prompt context, and file mutations never leave this machine.
                    </p>
                  </div>
                  <span className="px-2.5 py-1 rounded bg-[#22c55e]/15 text-[#22c55e] border border-[#22c55e]/30 text-2xs font-semibold">
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
