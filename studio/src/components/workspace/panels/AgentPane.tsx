import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ShieldAlert } from "lucide-react";
import {
  AgentCliService,
  type AgentDescriptor,
  type AgentEngine,
  type PermissionRequest,
} from "../../../services/agentCliService";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { useStudioStore } from "../../../store/studioStore";
import { useAttachments } from "../../../hooks/useAttachments";
import { useVoice } from "../../../hooks/useVoice";
import { composePrompt } from "../../../services/fileService";
import { MessageBlock } from "../../chat/MessageBlock";
import { Composer } from "../../chat/Composer";
import { ChangeReviewDock } from "../../chat/ChangeReviewDock";
import { BrandGlyph, EmptyState } from "../../ui";
import type { ChatMessage } from "../../../types";

/**
 * A Claude Code or Codex tab.
 *
 * The agent is the operator's own CLI, running as a process in this workspace
 * with its own auth, its own tools and its own session file — not a model
 * behind our chat box. What the pane owns is the session id the CLI hands back,
 * which it passes to the next turn so the tab is a resumable thread rather than
 * a series of unrelated one-shots.
 *
 * It renders with the same MessageBlock and Composer as every other
 * conversation in the studio, because a turn is a turn. The two things that are
 * genuinely different about an agent tab get their own chrome: the permission
 * selector, and the denial notice.
 *
 * The permission selector is not a convenience. These agents edit files and run
 * commands in a real repository, so how much they may do without asking is the
 * single most consequential setting on this surface — it belongs in the open,
 * defaulted to the middle rung, never to the top one.
 */

const PERMISSION_COPY: Record<string, { label: string; detail: string; danger?: boolean }> = {
  // Claude Code
  manual: { label: "Ask first", detail: "Every tool call needs approval. In this headless mode an unanswered prompt is refused." },
  acceptEdits: { label: "Accept edits", detail: "File edits run; shell commands still need approval." },
  bypassPermissions: { label: "Full access", detail: "Runs anything in this workspace without asking.", danger: true },
  // Codex
  "read-only": { label: "Read only", detail: "May read the workspace. No edits, no commands." },
  "workspace-write": { label: "Workspace write", detail: "May edit files and run commands inside the workspace." },
  "danger-full-access": { label: "Full access", detail: "No sandbox at all.", danger: true },
};

export const AgentPane: React.FC<{ panel: PanelTab & { kind: AgentEngine } }> = ({ panel }) => {
  const engine = panel.kind;
  const openPanel = usePanelStore((state) => state.open);
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);
  const openFileAtSnippet = useStudioStore((state) => state.openFileAtSnippet);

  const [descriptor, setDescriptor] = useState<AgentDescriptor | null>(null);
  const [probing, setProbing] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [permission, setPermission] = useState<string | null>(null);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [denials, setDenials] = useState<number>(0);
  /* Approvals the agent is blocked on. A queue rather than one slot: a turn
     can put several tools in flight, and each is a separate decision. */
  const [approvals, setApprovals] = useState<PermissionRequest[]>([]);

  // The CLI's own session. Held in a ref because a turn reads it at send time
  // and a stale closure would silently start a new thread every message.
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments();

  const voice = useVoice({
    submit: (text) => void send(text),
    lastAssistantText: () => messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "",
    isBusy: () => streaming,
  });

  useEffect(() => {
    const controller = new AbortController();
    void AgentCliService.available(controller.signal).then((agents) => {
      if (controller.signal.aborted) return;
      const found = agents?.[engine] ?? null;
      setDescriptor(found);
      setPermission((current) => current ?? found?.defaultPermission ?? null);
      setProbing(false);
    });
    return () => controller.abort();
  }, [engine]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = (patch: Partial<ChatMessage>) =>
    setMessages((previous) =>
      previous.map((message, index) => (index === previous.length - 1 ? { ...message, ...patch } : message)),
    );

  const send = async (override?: string) => {
    const typed = (override ?? input).trim();
    const ready = attachments.attachments.filter((entry) => entry.status === "ready");
    if ((!typed && ready.length === 0) || streaming || attachments.busy) return;
    if (!descriptor?.installed) return;

    const { prompt } = composePrompt(typed, attachments.attachments);
    const stamp = new Date().toISOString();

    setMessages((previous) => [
      ...previous,
      { id: `${engine}-${Date.now()}`, role: "user", content: typed || ready.map((r) => r.name).join(", "), timestamp: stamp },
      { id: `${engine}-${Date.now()}-reply`, role: "assistant", content: "", timestamp: stamp, isStreaming: true },
    ]);
    setInput("");
    attachments.clear();
    setStreaming(true);
    setDenials(0);
    setApprovals([]);

    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = "";

    try {
      const result = await AgentCliService.streamTurn(
        {
          engine,
          prompt,
          cwd: panel.cwd ?? "",
          sessionId: sessionRef.current,
          permission: permission ?? descriptor.defaultPermission,
          signal: controller.signal,
        },
        {
          onToken: (token) => {
            accumulated += token;
            patchLast({ content: accumulated, isStreaming: true });
          },
          onToolCall: (call) => {
            setMessages((previous) =>
              previous.map((message, index) => {
                if (index !== previous.length - 1) return message;
                const existing = message.toolCalls ?? [];
                const at = existing.findIndex((entry) => entry.id === call.id);
                return {
                  ...message,
                  toolCalls: at >= 0 ? existing.map((e, i) => (i === at ? call : e)) : [...existing, call],
                };
              }),
            );
          },
          onComplete: (data) => {
            patchLast({
              content: data.fullText,
              isStreaming: false,
              tokensCount: data.tokensCount,
              costLabel: data.costLabel,
              durationSec: data.durationSec,
              engineUsed: data.engineUsed,
            });
            setStreaming(false);
          },
          onError: (failure) => {
            patchLast({ content: `Error: ${failure.message}`, isStreaming: false });
            setStreaming(false);
          },
          onPermission: (request) => setApprovals((queue) => [...queue, request]),
          // Answered elsewhere, or timed out: drop it rather than leaving a
          // dead prompt on screen with nothing behind it.
          onPermissionResolved: (id) => setApprovals((queue) => queue.filter((entry) => entry.id !== id)),
        },
      );
      // Resuming from here is what makes the next message a reply rather than a
      // fresh conversation with an agent that has forgotten everything.
      sessionRef.current = result.sessionId;
      setDenials(result.permissionDenials.length);
    } catch {
      // onError already wrote the failure into the transcript.
      setStreaming(false);
    }
  };

  /**
   * Answer the request at the head of the queue. Removed on the spot rather
   * than on the gateway's confirmation: the agent is stalled until this lands,
   * and a button that stays live while the answer is in flight invites a
   * second click that would be refused as already-answered anyway.
   */
  const answer = async (request: PermissionRequest, behavior: "allow" | "deny", remember: boolean) => {
    setApprovals((queue) => queue.filter((entry) => entry.id !== request.id));
    await AgentCliService.answerPermission({
      runId: request.runId,
      id: request.id,
      behavior,
      remember,
    });
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
    patchLast({ isStreaming: false });
  };

  const label = descriptor?.label ?? (engine === "claude" ? "Claude Code" : "Codex");
  const current = permission ? PERMISSION_COPY[permission] : null;

  if (!probing && !descriptor?.installed) {
    return (
      <EmptyState
        title={`${label} is not installed`}
        detail={`The gateway could not run \`${engine}\`. Install the CLI and make sure it is on the gateway's PATH, then reopen this tab.`}
      />
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* ── Agent chrome ────────────────────────────────────────────────
          Version and permission, because both change what this tab will do
          to the repository and neither is guessable from the transcript. */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 h-8 text-2xs text-ink-faint">
        <BrandGlyph brand={engine} size={13} />
        <span className="truncate">{descriptor?.version ?? label}</span>
        <span className="flex-1" />
        {sessionRef.current && <span className="text-ink-disabled">session resumed</span>}

        <div className="relative">
          <button
            type="button"
            onClick={() => setPermissionOpen((open) => !open)}
            className={`flex items-center gap-1 px-2 h-6 rounded-md transition-colors duration-ds ease-ds ${
              current?.danger ? "text-warning hover:bg-surface-hover" : "text-ink-muted hover:bg-surface-hover hover:text-ink-high"
            }`}
            title={current?.detail}
          >
            {current?.danger && <ShieldAlert size={11} />}
            {current?.label ?? "Permissions"}
            <ChevronDown size={11} />
          </button>

          {permissionOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPermissionOpen(false)} />
              <div className="absolute right-0 top-7 z-50 w-64 rounded-xl bg-surface-popover border border-edge-popover shadow-popover p-1">
                {(descriptor?.permissions ?? []).map((value) => {
                  const copy = PERMISSION_COPY[value] ?? { label: value, detail: "" };
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setPermission(value);
                        setPermissionOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors duration-ds ease-ds ${
                        value === permission ? "bg-surface-active" : "hover:bg-surface-hover"
                      }`}
                    >
                      <span className={`block text-xs ${copy.danger ? "text-warning" : "text-ink-high"}`}>
                        {copy.label}
                      </span>
                      <span className="block text-2xs text-ink-muted leading-relaxed mt-0.5">{copy.detail}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col px-4 pb-4">
        {messages.length === 0 ? (
          <EmptyState
            title={label}
            detail={`Runs in this workspace with its own tools and permissions. ${current?.detail ?? ""}`}
          />
        ) : (
          <div className="flex flex-col flex-shrink-0">
            {messages.map((message, index) => (
              <MessageBlock
                key={message.id}
                message={message}
                density="compact"
                onStop={stop}
                onRetry={
                  message.role === "assistant" && index > 0
                    ? () => void send(messages[index - 1].content)
                    : undefined
                }
                onJumpToFile={(filePath, code) => {
                  void openFileAtSnippet(filePath, code);
                  focusOrOpen({ kind: "file", path: filePath, label: filePath.split("/").pop() });
                }}
                onRun={() => openPanel({ kind: "terminal" })}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Approval ────────────────────────────────────────────────────
          The agent is blocked inside its own tool call until this is
          answered. Shown in the pane rather than as a modal: the transcript
          above it is the context the decision needs, and a modal would cover
          exactly the command that explains what is being asked for. */}
      {approvals.length > 0 && (
        <div className="flex-shrink-0 mx-3 mb-2 rounded-xl bg-surface-chip border border-edge-popover overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 text-2xs text-ink-muted border-b border-edge-popover">
            <ShieldAlert size={12} className="text-warning flex-shrink-0" />
            <span className="text-ink-high">{label} is asking to run {approvals[0].toolName}</span>
            <span className="flex-1" />
            {approvals.length > 1 && <span className="text-ink-disabled">{approvals.length - 1} more waiting</span>}
          </div>

          <pre className="px-3 py-2 text-2xs text-ink-muted whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {typeof approvals[0].input?.command === "string"
              ? String(approvals[0].input.command)
              : JSON.stringify(approvals[0].input, null, 2)}
          </pre>

          <div className="flex items-center gap-1.5 px-3 py-2 border-t border-edge-popover">
            <button
              type="button"
              onClick={() => void answer(approvals[0], "allow", false)}
              className="px-2.5 h-7 rounded-md text-2xs bg-surface-hover text-ink-high hover:bg-surface-popover transition-colors duration-ds ease-ds"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => void answer(approvals[0], "allow", true)}
              className="px-2.5 h-7 rounded-md text-2xs text-ink-muted hover:bg-surface-hover hover:text-ink-high transition-colors duration-ds ease-ds"
              title={`Every ${approvals[0].key} for the rest of this turn`}
            >
              Always allow {approvals[0].key}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void answer(approvals[0], "deny", false)}
              className="px-2.5 h-7 rounded-md text-2xs text-warning hover:bg-surface-hover transition-colors duration-ds ease-ds"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* A refused tool call is why a turn did less than it looked like it
          would. Saying so beats leaving the operator to infer it. */}
      {denials > 0 && (
        <div className="flex-shrink-0 mx-3 mb-2 flex items-center gap-2 px-2.5 py-2 rounded-lg bg-surface-chip text-2xs text-ink-muted">
          <ShieldAlert size={12} className="text-warning flex-shrink-0" />
          {denials} tool {denials === 1 ? "call was" : "calls were"} refused by the current permission mode.
        </div>
      )}

      <div className="flex-shrink-0 px-3 pb-4 flex flex-col gap-2">
        {/* The agent CLIs write in their own process, so nothing typed here ever
            adds a row. The dock still belongs: pending changes are workspace
            state, and this pane has a composer that would otherwise let you
            move on with an unreviewed edit on disk. */}
        <ChangeReviewDock width="fill" />
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send()}
          onStop={stop}
          streaming={streaming}
          placeholder={probing ? "Checking for the CLI…" : `Ask ${label}`}
          modelName={label}
          voice={voice}
          attachments={attachments}
          width="fill"
        />
      </div>
    </div>
  );
};
