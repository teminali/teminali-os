import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Mic, ShieldAlert } from "lucide-react";
import {
  AgentCliService,
  type AgentDescriptor,
  type AgentEngine,
  type PermissionRequest,
} from "../../../services/agentCliService";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { useStudioStore } from "../../../store/studioStore";
import { useAttachments } from "../../../hooks/useAttachments";
import { useVoice, type UseVoiceResult } from "../../../hooks/useVoice";
import { useSpokenApproval } from "../../../hooks/useSpokenApproval";
import { useApprovalStore } from "../../../store/approvalStore";
import { composePrompt } from "../../../services/fileService";
import { MessageBlock } from "../../chat/MessageBlock";
import { Composer } from "../../chat/Composer";
import { ChangeReviewDock } from "../../chat/ChangeReviewDock";
import { useChangeStore } from "../../../store/changeStore";
import { languageForPath } from "../../../services/language";
import { interruptTurn } from "../../../services/interruption";
import { useInterruptKey } from "../../../hooks/useInterruptKey";
import { openBrowserAt } from "../../../services/browserNavigation";
import { BrandGlyph, EmptyState } from "../../ui";
import type { ChatMessage } from "../../../types";
import { dispatchPlayerCommand, type PlayerCommand } from "../../../services/playerControl";

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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments();

  /*
    The engine, reachable from the effects that outlive a render.

    Needed for the same reason the main chat needs it: an approval this tab is
    blocked on has to be read aloud by whichever engine is actually listening,
    and that is decided after the component has rendered.
  */
  const voiceRef = useRef<UseVoiceResult | null>(null);
  const spokenApproval = useSpokenApproval(voiceRef);

  const voice = useVoice({
    // A standing permission prompt gets first refusal on the words: "yes" is
    // an answer to it rather than a new instruction for the agent.
    submit: (text) => {
      if (spokenApproval.consume(text)) return;
      void send(text);
    },
    lastAssistantText: () => messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "",
    isBusy: () => streaming,
  });
  voiceRef.current = voice;

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

  /**
   * Writes to whatever sits last in this tab's transcript.
   *
   * Takes an updater as well as a patch, because a stopped turn's patch
   * depends on what the turn had reached — the same shape the main chat's
   * `updateLastMessageInEngine` takes, so `interruptTurn` can be handed to
   * either one unchanged.
   */
  const patchLast = (patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) =>
    setMessages((previous) =>
      previous.map((message, index) =>
        index === previous.length - 1
          ? { ...message, ...(typeof patch === "function" ? patch(message) : patch) }
          : message,
      ),
    );

  const send = async (override?: string) => {
    const typed = (override ?? input).trim();
    const ready = attachments.attachments.filter((entry) => entry.status === "ready");
    if ((!typed && ready.length === 0) || streaming || attachments.busy) return;
    if (!descriptor?.installed) return;

    const { prompt } = composePrompt(typed, attachments.attachments);
    const stamp = new Date().toISOString();
    // One id for the turn, so a change recorded from it can be traced back to
    // the reply that produced it rather than to a second call of `Date.now()`.
    const turnId = `${engine}-${Date.now()}`;

    setMessages((previous) => [
      ...previous,
      { id: turnId, role: "user", content: typed || ready.map((r) => r.name).join(", "), timestamp: stamp },
      { id: `${turnId}-reply`, role: "assistant", content: "", timestamp: stamp, isStreaming: true },
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
          /*
            The agent driving the editor around it.

            `getState()` rather than a hook value on purpose: this closure is
            captured once per turn and must act on the store as it is when the
            event arrives, not as it was when the turn started. A project
            switch only sets the path — the gateway has already rebound its
            root, and `Sidebar` re-reads the tree whenever that path changes.
          */
          onWorkspace: (event) => {
            const store = useStudioStore.getState();
            if (event.action === "reveal") store.revealPath(event.path);
            else if (event.action === "open-file") void store.showFile(event.path);
            else if (event.action === "open-folder") store.showFolder(event.path);
            // The player is a mounted pane, not the store: the command goes to
            // whichever pane holds the element. See services/playerControl.ts.
            else if (event.action === "player") dispatchPlayerCommand(event.command as PlayerCommand);
            else if (event.action === "browse") openBrowserAt(event.url, { newTab: event.newTab });
            else {
              // Exactly what a click in the sidebar does, and in the same
              // order: the video editor has to be on screen before the load
              // runs, because it reports through the video pane's own toasts.
              if (event.kind === "video") focusOrOpen({ kind: "video" });
              store.setWorkspacePath(event.path);
            }
          },
          /*
            Every file the agent wrote becomes a row in the dock below.

            The same treatment the built-in chat has had all along, reached by a
            different road: the chat authors its edits and hands both sides to
            `LiveEditService`, whereas an agent writes to disk itself and the
            gateway recovers the pair from its tool stream. `record` folds
            repeat writes to one path into a single reviewable change whose
            `before` is still what was on disk when the turn started.
          */
          onEdit: (event) => {
            useChangeStore.getState().record({
              path: event.path,
              before: event.before,
              after: event.after,
              existedBefore: event.existedBefore,
              origin: "agent",
              requestId: `${turnId}-reply`,
            });
            /*
              And the file itself comes to the front, as it does when the chat
              pane edits one. Watching a diff appear in the editor is the point
              of the feature; a dock entry the operator has to go and find is
              not the same thing. `openFile` reuses an existing tab, and leaves
              a dirty one alone rather than overwriting unsaved work.
            */
            useStudioStore.getState().openFile({
              path: event.path,
              name: event.path.split("/").pop() || event.path,
              content: event.after,
              language: languageForPath(event.path),
              encoding: "utf8",
              mimeType: "text/plain",
              size: event.size ?? undefined,
              modified: event.modified ?? undefined,
            });
          },
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

  const label = descriptor?.label ?? (engine === "claude" ? "Claude Code" : "Codex");

  /*
    The head of the queue, offered to the voice layer.

    Only the head: several tool calls can be blocked at once, but "yes" can only
    mean the one the operator was just read. The rest wait their turn exactly as
    they already do on screen.

    Publishing changes nothing about the prompt below — it draws itself, its
    buttons still call `answer`, and a tab whose engine is silent simply never
    gets asked out loud. See hooks/useSpokenApproval.ts.
  */
  const head = approvals[0] ?? null;
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    if (!head) return;
    const store = useApprovalStore.getState();
    store.offer({
      id: head.id,
      source: "agent",
      asker: label,
      // The command if it is one, the tool's name if it is not: "Bash" alone
      // tells the ear nothing, and reading raw JSON aloud tells it less.
      action: typeof head.input?.command === "string" ? head.input.command : head.toolName,
      alwaysLabel: head.key,
      answer: (behavior, remember) => void answerRef.current(head, behavior, remember),
    });
    return () => store.withdraw(head.id);
    // `label` is derived from the descriptor and stable for the life of a tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head]);

  /**
   * Stops this tab's run.
   *
   * `interruptTurn` rather than a bare `isStreaming: false`, so a tab is
   * stopped the same way the main chat is: the partial reply is kept and
   * marked, and every tool call still reporting `running` is settled. Without
   * it a stopped tab left its strip spinning under a finished turn.
   */
  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    patchLast(interruptTurn);
  };

  /* Escape stops this tab, as it stops the main chat — same rule, same hook. */
  useInterruptKey(streaming, surfaceRef, stop);

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
    <div ref={surfaceRef} className="flex-1 min-h-0 flex flex-col">
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
            {/* The buttons below are not replaced by the voice path; this only
                says that saying it works too. */}
            {spokenApproval.listening && (
              <span className="flex items-center gap-1 text-ink-muted" title={'Say "yes", "always", or "no"'}>
                <Mic size={10} className="opacity-70" />
                say yes
              </span>
            )}
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
          // One microphone, and it belongs to the conversation surface.
          showVoice={false}
          attachments={attachments}
          width="fill"
        />
      </div>
    </div>
  );
};
