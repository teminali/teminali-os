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
  RotateCcw,
  AlertCircle,
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

function detectAndOpenWebArtifacts(
  fullText: string,
  openFile: (file: any) => void,
  openBrowserPreview: (urlOrPath?: string) => void
) {
  if (!fullText) return;

  // 1. Detect localhost or preview URLs
  const urlMatch = fullText.match(/\b(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s)\"'`*]*)?|\/preview\/[^\s)\"'`*]+\.html)/i);
  if (urlMatch) {
    const detectedUrl = urlMatch[1];
    openBrowserPreview(detectedUrl);
  }

  // 2. Detect code blocks with path="..." or html/css/js blocks
  const codeBlockRegex = /```(?:([a-zA-Z0-9_-]+)(?:\s+path=["']?([^"'\\s]+)["']?)?)?\n([\s\S]*?)```/g;
  let blockMatch: RegExpExecArray | null;
  const parsedFiles: Array<{ name: string; path: string; content: string; language: string }> = [];

  while ((blockMatch = codeBlockRegex.exec(fullText)) !== null) {
    const lang = blockMatch[1]?.toLowerCase() || "";
    const explicitPath = blockMatch[2] || "";
    const content = blockMatch[3];

    let path = explicitPath;
    let name = explicitPath.split("/").pop() || explicitPath;

    if (!path) {
      if (lang === "html" || content.includes("<!DOCTYPE") || content.includes("<html")) {
        path = "index.html";
        name = "index.html";
      } else if (lang === "css" || content.includes("@keyframes") || content.includes("body {")) {
        path = "styles.css";
        name = "styles.css";
      } else if (lang === "javascript" || lang === "js") {
        path = "scripts.js";
        name = "scripts.js";
      }
    }

    if (path && content.trim()) {
      parsedFiles.push({
        path,
        name: name || path,
        content,
        language: lang === "js" ? "javascript" : lang || "plaintext",
      });
    }
  }

  // Open all generated files in the workspace
  for (const f of parsedFiles) {
    openFile({
      path: f.path,
      name: f.name,
      content: f.content,
      language: f.language,
      encoding: "utf8",
    });
  }

  // Automatically open the built-in browser if an HTML file was created
  const htmlFile = parsedFiles.find((f) => f.path.endsWith(".html") || f.path.endsWith(".htm"));
  if (htmlFile) {
    openBrowserPreview(htmlFile.path);
  }
}

export const CursorChatCanvas: React.FC<{
  isSplitOpen: boolean;
  onOpenSplit: (tab?: "terminal" | "editor" | "browser") => void;
}> = ({ isSplitOpen, onOpenSplit }) => {
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
    openFile,
    openBrowserPreview,
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
  const abortControllerRef = useRef<AbortController | null>(null);

  const activeMessages = frontierMessages || [];

  // Elapsed timer during streaming
  useEffect(() => {
    let timer: any;
    if (isStreaming) {
      setElapsedSec(0);
      timer = setInterval(() => setElapsedSec((p) => p + 1), 1000);
    } else {
      setElapsedSec(0);
    }
    return () => clearInterval(timer);
  }, [isStreaming]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages, isStreaming]);

  // Image paste handler
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          try {
            const dataUrl = await prepareImageAttachment(file);
            setAttachedImages((prev) => {
              if (prev.length >= MAX_IMAGE_ATTACHMENTS) return prev;
              return [...prev, dataUrl];
            });
            setReferenceScreenshotUrl(dataUrl);
          } catch (err: any) {
            console.warn("Screenshot paste error:", err);
          }
        }
      }
    }
  };

  // Image upload handler
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const dataUrl = await prepareImageAttachment(file);
        setAttachedImages((prev) => {
          if (prev.length >= MAX_IMAGE_ATTACHMENTS) return prev;
          return [...prev, dataUrl];
        });
        setReferenceScreenshotUrl(dataUrl);
      } catch (err: any) {
        console.warn("Screenshot upload error:", err);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStreaming(false);
  };

  const handleSend = async (overrideText?: string) => {
    const text = overrideText !== undefined ? overrideText : inputText;
    if ((!text.trim() && attachedImages.length === 0) || isStreaming) return;

    const images = [...attachedImages];
    setInputText("");
    setAttachedImages([]);
    abortControllerRef.current = new AbortController();

    const userMessage: Omit<ChatMessage, "id" | "timestamp"> = {
      role: "user",
      content: text,
      images: images.length > 0 ? images : undefined,
      tokensCount: Math.max(1, Math.ceil(text.length / 4)),
    };

    const assistantPlaceholder: Omit<ChatMessage, "id" | "timestamp"> = {
      role: "assistant",
      content: "",
      tokensCount: 0,
      costUsd: 0,
      costLabel: "$0.00",
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
            detectAndOpenWebArtifacts(data.fullText, openFile, openBrowserPreview);
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

  // Last user prompt for retry
  const lastUserMsg = [...activeMessages].reverse().find((m) => m.role === "user");

  return (
    <div className="flex-1 bg-[#0d0f17] flex flex-col justify-between h-full relative overflow-hidden font-sans text-gray-200 select-none">
      {/* ── Top Header Bar ──────────────────────────────────────────────── */}
      <header className="h-10 px-3.5 flex items-center justify-between border-b border-white/5 bg-[#0e1017] select-none z-20 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-200">Chat</span>
          <span className="text-3xs px-2 py-0.5 rounded-full bg-[#141724] border border-white/10 text-gray-300 font-mono flex items-center gap-1">
            {currentProfile === "max" ? (
              <Lock size={10} className="text-amber-400" />
            ) : (
              <Zap size={10} className="text-[#38bdf8]" />
            )}
            <span>{modelLabel}</span>
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onOpenSplit()}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
              isSplitOpen
                ? "bg-[#1f2438] text-[#38bdf8] border-[#38bdf8]/30 shadow-sm"
                : "bg-transparent text-gray-400 border-transparent hover:bg-white/5 hover:text-white"
            }`}
            title="Toggle Split View (Browser, Terminal, Editor)"
          >
            <span>Preview & IDE</span>
            <ExternalLink size={12} />
          </button>
        </div>
      </header>

      {/* ── Main Chat Scroll View ───────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden relative">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 scroll-smooth">
          {isEmpty ? (
            /* Empty State */
            <div className="h-full flex flex-col items-center justify-center max-w-xl mx-auto px-2 pb-8 text-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-b from-[#38bdf8]/20 to-transparent border border-[#38bdf8]/30 flex items-center justify-center mb-4 text-[#38bdf8] shadow-lg shadow-[#38bdf8]/10">
                <Sparkles size={24} />
              </div>
              <h2 className="text-base font-semibold text-white mb-1 tracking-tight">Teminali Autonomous Studio</h2>
              <p className="text-xs text-gray-400 max-w-sm mb-6 leading-relaxed">
                Build apps, ask architecture questions, or paste screenshots to turn designs into live code.
              </p>

              {/* Starter Quick Actions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md text-left">
                <button
                  onClick={() => void handleSend("Build a modern landing page with dark glassmorphism and an order button")}
                  className="p-3 rounded-xl bg-[#141724] border border-white/10 hover:border-[#38bdf8]/40 hover:bg-[#1a1e30] transition-all text-xs group"
                >
                  <div className="font-semibold text-gray-200 group-hover:text-white flex items-center gap-1.5">
                    <Globe size={13} className="text-[#38bdf8]" />
                    <span>Build Web App</span>
                  </div>
                  <div className="text-3xs text-gray-400 mt-1">Generate modern HTML/CSS/JS with live browser preview</div>
                </button>

                <button
                  onClick={() => void handleSend("Analyze project structure and suggest improvements")}
                  className="p-3 rounded-xl bg-[#141724] border border-white/10 hover:border-[#38bdf8]/40 hover:bg-[#1a1e30] transition-all text-xs group"
                >
                  <div className="font-semibold text-gray-200 group-hover:text-white flex items-center gap-1.5">
                    <Zap size={13} className="text-emerald-400" />
                    <span>Code Exploration</span>
                  </div>
                  <div className="text-3xs text-gray-400 mt-1">Autonomous reasoning on local workspace files</div>
                </button>
              </div>
            </div>
          ) : (
            /* Populated Message Stream */
            <div className="max-w-2xl mx-auto space-y-4 pb-20 select-text">
              {activeMessages.map((msg, index) => {
                const isError = msg.content?.startsWith("Error:");
                return (
                  <div key={msg.id} className="space-y-2">
                    {msg.role === "user" ? (
                      /* User Prompt Bubble */
                      <div className="p-3 rounded-xl bg-[#141724] border border-white/10 text-gray-100 text-xs font-normal leading-relaxed shadow-sm">
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                        {msg.images && msg.images.length > 0 && (
                          <div className="flex gap-2 mt-2 pt-2 border-t border-white/5 overflow-x-auto">
                            {msg.images.map((img, i) => (
                              <img key={i} src={img} alt="Attached" className="h-16 rounded border border-white/10 object-cover" />
                            ))}
                          </div>
                        )}
                        <div className="flex items-center justify-between text-3xs text-gray-500 font-mono pt-1.5 border-t border-white/5 select-none mt-2">
                          <span>{msg.timestamp || "just now"}</span>
                          <span className="px-1.5 py-0.2 rounded bg-white/5 text-gray-400">
                            {msg.tokensCount ? `${msg.tokensCount} tokens` : "user"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      /* Assistant Response */
                      <div className="space-y-2">
                        {/* Live Streaming Step Indicator */}
                        <CursorStreamingSteps
                          elapsedSeconds={elapsedSec}
                          isStreaming={isStreaming && index === activeMessages.length - 1}
                        />

                        {/* Error Card */}
                        {isError ? (
                          <div className="p-3.5 rounded-xl bg-rose-950/30 border border-rose-500/30 text-rose-200 text-xs space-y-2">
                            <div className="flex items-center gap-2 font-semibold text-rose-300">
                              <AlertCircle size={14} className="text-rose-400 flex-shrink-0" />
                              <span>Local Inference Notice</span>
                            </div>
                            <p className="text-xs text-rose-300/90 leading-relaxed font-sans">
                              {msg.content.replace(/^Error:\s*/, "")}
                            </p>
                            {lastUserMsg && (
                              <button
                                onClick={() => void handleSend(lastUserMsg.content)}
                                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-xs text-rose-200 font-medium transition-colors"
                              >
                                <RotateCcw size={12} />
                                <span>Retry Request</span>
                              </button>
                            )}
                          </div>
                        ) : (
                          /* Rich Markdown & Code */
                          msg.content ? (
                            <div className="text-gray-200 text-xs">
                              <CursorMarkdownRenderer content={msg.content} />
                            </div>
                          ) : (
                            isStreaming && (
                              <div className="flex items-center gap-2 text-xs text-gray-400 py-1.5 font-mono">
                                <Loader2 size={13} className="animate-spin text-[#38bdf8]" />
                                <span>Generating response…</span>
                              </div>
                            )
                          )
                        )}

                        {/* Action Bar & Token Stats */}
                        {msg.content && !isError && (
                          <div className="flex items-center justify-between pt-2 text-3xs text-gray-500 border-t border-white/5 select-none font-mono flex-wrap gap-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span>{msg.timestamp || "just now"}</span>
                              <span className="px-1.5 py-0.5 rounded bg-[#38bdf8]/10 text-[#38bdf8] border border-[#38bdf8]/20 flex items-center gap-1 font-semibold">
                                <Zap size={9} />
                                <span>{msg.tokensCount ? `${msg.tokensCount.toLocaleString()} tokens` : ""}</span>
                              </span>
                              {msg.durationSec !== undefined && msg.durationSec > 0 && (
                                <span className="text-gray-400">
                                  {msg.durationSec.toFixed(1)}s{msg.tokensCount ? ` · ${Math.round(msg.tokensCount / msg.durationSec)} t/s` : ""}
                                </span>
                              )}
                              <span className="text-emerald-400/90 font-medium">$0.00 local</span>
                            </div>

                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => copyText(msg.id, msg.content)}
                                className="p-1 hover:text-white rounded hover:bg-white/5 transition-colors"
                                title="Copy response"
                              >
                                {copiedId === msg.id ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom Composer (Always Responsive) ─────────────────────────── */}
      <div className="p-2 sm:p-3 border-t border-white/5 bg-[#0a0c13]/95 backdrop-blur-md flex-shrink-0 z-20">
        <div className="max-w-2xl mx-auto bg-[#141724] border border-white/10 focus-within:border-[#38bdf8]/40 rounded-xl p-2 shadow-xl transition-all space-y-1.5">
          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={handleImageUpload}
            className="hidden"
          />

          {/* Attached Thumbnails */}
          {attachedImages.length > 0 && (
            <div className="flex items-center gap-1.5 pb-1.5 border-b border-white/5 overflow-x-auto">
              {attachedImages.map((img, idx) => (
                <div
                  key={idx}
                  className="relative group w-12 h-12 rounded-lg overflow-hidden border border-[#38bdf8]/40 flex-shrink-0 bg-black/40 shadow"
                >
                  <img src={img} alt={`Screenshot ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    onClick={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
                    className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/80 text-white hover:text-rose-400"
                    title="Remove attachment"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-12 h-12 rounded-lg border border-dashed border-white/20 hover:border-white/40 flex flex-col items-center justify-center gap-0.5 text-3xs text-gray-400 hover:text-white flex-shrink-0"
              >
                <Plus size={11} />
                <span>Add</span>
              </button>
            </div>
          )}

          {/* Text Area */}
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask Teminali or type instructions (Shift+Enter for newline)..."
            rows={2}
            className="w-full bg-transparent text-gray-100 placeholder-gray-500 text-xs focus:outline-none resize-none leading-relaxed"
          />

          {/* Bottom Controls Row */}
          <div className="flex items-center justify-between pt-1 border-t border-white/5 text-xs text-gray-400 select-none gap-1 flex-wrap">
            {/* Left Tools: Attach, Model Picker */}
            <div className="flex items-center gap-1 flex-wrap">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1 text-gray-400 hover:text-[#38bdf8] rounded hover:bg-white/5 transition-colors"
                title="Attach Screenshot (PNG, JPG, WebP)"
              >
                <Paperclip size={13} />
              </button>

              {/* Model Selector Pill */}
              <div className="relative">
                <button
                  onClick={() => setIsModelMenuOpen((p) => !p)}
                  className="flex items-center gap-1 text-3xs text-gray-300 font-medium hover:text-white px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
                >
                  <Zap size={10} className="text-[#38bdf8]" />
                  <span>{modelLabel}</span>
                  <ChevronDown size={9} className="text-gray-500" />
                </button>

                {isModelMenuOpen && (
                  <div className="absolute bottom-8 left-0 w-56 bg-[#181b26] border border-white/10 rounded-xl shadow-2xl z-50 p-1 text-xs space-y-1">
                    <button
                      onClick={() => {
                        setProfile("auto");
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition-colors ${
                        currentProfile === "auto" ? "bg-[#38bdf8]/20 text-white" : "hover:bg-white/5 text-gray-300"
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold text-xs text-white">Teminali Auto</span>
                        <span className="text-3xs text-gray-400">Adaptive local routing</span>
                      </div>
                      {currentProfile === "auto" && <Check size={12} className="text-[#38bdf8]" />}
                    </button>

                    <button
                      onClick={() => {
                        setProfile("flash");
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition-colors ${
                        currentProfile === "flash" ? "bg-[#38bdf8]/20 text-white" : "hover:bg-white/5 text-gray-300"
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold text-xs text-white">Teminali Flash</span>
                        <span className="text-3xs text-gray-400">Fast local generation</span>
                      </div>
                      {currentProfile === "flash" && <Check size={12} className="text-[#38bdf8]" />}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Send / Stop */}
            <div className="flex items-center gap-1">
              {isStreaming ? (
                <button
                  onClick={handleStop}
                  className="px-2.5 py-1 rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 text-xs font-semibold flex items-center gap-1 transition-all"
                  title="Stop generating"
                >
                  <Square size={11} fill="currentColor" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!inputText.trim() && attachedImages.length === 0}
                  className="p-1.5 rounded-lg bg-[#38bdf8] text-black font-semibold hover:bg-sky-400 disabled:opacity-30 disabled:bg-gray-800 disabled:text-gray-500 transition-all shadow-sm"
                  title="Send message"
                >
                  <ArrowUp size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
