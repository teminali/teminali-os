/**
 * Teminali OS Dual-Agent Bridge
 *
 * "One AI Talks. One AI Works."
 *
 * The Voice Assistant (Temi) is the exclusive human-facing conversational interface.
 * Behind the scenes, the Teminali engineering assistants (Codex, Claude Code, Gemini,
 * and Frontier models) operate autonomously using their CLIs, executing tools, modifying
 * files, running commands, and analyzing ASTs.
 *
 * Execution events stream live into the compact top-right Assistant Activity Window,
 * while Temi maintains real-time spoken awareness for the human.
 */

import { AIService } from "../aiService";
import { diffLineCounts } from "../diff";
import { describeToolCall, summariseOutcome, type NarratableToolCall } from "./progressNarration";
import { useStudioStore } from "../../store/studioStore";
import { useChangeStore } from "../../store/changeStore";
import { useAssistantActivityStore, type CodingEngine } from "../../store/assistantActivityStore";
import { useApprovalStore } from "../../store/approvalStore";
import { classifyApprovalReply } from "./approvalIntent.ts";
import { frameVoiceDelegatedTask } from "./assistantHandoff.ts";
import {
  describeEngineSwitch,
  isRunRecallQuestion,
  parseEngineChoice,
  ENGINE_LABELS,
} from "./voiceTurnRouter.ts";
import { executeActionChain } from "./compoundActionRunner.ts";
import { languageForPath } from "../language";
import {
  describeQueue,
  describeRejection,
  dequeueTask,
  enqueueTask,
  type QueuedTask,
} from "../../utils/taskQueue";
import type { AgentEngine } from "../agentCliService";
import type { AgentCommandRequest } from "../agentCommands";
import type { MachineActionKind } from "./machineAction.ts";
import type { ModelModeId, ToolCall } from "../../types";

// The work/talk gate lives in `machineAction.ts` — pure, so `voiceTurnRouter`
// can ask without importing the stores this file depends on. It replaced
// `isEngineeringTask`, whose word-count and question-mark rejections sent
// "play that video" and "open my downloads folder" to a persona with no hands.
export { classifyMachineAction, isMachineAction } from "./machineAction.ts";

export interface TaskDelegationOptions {
  /**
   * Who runs it. `CodingEngine` rather than the CLI pair, because "gemini" is
   * how the max lane is named everywhere else in this file and a caller that
   * had it could not previously pass it.
   *
   * Absent, the engine is taken from the utterance itself (see
   * `parseEngineChoice`), then from the activity store, then the picker.
   */
  engine?: CodingEngine;
  onProgress?: (summary: string) => void;
  onCompleted?: (finalReport: string) => void;
  signal?: AbortSignal;
  /**
   * What `machineAction` made of the utterance, when this came from the voice.
   * It reaches `summariseOutcome`, which needs to know whether the operator
   * asked for work or asked a question before it decides what a silent run
   * has to say for itself.
   */
  action?: MachineActionKind;
  /**
   * Put the CLI's permission prompts to the operator, and resolve with what
   * they decided.
   *
   * Optional, and defaulted rather than skipped. `aiService` denies outright
   * when no gate is passed — a reasonable answer for a headless caller and a
   * catastrophic one here, because the voice lane is the *only* surface with
   * no buttons: "ask Claude Code to run the tests" auto-denied its first
   * permission event in under a millisecond and the run died at once, with
   * nothing said. A caller that owns a gate (the stage, whose
   * `useSpokenApproval` can answer out loud) should pass it; a caller that
   * does not gets `voiceApprovalGate` below, which publishes the question to
   * `store/approvalStore` where the spoken gate is already listening.
   */
  approveCommand?: (request: AgentCommandRequest) => Promise<boolean>;
}

/** A prompt that arrived while something else was running. */
interface QueuedDelegation extends QueuedTask {
  options: TaskDelegationOptions;
  /** Settles the caller's promise when this one finally runs, or is dropped. */
  settle: (report: string) => void;
}

/** What a queued prompt reports when a stop cleared the queue before its turn. */
export const QUEUE_CLEARED_NOTE = "Dropped — the run was stopped before this reached the front of the queue.";

/** What a cancelled run reports. A stop is not a failure and must not sound like one. */
export const CANCELLED_NOTE = "Stopped before it finished.";

/**
 * How long a spoken permission question stands before it is refused for silence.
 *
 * Shorter than the gateway's own five-minute auto-deny (`APPROVAL_TIMEOUT_MS`),
 * so the answer that reaches the CLI is this one and the operator learns what
 * happened while they still remember being asked.
 */
const APPROVAL_WAIT_MS = 180_000;

/**
 * How long the last run's report is still the answer to "what did it change?".
 *
 * Past this the question is about something else and the honest response is to
 * go and look — which is what a delegation does.
 */
const REPORT_RECALL_MS = 10 * 60_000;

export class TeminaliAgentBridge {
  private static activeController: AbortController | null = null;
  private static queue: QueuedDelegation[] = [];
  /**
   * The permission question currently in front of the operator, so a stop can
   * settle it. A run that is aborted while its CLI sits inside a tool call
   * would otherwise leave the question standing over a run that no longer
   * exists, and "yes" would answer for a process that had already gone.
   */
  private static pendingApproval: { id: string; settle: (allowed: boolean) => void } | null = null;
  /**
   * What the last finished run reported, and when.
   *
   * "What did it change?" asked a moment after the work ends reads as a new
   * instruction to `turnIntent` — nothing is running, so nothing is being
   * asked *about* — and started a second run to discover what the first one
   * did. The answer was already in hand; this is it, kept.
   */
  private static lastReport: { text: string; finishedAt: number } | null = null;
  /**
   * The CLI session each engine is continuing, and the workspace it belongs
   * to.
   *
   * Every voice delegation opened a cold session, so "now run the tests" knew
   * nothing about "fix the failing test" one sentence earlier: the second
   * turn had no memory of the first, and the operator had to say the whole
   * thing again. `AgentCliService` resumes by id, which is what makes a spoken
   * conversation a thread rather than a series of strangers.
   *
   * Keyed with the workspace because a session belongs to the directory it ran
   * in. Resuming a teminaliCut thread inside teminaliCode would hand the CLI a
   * history of files that are not there.
   */
  private static sessions = new Map<AgentEngine, { id: string; workspace: string }>();

  /**
   * Delegates an engineering task to the background coding assistants.
   * Progress events stream live into the process line in the composer's
   * project tab.
   * They deliberately do not open anything: the activity dialog is opened by
   * a click on that line and never by the work itself.
   *
   * **A second prompt queues; it does not kill the first.** This method opened
   * with `this.activeController?.abort()`, so a second Enter mid-turn ended the
   * running turn silently — nothing in the transcript, nothing in the activity
   * log, just work that stopped. Both agent CLIs queue, and the rules for what
   * may join the queue are in `utils/taskQueue.ts` where they are tested.
   *
   * The returned promise still settles with the run's own report, whether this
   * prompt ran now or waited: every caller here passes `onCompleted` and
   * discards it, but a promise that resolves with "Queued" would be a trap for
   * the first caller that does not.
   */
  static async delegateTask(prompt: string, options: TaskDelegationOptions = {}): Promise<string> {
    const aside = this.interceptAside(prompt, options);
    if (aside !== null) return aside;

    // Hard-Coded Local Accessibility & Telemetry fast-path (< 50ms, 0 tokens)
    const fast = await executeActionChain(prompt);
    if (fast && fast.handled) {
      options.onProgress?.(fast.spoken);
      options.onCompleted?.(fast.spoken);
      this.recordReport(fast.spoken);
      return fast.spoken;
    }

    if (this.activeController) {
      const result = enqueueTask<QueuedDelegation>(this.queue, {
        id: `queued-${Date.now()}-${this.queue.length}`,
        prompt,
        options,
        settle: () => {},
      });
      if (!result.accepted) {
        const refusal = describeRejection(result.reason);
        if (refusal) {
          options.onProgress?.(refusal);
          // Spoken, not only shown. Every other exit from a delegation reaches
          // `onCompleted`; this one did not, so a refused prompt left Temi's
          // "On it." as the last thing said and put the reason in a toast —
          // on a screen the operator is not looking at, which is why they
          // asked out loud. Silence after an acknowledgement is the lie.
          options.onCompleted?.(refusal);
        }
        return refusal;
      }
      const queue = result.queue;
      this.queue = queue;
      const queued = queue[queue.length - 1];
      const waiting = describeQueue(this.queue.length);
      options.onProgress?.(waiting);
      // Spoken, for the same reason a refusal is. "Open package.json" said
      // during a run was accepted in silence and opened minutes later, after
      // Temi had already said "On it." — so the operator watched nothing
      // happen and said it again. The folder path refused out loud; files
      // waited in silence. A queue is only a queue if you know you are in one.
      options.onCompleted?.(waiting);
      useAssistantActivityStore.getState().logAction({
        type: "read",
        file: "Teminali Workspace",
        badge: "read",
        desc: `${waiting}: "${queued.prompt.substring(0, 36)}..."`,
      });
      // Synchronous executor, so `settle` is in place long before any drain
      // could reach this entry.
      return new Promise<string>((resolve) => {
        queued.settle = resolve;
      });
    }

    return this.runTask(prompt, options);
  }

  /** How many prompts are waiting behind the one that is running. */
  static queuedCount(): number {
    return this.queue.length;
  }

  /**
   * The three things that arrive here looking like work and are not.
   *
   * All three used to start an agent run, and each one of them was a lie the
   * operator could hear:
   *
   *   1. **"Yes, go ahead."** said while a CLI is blocked on a permission
   *      prompt. The stage's `useSpokenApproval` takes this first when it is
   *      mounted and listening; this is the net under it, because the failure
   *      mode without one is grim — the answer becomes a *second* agent run
   *      ("run it" classifies as `shell`) while the first stays blocked.
   *   2. **"Use Frontier Max."** A choice of engine, which no agent can carry
   *      out and which the persona therefore narrated: she said she had
   *      switched, and nothing had. The store write happens here and the
   *      confirmation is spoken after it, never before.
   *   3. **"What did it change?"** asked after the run ended. The report is
   *      already held; going to find out again is both slower and a different
   *      answer.
   *
   * Returns what was said, or null when this really is work. Deliberately
   * ahead of the queue: all three are answers about the run in flight, and
   * waiting behind it for one would be absurd.
   */
  private static interceptAside(prompt: string, options: TaskDelegationOptions): string | null {
    const clean = prompt.trim();
    if (!clean) return null;

    const pending = this.pendingApproval;
    if (pending) {
      const verdict = classifyApprovalReply(clean);
      if (verdict) {
        pending.settle(verdict !== "deny");
        const line = verdict === "deny" ? "Refused." : "Allowed.";
        options.onProgress?.(line);
        options.onCompleted?.(line);
        return line;
      }
    }

    const choice = parseEngineChoice(clean);
    if (choice?.switchOnly) {
      const activityStore = useAssistantActivityStore.getState();
      const previous = activityStore.activeEngine;
      activityStore.setActiveEngine(choice.engine);
      // Read back rather than assumed. The sentence she says next is true
      // because the store says so, not because this line ran.
      const landed = useAssistantActivityStore.getState().activeEngine;
      const busy = this.activeController !== null;
      const line = describeEngineSwitch(ENGINE_LABELS[landed], busy);
      activityStore.logAction({
        type: "cmd",
        cmd: `Engine set to ${ENGINE_LABELS[landed]}`,
        result: busy
          ? `Applies to the next task — ${ENGINE_LABELS[previous]} keeps the one already running`
          : `Was ${ENGINE_LABELS[previous]}`,
        status: "success",
      });
      options.onProgress?.(line);
      options.onCompleted?.(line);
      return line;
    }

    const report = this.lastReport;
    if (
      !this.activeController &&
      report &&
      isRunRecallQuestion(clean) &&
      Date.now() - report.finishedAt < REPORT_RECALL_MS
    ) {
      options.onProgress?.("Answering from the run that just finished.");
      options.onCompleted?.(report.text);
      return report.text;
    }

    return null;
  }

  /**
   * Explicitly record a spoken report (such as from hard-coded system accessibility fast paths)
   * so follow-up recall questions can answer from it immediately.
   */
  public static recordReport(text: string): void {
    this.lastReport = { text, finishedAt: Date.now() };
  }

  /**
   * The voice lane's own permission gate.
   *
   * `aiService` denies every CLI permission event when no gate is passed, and
   * the bridge passed none: "ask Claude Code to run the tests" refused its own
   * first tool call in under a millisecond and the run ended having done
   * nothing. There is no pane to click here, so the question goes to
   * `store/approvalStore` — the one slot both the chat and the agent pane
   * publish to, and the one `hooks/useSpokenApproval` reads aloud and answers
   * from a spoken "yes".
   *
   * It always settles. A promise that never resolves leaves the CLI blocked
   * inside its tool call, which is the failure this replaced wearing a
   * different hat, so silence refuses at `APPROVAL_WAIT_MS`.
   */
  private static voiceApprovalGate(
    asker: string,
    options: TaskDelegationOptions,
  ): (request: AgentCommandRequest) => Promise<boolean> {
    return (request) =>
      new Promise<boolean>((resolve) => {
        const store = useApprovalStore.getState();
        const activityStore = useAssistantActivityStore.getState();
        const id = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        let settled = false;
        const settle = (allowed: boolean, note: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.pendingApproval?.id === id) this.pendingApproval = null;
          useApprovalStore.getState().withdraw(id);
          activityStore.logAction({
            type: "cmd",
            cmd: request.command,
            result: note,
            status: allowed ? "running" : "failed",
          });
          resolve(allowed);
        };
        const timer = setTimeout(() => settle(false, "Refused — nobody answered"), APPROVAL_WAIT_MS);
        this.pendingApproval = { id, settle: (allowed) => settle(allowed, allowed ? "Allowed by voice" : "Refused by voice") };
        activityStore.setLatestProgress(`Waiting for you: ${request.command.substring(0, 40)}`);
        // On screen as well as in the ear. `useSpokenApproval` reads the
        // question out when a microphone is open, and a toast is what is left
        // when one is not.
        options.onProgress?.(`${asker} needs your OK: ${request.command.substring(0, 60)}`);
        store.offer({
          id,
          source: "agent",
          asker,
          action: request.command,
          // No "always". The answer posted back to the gateway carries
          // `remember: false` (see `aiService`), so offering to remember it
          // would promise something nothing here does.
          alwaysLabel: null,
          answer: (behavior) => settle(behavior === "allow", behavior === "allow" ? "Allowed by voice" : "Refused by voice"),
        });
      });
  }

  /** Runs one delegation now. Only `delegateTask` and `drain` may call it. */
  private static async runTask(prompt: string, options: TaskDelegationOptions = {}): Promise<string> {
    const store = useStudioStore.getState();
    const activityStore = useAssistantActivityStore.getState();

    const controller = new AbortController();
    this.activeController = controller;

    /*
      "Have Codex look at this file."

      The name the operator said used to be thrown away here: the engine came
      from the picker, so Codex work ran on Frontier and the only evidence was
      a log line naming the wrong assistant. `parseEngineChoice` reads it out
      of the sentence, and it sits above the stores because it is the most
      specific thing anyone said — an explicit `options.engine` from a caller
      that already decided still wins over both.
    */
    const named = parseEngineChoice(prompt);
    const requestedEngine: CodingEngine =
      options.engine ||
      named?.engine ||
      activityStore.activeEngine ||
      (store.agentSelection?.engine as AgentEngine) ||
      (store.currentProfile === "max" ? "gemini" : "frontier");

    const streamEngine: "frontier" | "claude" | "codex" =
      requestedEngine === "gemini" ? "frontier" : requestedEngine;

    const streamMode: ModelModeId =
      requestedEngine === "gemini" || store.currentProfile === "max"
        ? "max"
        : (named?.heard === "frontier flash" || store.currentProfile === "flash")
          ? "flash"
          : "auto";

    /** What the operator calls this engine. "GEMINI" is not a thing he ever said. */
    const engineLabel = ENGINE_LABELS[requestedEngine];

    /*
      Which CLI thread this turn continues. Only the two CLIs have one — the
      local lane carries its own memory — and a session belongs to the
      directory it ran in, so one remembered from another workspace is dropped
      rather than resumed into a tree where none of its files exist.
    */
    const workspace = store.workspacePath || "";
    const remembered = streamEngine === "frontier" ? null : this.sessions.get(streamEngine);
    const resumeSessionId = remembered && remembered.workspace === workspace ? remembered.id : null;

    activityStore.setTaskRunning(true, prompt);

    // 1. Initial acknowledgment in activity feed
    activityStore.logAction({
      type: "read",
      file: "Teminali Workspace",
      badge: "read",
      desc: `Task assigned to ${engineLabel}${resumeSessionId ? " (same session)" : ""}: "${prompt.substring(0, 36)}..."`,
    });

    const initialStatus = `Starting background execution with ${engineLabel}...`;
    activityStore.setLatestProgress(initialStatus);
    options.onProgress?.(initialStatus);

    let accumulatedProse = "";
    /*
      `AIService.streamMessage` never throws: it catches everything and hands it
      to `onError`, then resolves. This was the one caller that passed no
      `onError`, so every failure -- a 401, a dead provider, a refused tool --
      arrived as a stream that simply produced nothing, the `catch` below never
      ran, and the turn reported success for work that had not happened.
      Measured 2026-09-11: "On it." and "Done." in the same millisecond.
    */
    let streamError: Error | null = null;
    // What the run was *observed* to do. Everything spoken at the end is built
    // from this list, so nothing can be reported that did not happen.
    const observed: NarratableToolCall[] = [];
    let toolCount = 0;
    let editCount = 0;
    let failureCount = 0;
    const startedAt = Date.now();

    try {
      await AIService.streamMessage(
        streamEngine,
        frameVoiceDelegatedTask(prompt),
        [],
        {
          onToken: (token) => {
            accumulatedProse += token;
          },
          onToolCall: (call: ToolCall) => {
            toolCount++;
            observed.push({
              id: call.id || `call-${toolCount}`,
              name: call.name || "tool",
              arguments: call.arguments || {},
              status: call.status || "running",
              result: call.result,
            });
            if (call.status === "error") failureCount++;
            const name = call.name || "tool";
            const args = call.arguments || {};
            const inputStr = JSON.stringify(args);

            const narratable: NarratableToolCall = {
              id: call.id || `call-${toolCount}`,
              name,
              arguments: args,
              status: call.status || "running",
              result: call.result,
            };
            const desc = describeToolCall(narratable);
            if (desc) {
              activityStore.setLatestProgress(desc);
              options.onProgress?.(desc);
            }

            if (name === "runCommand" || name === "bash" || name === "frontier.run_command") {
              const cmd = (args as any)?.command || inputStr;
              const cmdStr = typeof cmd === "string" ? cmd : "command";
              activityStore.logAction({
                type: "cmd",
                cmd: cmdStr,
                result: "Executing in background CLI...",
                status: "running",
              });
            } else if (name === "writeFile" || name === "editFile") {
              const file = (args as any)?.path || "file";
              activityStore.logAction({
                type: "edit",
                file,
                badge: "modify",
                plus: call.diff ? `+${call.diff.additions}` : undefined,
                minus: call.diff ? `-${call.diff.deletions} lines` : undefined,
                desc: call.diff ? "Edit requested" : "Edit requested — line counts pending",
                status: call.status === "completed" ? "success" : call.status === "error" ? "failed" : "running",
              });
            } else {
              activityStore.logAction({
                type: "read",
                file: (args as any)?.path || name,
                badge: "read",
                desc: `Tool executed: ${name}`,
              });
            }
          },
          onComplete: (data) => {
            if (data.fullText) accumulatedProse = data.fullText;
          },
          onError: (error) => {
            streamError = error;
          },
        },
        [],
        {
          mode: streamMode,
          workingDirectory: workspace || undefined,
          signal: options.signal || controller.signal,
          origin: "voice",
          // Without this the CLI's first permission event is denied on the
          // spot — see `voiceApprovalGate`, and `aiService`'s `onPermission`
          // for the `false` this replaces.
          approveCommand: options.approveCommand ?? this.voiceApprovalGate(engineLabel, options),
          /*
            "Now run the tests", right after "fix the failing test."

            Both CLIs are stateless processes between turns and resume by id.
            The voice lane passed none, so every spoken sentence opened a cold
            session that had never heard the one before it — the operator had
            to restate the whole task to get a follow-up carried out. `fork`
            stays off: a spoken conversation is one thread.
          */
          agentSessionId: resumeSessionId,
          onAgentSession: (sessionId) => {
            if (!sessionId) return;
            this.sessions.set(streamEngine as AgentEngine, { id: sessionId, workspace });
          },
          onWorkspace: (event) => {
            if (event.action === "reveal") store.revealPath(event.path);
            else if (event.action === "open-file") void store.showFile(event.path);
            else if (event.action === "open-folder") store.showFolder(event.path);
            else if (event.action === "open-project") store.setWorkspacePath(event.path);
            else if (event.action === "browse") {
              const browseUrl = (event as { url?: string }).url;
              if (browseUrl) {
                void import("../browserNavigation").then(({ openBrowserAt }) => {
                  openBrowserAt(browseUrl, { newTab: (event as { newTab?: boolean }).newTab });
                });
              }
            } else if (event.action === "preview") {
              const target = (event as { path?: string; url?: string }).path || (event as { path?: string; url?: string }).url;
              store.openBrowserPreview(target);
            } else if (event.action === "close-file") {
              /*
                "Close that file." The handler stopped at `open-project`, so the
                event arrived and was dropped on the floor while Temi confirmed
                a close that never happened — the same class of lie as the
                engine switch that never switched.

                Read fresh rather than off the `store` snapshot taken when this
                run started: `tabs` and `activeTabId` are data, and by the time
                a tag arrives mid-stream the snapshot's copy is minutes old.
                `closeTab` takes a tab id, never a path.
              */
              const live = useStudioStore.getState();
              const scope = (event as { scope?: string }).scope;
              const path = (event as { path?: string }).path;
              if (scope === "all") {
                for (const tab of [...live.tabs]) live.closeTab(tab.id);
              } else if (scope === "active" || !path) {
                if (live.activeTabId) live.closeTab(live.activeTabId);
              } else {
                const tab = live.tabs.find((candidate) => candidate.path === path);
                if (tab) live.closeTab(tab.id);
              }
            }
          },
          onDraftEdit: (draft) => {
            const fileName = draft.path.split("/").pop() || draft.path;
            const studio = useStudioStore.getState();
            studio.openFile({
              path: draft.path,
              name: fileName,
              content: draft.content,
              language: languageForPath(draft.path),
            });
            studio.syncFileContent({ path: draft.path, content: draft.content });
            void import("../../store/panelStore").then(({ usePanelStore }) => {
              usePanelStore.getState().focusOrOpen({ kind: "file", path: draft.path, label: fileName });
              usePanelStore.getState().setOpen(true);
            });
          },
          onEdit: (event) => {
            useChangeStore.getState().record({
              path: event.path,
              before: event.before,
              after: event.after,
              existedBefore: event.existedBefore,
              origin: "agent",
              requestId: `dual-${Date.now()}`,
            });
            const fileName = event.path.split("/").pop() || event.path;
            const studio = useStudioStore.getState();
            studio.openFile({
              path: event.path,
              name: fileName,
              content: event.after,
              language: languageForPath(event.path),
              encoding: "utf8",
              mimeType: "text/plain",
              size: event.size ?? undefined,
              modified: event.modified ?? undefined,
            });
            void import("../../store/panelStore").then(({ usePanelStore }) => {
              usePanelStore.getState().focusOrOpen({ kind: "file", path: event.path, label: fileName });
              usePanelStore.getState().setOpen(true);
            });
            const counts = diffLineCounts(event.before, event.after);
            observed.push({
              id: `edit-${event.path}-${editCount}`,
              name: "editFile",
              arguments: { path: event.path },
              status: "completed",
            });
            editCount++;
            activityStore.logAction({
              type: "edit",
              file: event.path,
              badge: event.existedBefore ? "modify" : "create",
              // Counted from the before/after this event carries — see
              // `diffLineCounts`. `exact: false` means the rewrite was too
              // large to match line-for-line, so the number is not claimed.
              plus: counts.exact ? `+${counts.added}` : undefined,
              minus: counts.exact ? `-${counts.removed} lines` : undefined,
              desc: counts.exact
                ? "Changes recorded to disk and review dock"
                : `Rewritten (${counts.removed} lines in, ${counts.added} out) — recorded to disk and review dock`,
              status: "success",
            });
            const filename = event.path.split("/").pop() || event.path;
            activityStore.setLatestProgress(`Saved changes to ${filename}`);
          },
        },
      );

      // Raised here rather than reported as an outcome, so the failure lands in
      // the `catch` below and is spoken with every other kind of failure.
      if (streamError) throw streamError;

      // 2. Final completion log — what was counted, not what would sound good.
      // It used to read "Success · 0 errors" whether or not a tool had failed,
      // and the voice reads this feed aloud.
      const operations = `${toolCount} ${toolCount === 1 ? "operation" : "operations"}`;
      const edited = editCount > 0 ? `, ${editCount} ${editCount === 1 ? "file" : "files"} changed` : "";
      activityStore.logAction({
        type: "cmd",
        cmd: `Task finished (${operations}${edited})`,
        result: failureCount > 0
          ? `${failureCount} of ${toolCount} ${failureCount === 1 ? "call" : "calls"} failed`
          : toolCount === 0
            ? "No tools were run"
            : "No tool reported an error",
        status: failureCount > 0 ? "failed" : "success",
      });

      // The spoken report. `summariseOutcome` names the files that were
      // actually touched and quotes the assistant's own first sentence; the
      // old line appended "Changes have been applied and verified" to any
      // long answer, which nothing had verified.
      const completionSummary = summariseOutcome({
        startedAt,
        engine: requestedEngine,
        toolCalls: observed,
        lastText: accumulatedProse,
        finishedAt: Date.now(),
        kind: options.action,
      });

      activityStore.setLatestProgress(
        failureCount > 0 ? `Finished with ${failureCount} failed ${failureCount === 1 ? "call" : "calls"}` : "Finished",
      );
      // Kept, so the question that always follows — "what did it change?" —
      // is answered from what this run actually did rather than by starting
      // another one to find out. See `interceptAside`.
      this.lastReport = { text: completionSummary, finishedAt: Date.now() };
      options.onCompleted?.(completionSummary);
      return completionSummary;
    } catch (err) {
      /*
        A cancellation is not a failure.

        "Stop, cancel that" aborts the controller, the stream rejects, and this
        block used to announce "The background assistant encountered an issue"
        immediately after Temi had said "Stopped." — the operator got the thing
        they asked for and was then told it had gone wrong. The abort is ours;
        we know it happened because we are the ones who caused it.
      */
      const aborted =
        controller.signal.aborted ||
        options.signal?.aborted === true ||
        (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message)));
      if (aborted) {
        activityStore.logAction({
          type: "cmd",
          cmd: "Task stopped",
          result: "Cancelled by the operator",
          status: "success",
        });
        activityStore.setLatestProgress("Stopped");
        // Nothing said. Temi already said "Stopped." from `STOP_ACKNOWLEDGEMENT`
        // the moment the stop was routed, and repeating it would be the second
        // sentence about an event with one.
        return CANCELLED_NOTE;
      }
      const errMsg = err instanceof Error ? err.message : "Execution failed";
      activityStore.logAction({
        type: "cmd",
        cmd: "Task Interrupted / Error",
        result: errMsg,
        status: "failed",
      });
      const spokenError = ((): string => {
        if (/quota|429|rate[- ]limit|too many requests/i.test(errMsg)) {
          return "The cloud provider hit a temporary rate limit. You can switch to the local Frontier model or Claude Code in settings.";
        }
        if (/api[- ]key|unauthorized|401/i.test(errMsg)) {
          return "Authentication with the cloud service failed. Please check your API key in settings.";
        }
        if (/network|fetch failed|timeout|econnrefused/i.test(errMsg)) {
          return "A network timeout occurred while connecting to the assistant.";
        }
        const clean = errMsg
          .replace(/https?:\/\/\S+/g, "")
          .replace(/\[GoogleGenerativeAI Error\]:?/gi, "")
          .replace(/\[.*?\]/g, "")
          .replace(/\{.*?\}/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return clean.length > 0 && clean.length < 120 ? clean : "Execution failed";
      })();
      activityStore.setLatestProgress(`Error: ${spokenError}`);
      options.onCompleted?.(`The background assistant encountered an issue: ${spokenError}`);
      return `Error: ${errMsg}`;
    } finally {
      // Whatever happened, no question may be left standing over a run that
      // has ended: the CLI that asked it is gone, and a late "yes" would
      // answer for a process nobody can reach.
      this.pendingApproval?.settle(false);
      // Only if this run is still the one holding the slot: a stop may already
      // have replaced the controller, and clearing someone else's would let two
      // runs stream into the same activity feed.
      if (this.activeController === controller) {
        this.activeController = null;
        activityStore.setTaskRunning(false);
        this.drain();
      }
    }
  }

  /** Starts the next queued prompt, if the slot is free and one is waiting. */
  private static drain(): void {
    if (this.activeController) return;
    const { queue, next } = dequeueTask(this.queue);
    if (!next) return;
    this.queue = queue;
    void this.runTask(next.prompt, next.options).then(next.settle, () => next.settle(""));
  }

  /**
   * Stops the run and drops what was behind it.
   *
   * Draining the queue after a stop would be the opposite of what a stop means:
   * the operator asked for the work to end, not for the next item to start.
   */
  static stopCurrentTask() {
    const dropped = this.queue;
    this.queue = [];
    // Before the abort, so the CLI sitting inside a blocked tool call is
    // released rather than left waiting on an answer that can no longer
    // arrive.
    this.pendingApproval?.settle(false);
    this.activeController?.abort();
    this.activeController = null;
    useAssistantActivityStore.getState().setTaskRunning(false);
    for (const entry of dropped) {
      entry.options.onCompleted?.(QUEUE_CLEARED_NOTE);
      entry.settle(QUEUE_CLEARED_NOTE);
    }
  }
}
