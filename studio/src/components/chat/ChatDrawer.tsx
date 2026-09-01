import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  LockKeyhole,
  Paperclip,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { PROFILES_LIST, useStudioStore } from "../../store/studioStore";
import { AIService } from "../../services/aiService";
import {
  dataUrlByteLength,
  IMAGE_ATTACHMENT_HELP,
  IMAGE_ATTACHMENTS_AVAILABLE,
  MAX_IMAGE_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  prepareImageAttachment,
} from "../../services/attachmentPolicy";
import {
  FrontierModeStatus,
  GatewayClient,
  GatewayError,
} from "../../services/gatewayClient";
import {
  GodAgentSwarmService,
  GodAgentSynthesis,
  SwarmWorkerState,
} from "../../services/godAgentSwarmService";
import type { ModelModeId, ToolCall } from "../../types";
import { AIMessageFormatter } from "./AIMessageFormatter";
import { ThoughtProcessViewer } from "./ThoughtProcessViewer";
import { ToolCallCard } from "./ToolCallCard";
import "./frontierCopilot.css";

const STREAM_FLUSH_MS = 50;

function titleCaseMode(mode: ModelModeId): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function routeSummary(reason: string): string {
  if (reason === "expert_pending_qualification" || reason === "auto_light_task") return "Auto routed to Flash";
  if (reason === "auto_complex_task") return "Auto routed to Max";
  if (reason === "flash_always_light") return "Flash route";
  if (reason === "max_always_heavy") return "Max route";
  return "Local route";
}

function publicEngineLabel(engineUsed: string): string {
  if (engineUsed.startsWith("Frontier Flash")) return "Frontier Flash · Flash route";
  if (engineUsed.startsWith("Frontier Max")) return "Frontier Max · Max route";
  if (engineUsed.startsWith("Frontier Auto")) {
    return engineUsed.includes("Max")
      ? "Frontier Auto · Auto routed to Max"
      : "Frontier Auto · Auto routed to Flash";
  }

  // Persisted conversations may predate the public Frontier tier names. Never
  // leak provider or underlying model identities back into the product UI.
  return "Frontier Auto · Local route";
}

function mergeToolCall(current: ToolCall[] = [], next: ToolCall): ToolCall[] {
  const index = current.findIndex((tool) => tool.id === next.id);
  if (index < 0) return [...current, next];
  const copy = [...current];
  copy[index] = { ...copy[index], ...next };
  return copy;
}

export const ChatDrawer: React.FC<{ onMinimize?: () => void }> = () => {
  const [message, setMessage] = useState("");
  const [dispatchNote, setDispatchNote] = useState("");
  const [panelMode, setPanelMode] = useState<"ai" | "swarm">("ai");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [activeWorkers, setActiveWorkers] = useState<SwarmWorkerState[]>([]);
  const [godSynthesis, setGodSynthesis] = useState<GodAgentSynthesis | null>(null);
  const [isSwarmRunning, setIsSwarmRunning] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [liveElapsedSec, setLiveElapsedSec] = useState(0);
  const [modeStatus, setModeStatus] = useState<FrontierModeStatus | null>(null);
  const [modeStatusError, setModeStatusError] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const streamBufferRef = useRef("");
  const streamedTextRef = useRef("");

  const {
    frontierMessages,
    addMessageToEngine,
    updateLastMessageInEngine,
    clearEngineSession,
    isStreaming,
    setStreaming,
    updateTabContent,
    activeTabId,
    tabs,
    currentProfile,
    setProfile,
  } = useStudioStore();

  const maxAvailable = modeStatus?.maxQualified === true;
  const selectedProfile = PROFILES_LIST.find((profile) => profile.id === currentProfile) ?? PROFILES_LIST[1];

  useEffect(() => {
    let active = true;
    GatewayClient.getFrontierStatus()
      .then((status) => {
        if (!active) return;
        setModeStatus(status);
        setModeStatusError(false);
        if (useStudioStore.getState().currentProfile === "max" && !status.maxQualified) setProfile("auto");
      })
      .catch(() => {
        if (!active) return;
        setModeStatusError(true);
      });
    return () => {
      active = false;
    };
  }, [setProfile]);

  useEffect(() => {
    if (isStreaming) {
      const started = performance.now();
      setLiveElapsedSec(0);
      timerRef.current = window.setInterval(() => {
        setLiveElapsedSec(Number(((performance.now() - started) / 1000).toFixed(1)));
      }, 250);
    } else if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [isStreaming]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && followOutputRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [frontierMessages, activeWorkers, isStreaming]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);

  const flushBufferedTokens = useCallback(() => {
    flushTimerRef.current = null;
    if (!streamBufferRef.current) return;
    streamedTextRef.current += streamBufferRef.current;
    streamBufferRef.current = "";
    const content = streamedTextRef.current;
    updateLastMessageInEngine("frontier", () => ({ content }));
  }, [updateLastMessageInEngine]);

  const queueToken = useCallback((token: string) => {
    streamBufferRef.current += token;
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(flushBufferedTokens, STREAM_FLUSH_MS);
    }
  }, [flushBufferedTokens]);

  const handleScroll = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    followOutputRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64;
  };

  const handleCopyMessage = (content: string, id: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedMessageId(id);
    window.setTimeout(() => setCopiedMessageId(null), 1600);
  };

  const handleApplyToEditor = (code: string) => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
    if (activeTab) updateTabContent(activeTab.id, code);
  };

  const addImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (!IMAGE_ATTACHMENTS_AVAILABLE) {
      setDispatchNote("The local vision route is unavailable");
      return;
    }

    const remaining = Math.max(0, MAX_IMAGE_ATTACHMENTS - attachedImages.length);
    if (remaining === 0) {
      setDispatchNote(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images`);
      return;
    }

    try {
      const prepared = await Promise.all(files.slice(0, remaining).map(prepareImageAttachment));
      const next = [...attachedImages, ...prepared];
      const totalBytes = next.reduce((sum, image) => sum + dataUrlByteLength(image), 0);
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        setDispatchNote("Attachments are too large together; remove one or choose smaller images");
        return;
      }
      setAttachedImages(next);
      setDispatchNote(`${prepared.length} image${prepared.length === 1 ? "" : "s"} ready for local vision`);
    } catch (error) {
      setDispatchNote(error instanceof Error ? error.message : "The image could not be attached");
    }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await addImageFiles(files);
  };

  const launchSwarm = async (promptText: string) => {
    const tasks = promptText.split(";").map((task) => task.trim()).filter(Boolean);
    if (tasks.length === 0 || isSwarmRunning) return;
    setIsSwarmRunning(true);
    setGodSynthesis(null);
    setDispatchNote("Running sequential local reviewers");
    try {
      await GodAgentSwarmService.executeSwarmPipeline(
        tasks,
        setActiveWorkers,
        setGodSynthesis,
      );
    } finally {
      setIsSwarmRunning(false);
      setDispatchNote("Swarm review finished");
    }
  };

  const sendMessage = async (customPrompt?: string) => {
    const promptText = (customPrompt ?? message).trim();
    if ((!promptText && attachedImages.length === 0) || isStreaming || isSwarmRunning) return;
    if (panelMode === "swarm") {
      setMessage("");
      await launchSwarm(promptText);
      return;
    }
    if (currentProfile === "max" && !maxAvailable) {
      setDispatchNote("Max is locked; select Auto or Flash");
      return;
    }

    const images = [...attachedImages];
    const history = frontierMessages;
    setMessage("");
    setAttachedImages([]);
    setDispatchNote(`Sent to Frontier ${titleCaseMode(currentProfile)}`);
    followOutputRef.current = true;
    streamBufferRef.current = "";
    streamedTextRef.current = "";

    addMessageToEngine("frontier", {
      role: "user",
      content: promptText + (images.length ? `\n\n[Attached ${images.length} image${images.length === 1 ? "" : "s"}]` : ""),
      costUsd: 0,
      costLabel: "$0.00 local",
      mode: currentProfile,
    });
    addMessageToEngine("frontier", {
      role: "assistant",
      content: "",
      isStreaming: true,
      costLabel: "$0.0000 local",
      mode: currentProfile,
    });

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    await AIService.streamMessage(
      "frontier",
      promptText,
      history,
      {
        onToken: queueToken,
        onToolCall: (toolCall) => {
          updateLastMessageInEngine("frontier", (previous) => ({
            toolCalls: mergeToolCall(previous.toolCalls, toolCall),
          }));
        },
        onComplete: (data) => {
          if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
          streamBufferRef.current = "";
          streamedTextRef.current = data.fullText;
          setStreaming(false);
          abortRef.current = null;
          setDispatchNote(routeSummary(data.routeReason));
          updateLastMessageInEngine("frontier", () => ({
            content: data.fullText,
            costUsd: data.costUsd,
            costLabel: data.costLabel,
            tokensCount: data.tokensCount,
            durationSec: data.durationSec,
            engineUsed: data.engineUsed,
            telemetry: data.telemetry,
            mode: data.mode,
            routeReason: data.routeReason,
            isStreaming: false,
          }));
        },
        onError: (error) => {
          if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
          if (streamBufferRef.current) {
            streamedTextRef.current += streamBufferRef.current;
            streamBufferRef.current = "";
          }
          const cancelled = error instanceof GatewayError && error.code === "INFERENCE_CANCELLED";
          const existing = streamedTextRef.current.trimEnd();
          setStreaming(false);
          abortRef.current = null;
          setDispatchNote(cancelled ? "Generation stopped" : "Request failed with evidence preserved");
          updateLastMessageInEngine("frontier", () => ({
            content: cancelled
              ? `${existing}${existing ? "\n\n" : ""}_Generation stopped by you._`
              : `${existing}${existing ? "\n\n" : ""}Request failed: ${error.message || "Unknown runtime failure."}`,
            errorCode: error instanceof GatewayError ? error.code : "INFERENCE_ERROR",
            cancelled,
            isStreaming: false,
          }));
        },
      },
      images,
      { mode: currentProfile, signal: controller.signal },
    );
  };

  const stopStreaming = () => {
    if (!abortRef.current) return;
    setDispatchNote("Stopping safely and releasing model memory…");
    abortRef.current.abort();
  };

  const clearSession = () => {
    if (isStreaming) return;
    clearEngineSession("frontier");
    setDispatchNote("Session cleared");
  };

  return (
    <aside className="assistant-panel frontier-copilot" aria-label="Frontier Copilot">
      <header className="assistant-head copilot-header">
        <div className="copilot-title-group">
          <span className={`copilot-status-dot ${modeStatusError ? "offline" : ""}`} />
          <div>
            <h2>{panelMode === "swarm" ? "Frontier Swarm" : "Frontier Copilot"}</h2>
            <span>{panelMode === "swarm" ? "Sequential evidence review" : `${selectedProfile.name} · local-first`}</span>
          </div>
        </div>
        <div className="copilot-header-actions">
          <button
            className={`chat-button ${panelMode === "swarm" ? "active" : ""}`}
            onClick={() => setPanelMode((mode) => mode === "swarm" ? "ai" : "swarm")}
            disabled={isStreaming || isSwarmRunning}
            title="Toggle sequential multi-role review"
          >
            <Users size={13} /> <span>{panelMode === "swarm" ? "Chat" : "Swarm"}</span>
          </button>
          <button className="chat-button icon-only" onClick={clearSession} disabled={isStreaming} title="Clear chat session">
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      {panelMode === "swarm" ? (
        <div className="assistant-scroll copilot-scroll" ref={scrollRef} onScroll={handleScroll}>
          <section className="copilot-intro swarm-intro">
            <div><ShieldCheck size={14} /> <strong>Resource-safe review team</strong></div>
            <p>Architect, implementation, and verifier roles run sequentially on Flash so this Mac never loads competing heavyweight models.</p>
          </section>
          <div className="swarm-workers">
            {activeWorkers.map((worker) => (
              <article key={worker.id} className="swarm-worker">
                <div className="swarm-worker-head">
                  <span>{worker.avatar} {worker.name}</span>
                  <span className={worker.status === "passed" ? "passed" : worker.status === "failed" ? "failed" : "running"}>
                    {worker.status} · {worker.tokensCount} tok
                  </span>
                </div>
                <div className="swarm-progress"><span style={{ width: `${worker.progressPercent}%` }} /></div>
                <p>{worker.currentTask}</p>
              </article>
            ))}
          </div>
          {godSynthesis && (
            <section className={`swarm-result ${godSynthesis.masterVerdict.toLowerCase()}`}>
              <div><CheckCircle2 size={14} /> <strong>{godSynthesis.masterVerdict}</strong></div>
              <p>{godSynthesis.executionSummary}</p>
            </section>
          )}
        </div>
      ) : (
        <div className="assistant-scroll copilot-scroll" ref={scrollRef} onScroll={handleScroll}>
          {frontierMessages.length <= 1 && (
            <section className="copilot-intro">
              <div><ShieldCheck size={14} /> <strong>Evidence-first coding session</strong></div>
              <p>Responses stream from the selected qualified route. Timing, tokens, tool activity, errors, and the Frontier tier appear only when measured.</p>
              <div className="quick-actions">
                <button onClick={() => void sendMessage("Inspect the active code and identify the highest-confidence defect.")}>Inspect active code</button>
                <button onClick={() => void sendMessage("Report the current runtime health without claiming unverified capabilities.")}>Runtime health</button>
              </div>
            </section>
          )}

          {frontierMessages.map((chatMessage, index) => {
            if (index === 0 && frontierMessages.length > 1) return null;
            const isUser = chatMessage.role === "user";
            const messageId = chatMessage.id || String(index);
            const displayMode = chatMessage.mode ?? currentProfile;
            return (
              <article key={messageId} className={`copilot-message ${isUser ? "user" : "assistant"} ${chatMessage.errorCode ? "has-error" : ""}`}>
                <div className="copilot-message-head">
                  <span>{isUser ? "You" : `Frontier ${titleCaseMode(displayMode)}`}</span>
                  <div>
                    {chatMessage.costLabel && <span className="metric cost">{chatMessage.costLabel}</span>}
                    {chatMessage.isStreaming ? (
                      <span className="metric streaming"><span /> {liveElapsedSec.toFixed(1)}s</span>
                    ) : chatMessage.durationSec ? (
                      <span className="metric">{chatMessage.durationSec}s</span>
                    ) : null}
                  </div>
                </div>

                {!isUser && chatMessage.isStreaming && !chatMessage.content && (
                  <div className="copilot-working" role="status">
                    <Loader2 size={14} />
                    <div><strong>Preparing qualified local route</strong><span>Waiting for the first measured token…</span></div>
                  </div>
                )}

                {chatMessage.errorCode && (
                  <div className="copilot-error-label"><AlertTriangle size={13} /> {chatMessage.errorCode}</div>
                )}

                {!isUser && (chatMessage.isStreaming || chatMessage.telemetry || chatMessage.toolCalls?.length) ? (
                  <ThoughtProcessViewer
                    durationSec={chatMessage.durationSec ?? 0}
                    tokensCount={chatMessage.tokensCount ?? 0}
                    isStreaming={chatMessage.isStreaming}
                  />
                ) : null}

                {chatMessage.toolCalls?.map((tool) => <ToolCallCard key={tool.id} tool={tool} />)}

                {chatMessage.content && (
                  <div className={chatMessage.isStreaming ? "copilot-stream-content" : ""}>
                    <AIMessageFormatter content={chatMessage.content} onApplyCode={handleApplyToEditor} />
                    {chatMessage.isStreaming && <span className="stream-caret" aria-hidden="true" />}
                  </div>
                )}

                {!isUser && chatMessage.engineUsed && (
                  <div className="copilot-route"><Sparkles size={11} /> {publicEngineLabel(chatMessage.engineUsed)}</div>
                )}

                {!isUser && chatMessage.content && !chatMessage.isStreaming && (
                  <div className="copilot-message-actions">
                    <button onClick={() => handleCopyMessage(chatMessage.content, messageId)}>
                      {copiedMessageId === messageId ? <Check size={11} /> : <Copy size={11} />}
                      {copiedMessageId === messageId ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImageUpload}
        accept="image/png,image/jpeg,image/webp"
        multiple
        disabled={!IMAGE_ATTACHMENTS_AVAILABLE}
        className="hidden"
      />

      <div
        className="composer-wrap copilot-composer"
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
          if (files.length === 0) return;
          event.preventDefault();
          void addImageFiles(files);
        }}
      >
        <div className="model-mode-picker" role="radiogroup" aria-label="Frontier model mode">
          {PROFILES_LIST.map((profile) => {
            const locked = profile.id === "max" && !maxAvailable;
            return (
              <button
                key={profile.id}
                type="button"
                role="radio"
                aria-checked={currentProfile === profile.id}
                className={currentProfile === profile.id ? "selected" : ""}
                disabled={locked || isStreaming || isSwarmRunning}
                onClick={() => setProfile(profile.id)}
                title={locked ? "Max is locked until qualification passes" : profile.description}
              >
                {locked && <LockKeyhole size={10} />}{profile.name}
              </button>
            );
          })}
        </div>

        <div className="composer-mode-detail">
          <span>{panelMode === "swarm" ? "Separate tasks with semicolons" : selectedProfile.modelName}</span>
          <span className={modeStatusError ? "offline" : ""}>{modeStatusError ? "Gateway offline" : maxAvailable ? "Max qualified" : "Max locked"}</span>
        </div>

        {attachedImages.length > 0 && (
          <div className="composer-attachments">
            {attachedImages.map((image, index) => (
              <div key={`${image.slice(0, 24)}-${index}`}>
                <img src={image} alt={`Attachment ${index + 1}`} />
                <button onClick={() => setAttachedImages((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove attachment ${index + 1}`}>×</button>
              </div>
            ))}
          </div>
        )}

        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (files.length === 0) return;
            event.preventDefault();
            void addImageFiles(files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!isStreaming && !isSwarmRunning) void sendMessage();
            }
          }}
          placeholder={isStreaming ? "Draft your next prompt while Frontier finishes…" : panelMode === "swarm" ? "Ask the review team; separate tasks with semicolons…" : "Ask Frontier to inspect, explain, edit, or verify…"}
          aria-label="Ask Frontier Copilot"
        />

        <div className="composer-footer">
          <div className="composer-actions">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Add attachment"
              title={IMAGE_ATTACHMENT_HELP}
              disabled={!IMAGE_ATTACHMENTS_AVAILABLE || isStreaming || isSwarmRunning || attachedImages.length >= MAX_IMAGE_ATTACHMENTS}
            >
              <Paperclip size={15} />
            </button>
            <button type="button" className="builder" onClick={() => void sendMessage(message || "Build a complete, verified implementation for the active file.")} disabled={isStreaming || isSwarmRunning}>
              <Zap size={13} /> Builder
            </button>
          </div>
          <span className="dispatch-note" title={dispatchNote}>{dispatchNote}</span>
          {isStreaming ? (
            <button type="button" className="stop" onClick={stopStreaming} aria-label="Stop generation" title="Stop generation">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send" onClick={() => void sendMessage()} disabled={isSwarmRunning || (!message.trim() && attachedImages.length === 0)} aria-label="Send">
              {isSwarmRunning ? <Loader2 size={16} /> : <ArrowUp size={16} />}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
};
