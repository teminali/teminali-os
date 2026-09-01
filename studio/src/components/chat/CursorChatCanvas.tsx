import React, { useState, useRef, useEffect } from "react";
import {
  Mic,
  ArrowUp,
  Square,
  Check,
  Copy,
  ThumbsUp,
  ThumbsDown,
  GitFork,
  ExternalLink,
  MoreHorizontal,
  ChevronDown,
  Search,
  Folder,
  Home,
  Laptop,
  Cloud,
  FolderPlus,
  Loader2,
  Lock,
  Sparkles,
  Zap,
  Plus,
  HelpCircle,
  X,
  Globe,
  Terminal,
  FileText,
  GitPullRequest,
  GitBranch,
  ArrowDown,
  Sliders,
  Paperclip,
  Camera,
  Image as ImageIcon,
} from "lucide-react";
import { useStudioStore, SKILLS_LIST } from "../../store/studioStore";
import { AIService } from "../../services/aiService";
import {
  prepareImageAttachment,
  MAX_IMAGE_ATTACHMENTS,
  dataUrlByteLength,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../../services/attachmentPolicy";
import { CursorStreamingSteps } from "./CursorStreamingSteps";
import { CursorMarkdownRenderer } from "./CursorMarkdownRenderer";
import type { ChatMessage, ModelProfileId, SpecialistSkill } from "../../types";

export const CursorChatCanvas: React.FC<{
  onOpenSplit: (tab?: "terminal" | "editor" | "browser") => void;
  isSplitOpen: boolean;
}> = ({ onOpenSplit, isSplitOpen }) => {
  const {
    frontierMessages,
    addMessageToEngine,
    updateLastMessageInEngine,
    isStreaming,
    setStreaming,
    currentProfile,
    setProfile,
    activeSkill,
    setSkill,
    screenshotToCodeStack,
    setScreenshotToCodeStack,
    setReferenceScreenshotUrl,
    setDiffViewerOpen,
  } = useStudioStore();

  const [inputText, setInputText] = useState("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [isRepoMenuOpen, setIsRepoMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isSkillMenuOpen, setIsSkillMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const activeMessages = (frontierMessages || []).filter(
    (m) =>
      m.role === "user" ||
      (m.role === "assistant" &&
        m.content !==
          "**Frontier session ready.** Select Flash, Auto, or Max in the composer. Max remains locked until qualification passes.")
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [frontierMessages, isStreaming]);

  useEffect(() => {
    if (isStreaming) {
      setElapsedSec(1);
      timerRef.current = window.setInterval(() => {
        setElapsedSec((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isStreaming]);

  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const remaining = Math.max(0, MAX_IMAGE_ATTACHMENTS - attachedImages.length);
    if (remaining === 0) return;
    try {
      const prepared = await Promise.all(files.slice(0, remaining).map(prepareImageAttachment));
      const next = [...attachedImages, ...prepared];
      const totalBytes = next.reduce((sum, image) => sum + dataUrlByteLength(image), 0);
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) return;
      setAttachedImages(next);
      if (prepared.length > 0) {
        setReferenceScreenshotUrl(prepared[0]);
      }
    } catch (err) {
      console.error("Failed to attach image", err);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await addImageFiles(files);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) {
      e.preventDefault();
      await addImageFiles(files);
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setStreaming(false);
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText || inputText).trim();
    if ((!text && attachedImages.length === 0) || isStreaming) return;

    const images = [...attachedImages];
    setInputText("");
    setAttachedImages([]);
    abortControllerRef.current = new AbortController();

    const userMessage: ChatMessage = {
      id: `msg_user_${Date.now()}`,
      role: "user",
      content: text + (images.length ? `\n\n[Attached ${images.length} screenshot${images.length === 1 ? "" : "s"}]` : ""),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      tokensCount: Math.max(1, Math.ceil(text.length / 4)),
    };

    const assistantPlaceholder: ChatMessage = {
      id: `msg_ai_${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      costUsd: 0,
      costLabel: "$0.0000 local",
      tokensCount: 0,
    };

    addMessageToEngine("frontier", userMessage);
    addMessageToEngine("frontier", assistantPlaceholder);
    setStreaming(true);

    try {
      let currentContent = "";
      const skillPayload = activeSkill
        ? { ...activeSkill, stack: screenshotToCodeStack }
        : null;

      await AIService.streamMessage(
        "frontier",
        text || "Analyze the attached screenshot and convert it into code.",
        frontierMessages || [],
        {
          onToken: (token: string) => {
            currentContent += token;
            updateLastMessageInEngine("frontier", () => ({
              content: currentContent,
              tokensCount: Math.max(1, Math.ceil(currentContent.length / 4)),
            }));
          },
          onComplete: (data: any) => {
            updateLastMessageInEngine("frontier", () => ({
              content: data.fullText,
              costUsd: data.costUsd,
              costLabel: data.costLabel,
              tokensCount: data.tokensCount,
              durationSec: data.durationSec,
              engineUsed: data.engineUsed,
            }));
            setStreaming(false);
          },
          onError: (err: Error) => {
            updateLastMessageInEngine("frontier", () => ({
              content: `Error: ${err.message || "Request failed"}`,
            }));
            setStreaming(false);
          },
        },
        images,
        { mode: currentProfile as any, signal: abortControllerRef.current.signal, skill: skillPayload }
      );
    } catch (err: any) {
      updateLastMessageInEngine("frontier", () => ({
        content: `Error: ${err.message || "Failed to contact local engine"}`,
      }));
      setStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  };

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const isEmpty = activeMessages.length === 0;

  const modelLabel =
    currentProfile === "flash"
      ? "Frontier Flash"
      : currentProfile === "max"
      ? "Frontier Max"
      : "Frontier Auto";

  return (
    <div className="flex-1 bg-[#181818] flex flex-col justify-between h-full relative overflow-hidden font-sans text-gray-200">
      {/* Top Header */}
      <header className="h-11 px-4 flex items-center justify-between border-b border-white/5 bg-[#181818] select-none z-20 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-300">Project analysis</span>
          <span className="text-2xs px-1.5 py-0.5 rounded bg-white/5 text-gray-400 font-mono flex items-center gap-1">
            {currentProfile === "max" ? (
              <Lock size={10} className="text-amber-400" />
            ) : (
              <Zap size={10} className="text-[#38bdf8]" />
            )}
            <span>{modelLabel}</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onOpenSplit()}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              isSplitOpen
                ? "bg-[#252525] text-white border-white/10"
                : "bg-transparent text-gray-400 border-transparent hover:bg-white/5 hover:text-white"
            }`}
            title="Toggle IDE Split View (Files, Terminal, Browser)"
          >
            <span>IDE</span>
            <ExternalLink size={13} />
          </button>

          <button className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-white/5 transition-colors">
            <MoreHorizontal size={15} />
          </button>
        </div>
      </header>

      {/* Main Workspace Area with Right Auxiliary Rail */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Chat Scroll View */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 scroll-smooth">
          {isEmpty ? (
            /* Empty State (Exact Match) */
            <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto px-4 pb-12">
              {/* Centered Floating Context Picker */}
              <div className="relative mb-3 flex items-center gap-2 text-xs font-medium text-gray-400">
                <button
                  onClick={() => setIsRepoMenuOpen((prev) => !prev)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-white/5 hover:text-white transition-colors"
                >
                  <span>frontier</span>
                  <ChevronDown size={13} />
                </button>

                <span className="text-gray-600">·</span>

                <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-white/5 hover:text-white transition-colors">
                  <GitBranch size={12} className="text-gray-400" />
                  <span>master</span>
                  <ChevronDown size={13} />
                </button>

                <span className="text-gray-600">·</span>

                <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-white/5 hover:text-white transition-colors">
                  <Laptop size={13} className="text-gray-400" />
                  <span>This Mac</span>
                  <ChevronDown size={13} />
                </button>

                {/* Repo Selector Dropdown Menu */}
                {isRepoMenuOpen && (
                  <div className="absolute top-8 left-0 w-72 bg-[#1f1f1f] border border-white/10 rounded-xl shadow-2xl z-50 p-2 text-xs space-y-2">
                    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#181818] border border-white/5 rounded-lg text-gray-400">
                      <Search size={13} />
                      <input
                        type="text"
                        placeholder="Search folders, repos..."
                        className="bg-transparent text-white focus:outline-none w-full text-xs"
                      />
                    </div>

                    <div>
                      <span className="px-2 text-3xs font-semibold text-gray-500 uppercase tracking-wider">Recents</span>
                      <div className="mt-1 flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-white/5 text-white font-medium">
                        <div className="flex items-center gap-2 truncate">
                          <Folder size={14} className="text-[#38bdf8] flex-shrink-0" />
                          <span className="truncate">~/Documents/my_projects/frontier</span>
                        </div>
                        <Check size={13} className="text-[#38bdf8] flex-shrink-0" />
                      </div>
                    </div>

                    <div>
                      <span className="px-2 text-3xs font-semibold text-gray-500 uppercase tracking-wider">Repos</span>
                      <div className="mt-1 space-y-0.5">
                        <button className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 transition-colors text-left">
                          <Home size={14} className="text-gray-400" />
                          <span>No Repo</span>
                        </button>
                        <button className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 transition-colors text-left">
                          <div className="flex items-center gap-2.5">
                            <Laptop size={14} className="text-gray-400" />
                            <span>On This Mac</span>
                          </div>
                          <span className="text-gray-500">&gt;</span>
                        </button>
                        <button className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 transition-colors text-left">
                          <div className="flex items-center gap-2.5">
                            <Cloud size={14} className="text-gray-400" />
                            <span>Cloud</span>
                          </div>
                          <span className="text-gray-500">&gt;</span>
                        </button>
                        <button className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 transition-colors text-left">
                          <div className="flex items-center gap-2.5">
                            <Folder size={14} className="text-gray-400" />
                            <span>Use Existing...</span>
                          </div>
                          <span className="text-gray-500">&gt;</span>
                        </button>
                        <button className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-gray-300 transition-colors text-left">
                          <FolderPlus size={14} className="text-gray-400" />
                          <span>New Folder</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Centered Large Composer Box */}
              <div className="w-full bg-[#202020] border border-white/10 rounded-2xl p-4 shadow-xl focus-within:border-white/20 transition-all">
                {/* Hidden File Input for Screenshot Upload */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleImageUpload}
                  className="hidden"
                />

                {/* Attached Screenshot Thumbnails */}
                {attachedImages.length > 0 && (
                  <div className="flex items-center gap-2 pb-2.5 mb-2.5 border-b border-white/5 overflow-x-auto">
                    {attachedImages.map((img, idx) => (
                      <div
                        key={idx}
                        className="relative group w-14 h-14 rounded-lg overflow-hidden border border-[#38bdf8]/30 flex-shrink-0 bg-black/40 shadow-md"
                      >
                        <img src={img} alt={`Screenshot ${idx + 1}`} className="w-full h-full object-cover" />
                        <button
                          onClick={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
                          className="absolute top-1 right-1 p-0.5 rounded-full bg-black/80 text-white hover:text-red-400 opacity-90 transition-opacity"
                          title="Remove screenshot"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-14 h-14 rounded-lg border border-dashed border-white/20 hover:border-white/40 flex flex-col items-center justify-center gap-1 text-3xs text-gray-400 hover:text-white transition-colors flex-shrink-0"
                    >
                      <Plus size={12} />
                      <span>Add</span>
                    </button>
                  </div>
                )}

                {/* Target Stack Selector Bar for Screenshot to Code */}
                {activeSkill?.id === "screenshot-to-code" && (
                  <div className="flex items-center gap-1.5 pb-2 mb-2 border-b border-white/5 text-3xs font-mono">
                    <span className="text-gray-500 uppercase tracking-wider text-4xs">Target Stack:</span>
                    <button
                      type="button"
                      onClick={() => setScreenshotToCodeStack("react-tailwind")}
                      className={`px-2 py-0.5 rounded-full border transition-colors ${
                        screenshotToCodeStack === "react-tailwind"
                          ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                          : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                      }`}
                    >
                      React + Tailwind
                    </button>
                    <button
                      type="button"
                      onClick={() => setScreenshotToCodeStack("html-css")}
                      className={`px-2 py-0.5 rounded-full border transition-colors ${
                        screenshotToCodeStack === "html-css"
                          ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                          : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                      }`}
                    >
                      HTML + Vanilla CSS
                    </button>
                    <button
                      type="button"
                      onClick={() => setScreenshotToCodeStack("nextjs")}
                      className={`px-2 py-0.5 rounded-full border transition-colors ${
                        screenshotToCodeStack === "nextjs"
                          ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                          : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                      }`}
                    >
                      Next.js
                    </button>
                    <button
                      type="button"
                      onClick={() => setScreenshotToCodeStack("vue")}
                      className={`px-2 py-0.5 rounded-full border transition-colors ${
                        screenshotToCodeStack === "vue"
                          ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                          : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                      }`}
                    >
                      Vue 3
                    </button>
                  </div>
                )}

                <textarea
                  ref={textareaRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    activeSkill?.id === "screenshot-to-code"
                      ? "Paste or drop screenshots to compile into React/Tailwind code..."
                      : "Ask questions without making changes..."
                  }
                  rows={3}
                  className="w-full bg-transparent text-gray-100 placeholder-gray-500 text-sm focus:outline-none resize-none"
                />

                <div className="flex items-center justify-between pt-2 mt-2 border-t border-white/5 text-xs text-gray-400 relative">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setIsSkillMenuOpen((p) => !p)}
                      className="p-1 text-gray-400 hover:text-white rounded hover:bg-white/5 transition-colors"
                      title="Attach specialist skill"
                    >
                      <Plus size={14} />
                    </button>

                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="p-1 text-gray-400 hover:text-[#38bdf8] rounded hover:bg-white/5 transition-colors"
                      title="Attach screenshot (PNG, JPEG, WebP)"
                    >
                      <Paperclip size={14} />
                    </button>

                    {/* Skill Pill */}
                    {activeSkill ? (
                      <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#38bdf8]/15 text-[#38bdf8] border border-[#38bdf8]/30 text-3xs font-medium whitespace-nowrap flex-shrink-0">
                        <Sliders size={10} />
                        <span className="max-w-[130px] truncate">{activeSkill.name}</span>
                        <X
                          size={10}
                          className="cursor-pointer hover:text-white ml-0.5 opacity-70 hover:opacity-100"
                          onClick={() => setSkill(null)}
                        />
                      </div>
                    ) : (
                      <div
                        onClick={() => setIsSkillMenuOpen((p) => !p)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#15803d]/20 text-[#4ade80] border border-[#22c55e]/25 text-3xs font-medium cursor-pointer whitespace-nowrap flex-shrink-0 hover:bg-[#15803d]/30 transition-colors"
                      >
                        <HelpCircle size={10} />
                        <span>Ask</span>
                      </div>
                    )}

                    {/* Model Selector Pill */}
                    <div className="relative">
                      <button
                        onClick={() => setIsModelMenuOpen((p) => !p)}
                        className="flex items-center gap-1 text-2xs text-gray-300 font-medium hover:text-white px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
                      >
                        {currentProfile === "max" ? (
                          <Lock size={10} className="text-amber-400" />
                        ) : (
                          <Zap size={10} className="text-[#38bdf8]" />
                        )}
                        <span>{modelLabel}</span>
                        <ChevronDown size={10} className="text-gray-500" />
                      </button>

                      {isModelMenuOpen && (
                        <div className="absolute top-8 left-0 w-64 bg-[#1f1f1f] border border-white/10 rounded-xl shadow-2xl z-50 p-1.5 text-xs space-y-1">
                          <button
                            onClick={() => {
                              setProfile("auto");
                              setIsModelMenuOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors ${
                              currentProfile === "auto" ? "bg-white/10 text-white" : "hover:bg-white/5 text-gray-300"
                            }`}
                          >
                            <div className="flex flex-col">
                              <div className="flex items-center gap-1.5 font-semibold text-xs text-white">
                                <Zap size={12} className="text-[#38bdf8]" />
                                <span>Teminali Auto</span>
                              </div>
                              <span className="text-3xs text-gray-400">Flagship adaptive routing ($0.00 local)</span>
                            </div>
                            {currentProfile === "auto" && <Check size={13} className="text-[#38bdf8]" />}
                          </button>

                          <button
                            onClick={() => {
                              setProfile("flash");
                              setIsModelMenuOpen(false);
                            }}
                            className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors ${
                              currentProfile === "flash" ? "bg-white/10 text-white" : "hover:bg-white/5 text-gray-300"
                            }`}
                          >
                            <div className="flex flex-col">
                              <div className="flex items-center gap-1.5 font-semibold text-xs text-white">
                                <Sparkles size={12} className="text-[#38bdf8]" />
                                <span>Teminali Flash</span>
                              </div>
                              <span className="text-3xs text-gray-400">Fast local execution ($0.00 local)</span>
                            </div>
                            {currentProfile === "flash" && <Check size={13} className="text-[#38bdf8]" />}
                          </button>

                          <button
                            disabled
                            className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left opacity-50 cursor-not-allowed bg-transparent text-gray-400"
                          >
                            <div className="flex flex-col">
                              <div className="flex items-center gap-1.5 font-semibold text-xs text-gray-400">
                                <Lock size={12} className="text-amber-400" />
                                <span>Teminali Max</span>
                              </div>
                              <span className="text-3xs text-amber-400/80">Locked until qualification</span>
                            </div>
                            <Lock size={12} className="text-amber-400" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors">
                      <Mic size={15} />
                    </button>
                    <button
                      onClick={() => void handleSend()}
                      disabled={(!inputText.trim() && attachedImages.length === 0) || isStreaming}
                      className="p-1.5 rounded-lg bg-white text-black font-semibold disabled:opacity-30 disabled:bg-gray-700 disabled:text-gray-400 transition-all"
                    >
                      <ArrowUp size={15} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Action suggestion pills below composer */}
              <div className="mt-3 flex items-center gap-2 text-2xs text-gray-400 font-sans flex-wrap">
                {activeSkill?.starterPrompts && activeSkill.starterPrompts.length > 0 ? (
                  activeSkill.starterPrompts.slice(0, 3).map((prompt, idx) => (
                    <button
                      key={idx}
                      onClick={() => void handleSend(prompt)}
                      className="px-3 py-1 rounded-full bg-[#202020] hover:bg-[#282828] border border-white/5 hover:border-[#38bdf8]/30 text-gray-300 transition-colors flex items-center gap-1.5"
                    >
                      <Sparkles size={11} className="text-[#38bdf8]" />
                      <span>{prompt}</span>
                    </button>
                  ))
                ) : (
                  <>
                    <button
                      onClick={() => void handleSend("Plan architecture and design improvements")}
                      className="px-3 py-1 rounded-full bg-[#202020] hover:bg-[#282828] border border-white/5 text-gray-300 transition-colors"
                    >
                      Plan New Idea <span className="text-gray-500 font-mono">⇧Tab</span>
                    </button>
                    <button
                      onClick={() => void handleSend("Run benchmark qualification suite")}
                      className="px-3 py-1 rounded-full bg-[#202020] hover:bg-[#282828] border border-white/5 text-gray-300 transition-colors"
                    >
                      Multitask
                    </button>
                  </>
                )}
              </div>

              <p className="mt-8 text-2xs text-gray-500 text-center font-sans">
                Plugins help you customize Teminali for your workflows - use <code className="px-1.5 py-0.5 rounded bg-white/5 font-mono text-gray-400">/add-plugin</code> to get started
              </p>
            </div>
          ) : (
            /* Populated Chat Stream */
            <div className="max-w-3xl mx-auto space-y-6 pb-28">
              {activeMessages.map((msg, index) => (
                <div key={msg.id} className="space-y-3">
                  {msg.role === "user" ? (
                    /* User Prompt Card */
                    <div className="p-3.5 rounded-2xl bg-[#222222] border border-white/5 text-gray-100 text-sm font-medium leading-relaxed flex flex-col gap-2 shadow-sm">
                      <div>{msg.content}</div>
                      <div className="flex items-center justify-between text-3xs text-gray-500 font-mono pt-1.5 border-t border-white/5 select-none">
                        <span>{msg.timestamp || "just now"}</span>
                        <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400 flex items-center gap-1">
                          <Zap size={9} className="text-[#38bdf8]" />
                          <span>{msg.tokensCount ? `${msg.tokensCount.toLocaleString()} tokens` : `~${Math.max(1, Math.ceil(msg.content.length / 4)).toLocaleString()} tokens`}</span>
                        </span>
                      </div>
                    </div>
                  ) : (
                    /* Assistant Agent Turn */
                    <div className="space-y-4">
                      {/* Live Streaming Step Indicator */}
                      <CursorStreamingSteps
                        elapsedSeconds={elapsedSec || 12}
                        isStreaming={isStreaming && index === activeMessages.length - 1}
                      />

                      {/* Rich Markdown & Code Output */}
                      {msg.content ? (
                        <div className="text-gray-200">
                          <CursorMarkdownRenderer content={msg.content} />
                        </div>
                      ) : (
                        isStreaming && (
                          <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                            <Loader2 size={14} className="animate-spin text-[#38bdf8]" />
                            <span>Frontier Auto is exploring and drafting response...</span>
                          </div>
                        )
                      )}

                      {/* Action Bar with Exact Token Metrics */}
                      {msg.content && (
                        <div className="flex items-center justify-between pt-3 text-2xs text-gray-500 border-t border-white/5 select-none font-mono">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>{msg.timestamp || "just now"}</span>
                            <span className="px-1.5 py-0.5 rounded bg-[#38bdf8]/10 text-[#38bdf8] border border-[#38bdf8]/20 flex items-center gap-1 font-semibold">
                              <Zap size={10} />
                              <span>{msg.tokensCount ? `${msg.tokensCount.toLocaleString()} tokens` : `~${Math.max(1, Math.ceil(msg.content.length / 4)).toLocaleString()} tokens`}</span>
                            </span>
                            {msg.durationSec !== undefined && msg.durationSec > 0 && (
                              <span className="text-gray-400">
                                ({msg.durationSec.toFixed(1)}s{msg.tokensCount ? ` · ${Math.round(msg.tokensCount / msg.durationSec)} t/s` : ""})
                              </span>
                            )}
                            {msg.costLabel && (
                              <span className="text-emerald-400/90 font-medium">{msg.costLabel}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors" title="Good response">
                              <ThumbsUp size={13} />
                            </button>
                            <button className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors" title="Bad response">
                              <ThumbsDown size={13} />
                            </button>
                            <button className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors" title="Fork chat">
                              <GitFork size={13} />
                            </button>
                            <button
                              onClick={() => copyText(msg.id, msg.content)}
                              className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                              title="Copy response"
                            >
                              {copiedId === msg.id ? <Check size={13} className="text-[#10b981]" /> : <Copy size={13} />}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Side Auxiliary Rail ("On frontier") */}
        {!isSplitOpen && (
          <aside className="w-44 bg-[#141414] border-l border-white/5 p-3 flex flex-col gap-3 font-sans text-xs select-none flex-shrink-0 z-10">
            <span className="text-3xs font-semibold text-gray-500 uppercase tracking-wider">On frontier</span>
            <button
              onClick={() => setDiffViewerOpen(true)}
              className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors text-left"
            >
              <GitPullRequest size={13} className="text-gray-400" />
              <span className="truncate">Changes <strong className="text-[#22c55e]">+41325</strong> <strong className="text-[#f43f5e]">-300</strong></span>
            </button>
            <button
              onClick={() => onOpenSplit("browser")}
              className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors text-left"
            >
              <Globe size={13} className="text-[#10b981]" />
              <span>Browser</span>
            </button>
            <button
              onClick={() => onOpenSplit("terminal")}
              className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors text-left"
            >
              <Terminal size={13} className="text-[#38bdf8]" />
              <span>Terminal</span>
            </button>
            <button
              onClick={() => onOpenSplit("editor")}
              className="flex items-center gap-2 text-gray-300 hover:text-white transition-colors text-left"
            >
              <FileText size={13} className="text-gray-400" />
              <span>Files</span>
            </button>
          </aside>
        )}
      </div>

      {/* Floating Action Pills (Commit & Push + Scroll to Bottom) */}
      {!isEmpty && (
        <div className="absolute bottom-24 left-8 z-30 flex items-center gap-2">
          <button
            onClick={() => setDiffViewerOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#222222] hover:bg-[#2a2a2a] border border-white/10 text-xs text-gray-200 shadow-xl transition-colors"
          >
            <span>Commit & Push</span>
            <ChevronDown size={13} />
          </button>
          <button
            onClick={scrollToBottom}
            className="p-1.5 rounded-xl bg-[#222222] hover:bg-[#2a2a2a] border border-white/10 text-gray-400 hover:text-white shadow-xl transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown size={13} />
          </button>
        </div>
      )}

      {/* Floating Bottom Composer Bar (When populated) */}
      {!isEmpty && (
        <div className="p-4 border-t border-white/5 bg-[#181818]/90 backdrop-blur-md flex-shrink-0 z-20">
          <div className="max-w-3xl mx-auto bg-[#202020] border border-white/10 rounded-2xl p-3 shadow-xl focus-within:border-white/20 transition-all space-y-2">
            {/* Attached Screenshot Thumbnails in Bottom Composer */}
            {attachedImages.length > 0 && (
              <div className="flex items-center gap-2 pb-2 mb-1 border-b border-white/5 overflow-x-auto">
                {attachedImages.map((img, idx) => (
                  <div
                    key={idx}
                    className="relative group w-12 h-12 rounded-lg overflow-hidden border border-[#38bdf8]/30 flex-shrink-0 bg-black/40 shadow-md"
                  >
                    <img src={img} alt={`Screenshot ${idx + 1}`} className="w-full h-full object-cover" />
                    <button
                      onClick={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
                      className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/80 text-white hover:text-red-400 opacity-90 transition-opacity"
                      title="Remove screenshot"
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-12 h-12 rounded-lg border border-dashed border-white/20 hover:border-white/40 flex flex-col items-center justify-center gap-0.5 text-3xs text-gray-400 hover:text-white transition-colors flex-shrink-0"
                >
                  <Plus size={11} />
                  <span>Add</span>
                </button>
              </div>
            )}

            {/* Target Stack Selector Bar for Screenshot to Code in Bottom Composer */}
            {activeSkill?.id === "screenshot-to-code" && (
              <div className="flex items-center gap-1.5 pb-1 mb-1 border-b border-white/5 text-4xs font-mono">
                <span className="text-gray-500 uppercase tracking-wider">Stack:</span>
                <button
                  type="button"
                  onClick={() => setScreenshotToCodeStack("react-tailwind")}
                  className={`px-1.5 py-0.5 rounded-full border transition-colors ${
                    screenshotToCodeStack === "react-tailwind"
                      ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                  }`}
                >
                  React + Tailwind
                </button>
                <button
                  type="button"
                  onClick={() => setScreenshotToCodeStack("html-css")}
                  className={`px-1.5 py-0.5 rounded-full border transition-colors ${
                    screenshotToCodeStack === "html-css"
                      ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                  }`}
                >
                  HTML + CSS
                </button>
                <button
                  type="button"
                  onClick={() => setScreenshotToCodeStack("nextjs")}
                  className={`px-1.5 py-0.5 rounded-full border transition-colors ${
                    screenshotToCodeStack === "nextjs"
                      ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                  }`}
                >
                  Next.js
                </button>
                <button
                  type="button"
                  onClick={() => setScreenshotToCodeStack("vue")}
                  className={`px-1.5 py-0.5 rounded-full border transition-colors ${
                    screenshotToCodeStack === "vue"
                      ? "bg-[#38bdf8]/20 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                      : "bg-white/5 text-gray-400 border-white/10 hover:text-white"
                  }`}
                >
                  Vue 3
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsSkillMenuOpen((p) => !p)}
                className="p-1 text-gray-400 hover:text-white rounded hover:bg-white/5"
                title="Attach specialist skill"
              >
                <Plus size={14} />
              </button>

              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1 text-gray-400 hover:text-[#38bdf8] rounded hover:bg-white/5"
                title="Attach screenshot (PNG, JPEG, WebP)"
              >
                <Paperclip size={14} />
              </button>

              {activeSkill && (
                <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#38bdf8]/15 text-[#38bdf8] border border-[#38bdf8]/30 text-3xs font-medium whitespace-nowrap flex-shrink-0">
                  <Sliders size={10} />
                  <span className="max-w-[130px] truncate">{activeSkill.name}</span>
                  <X
                    size={10}
                    className="cursor-pointer hover:text-white ml-0.5 opacity-70 hover:opacity-100"
                    onClick={() => setSkill(null)}
                  />
                </div>
              )}

              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  activeSkill?.id === "screenshot-to-code"
                    ? "Paste or drop screenshots to compile into React/Tailwind code..."
                    : "Ask questions without making changes..."
                }
                rows={1}
                className="w-full bg-transparent text-gray-100 placeholder-gray-500 text-xs focus:outline-none resize-none pt-0.5"
              />

              <div className="flex items-center gap-2 flex-shrink-0 relative">
                <button
                  onClick={() => setIsModelMenuOpen((p) => !p)}
                  className="flex items-center gap-1 text-2xs text-gray-300 font-medium hover:text-white px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
                >
                  {currentProfile === "max" ? (
                    <Lock size={10} className="text-amber-400" />
                  ) : (
                    <Zap size={10} className="text-[#38bdf8]" />
                  )}
                  <span>{modelLabel}</span>
                  <ChevronDown size={10} className="text-gray-500" />
                </button>

                {isModelMenuOpen && (
                  <div className="absolute bottom-8 right-0 w-64 bg-[#1f1f1f] border border-white/10 rounded-xl shadow-2xl z-50 p-1.5 text-xs space-y-1">
                    <button
                      onClick={() => {
                        setProfile("auto");
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors ${
                        currentProfile === "auto" ? "bg-white/10 text-white" : "hover:bg-white/5 text-gray-300"
                      }`}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5 font-semibold text-xs text-white">
                          <Zap size={12} className="text-[#38bdf8]" />
                          <span>Teminali Auto</span>
                        </div>
                        <span className="text-3xs text-gray-400">Flagship adaptive routing ($0.00 local)</span>
                      </div>
                      {currentProfile === "auto" && <Check size={13} className="text-[#38bdf8]" />}
                    </button>

                    <button
                      onClick={() => {
                        setProfile("flash");
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left transition-colors ${
                        currentProfile === "flash" ? "bg-white/10 text-white" : "hover:bg-white/5 text-gray-300"
                      }`}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5 font-semibold text-xs text-white">
                          <Sparkles size={12} className="text-[#38bdf8]" />
                          <span>Teminali Flash</span>
                        </div>
                        <span className="text-3xs text-gray-400">Fast local execution ($0.00 local)</span>
                      </div>
                      {currentProfile === "flash" && <Check size={13} className="text-[#38bdf8]" />}
                    </button>

                    <button
                      disabled
                      className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-left opacity-50 cursor-not-allowed bg-transparent text-gray-400"
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5 font-semibold text-xs text-gray-400">
                          <Lock size={12} className="text-amber-400" />
                          <span>Teminali Max</span>
                        </div>
                        <span className="text-3xs text-amber-400/80">Locked until qualification</span>
                      </div>
                      <Lock size={12} className="text-amber-400" />
                    </button>
                  </div>
                )}

                <button className="p-1 text-gray-400 hover:text-white rounded hover:bg-white/5 transition-colors">
                  <Mic size={14} />
                </button>

                {isStreaming ? (
                  <button
                    onClick={handleStop}
                    className="p-1.5 rounded-lg bg-white text-black font-semibold hover:bg-gray-200 transition-all shadow-md"
                    title="Stop generation"
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    onClick={() => void handleSend()}
                    disabled={(!inputText.trim() && attachedImages.length === 0) || isStreaming}
                    className="p-1.5 rounded-lg bg-white text-black font-semibold disabled:opacity-30 disabled:bg-gray-700 disabled:text-gray-400 transition-all shadow-md"
                  >
                    <ArrowUp size={13} />
                  </button>
                )}
              </div>
            </div>

            {/* Bottom Bar: master · This Mac · spinner */}
            <div className="flex items-center justify-between text-3xs text-gray-500 border-t border-white/5 pt-1.5">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  <GitBranch size={11} className="text-gray-500" />
                  <span>master</span>
                </div>
                <span>·</span>
                <div className="flex items-center gap-1">
                  <Laptop size={11} />
                  <span>This Mac</span>
                </div>
              </div>
              {isStreaming && (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-[#38bdf8] border-t-transparent animate-spin" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
