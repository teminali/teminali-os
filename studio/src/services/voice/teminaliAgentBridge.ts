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
import { summariseOutcome, type NarratableToolCall } from "./progressNarration";
import { useStudioStore } from "../../store/studioStore";
import { useChangeStore } from "../../store/changeStore";
import { useAssistantActivityStore } from "../../store/assistantActivityStore";
import { languageForPath } from "../language";
import {
  describeQueue,
  describeRejection,
  dequeueTask,
  enqueueTask,
  type QueuedTask,
} from "../../utils/taskQueue";
import type { AgentEngine } from "../agentCliService";
import type { ModelModeId, ToolCall } from "../../types";

// The work/talk gate lives in `machineAction.ts` — pure, so `voiceTurnRouter`
// can ask without importing the stores this file depends on. It replaced
// `isEngineeringTask`, whose word-count and question-mark rejections sent
// "play that video" and "open my downloads folder" to a persona with no hands.
export { classifyMachineAction, isMachineAction } from "./machineAction.ts";

export interface TaskDelegationOptions {
  engine?: "frontier" | AgentEngine;
  onProgress?: (summary: string) => void;
  onCompleted?: (finalReport: string) => void;
  signal?: AbortSignal;
}

/** A prompt that arrived while something else was running. */
interface QueuedDelegation extends QueuedTask {
  options: TaskDelegationOptions;
  /** Settles the caller's promise when this one finally runs, or is dropped. */
  settle: (report: string) => void;
}

/** What a queued prompt reports when a stop cleared the queue before its turn. */
export const QUEUE_CLEARED_NOTE = "Dropped — the run was stopped before this reached the front of the queue.";

export class TeminaliAgentBridge {
  private static activeController: AbortController | null = null;
  private static queue: QueuedDelegation[] = [];

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
    if (this.activeController) {
      const result = enqueueTask<QueuedDelegation>(this.queue, {
        id: `queued-${Date.now()}-${this.queue.length}`,
        prompt,
        options,
        settle: () => {},
      });
      if (!result.accepted) {
        const refusal = describeRejection(result.reason);
        if (refusal) options.onProgress?.(refusal);
        return refusal;
      }
      const queue = result.queue;
      this.queue = queue;
      const queued = queue[queue.length - 1];
      const waiting = describeQueue(this.queue.length);
      options.onProgress?.(waiting);
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

  /** Runs one delegation now. Only `delegateTask` and `drain` may call it. */
  private static async runTask(prompt: string, options: TaskDelegationOptions = {}): Promise<string> {
    const store = useStudioStore.getState();
    const activityStore = useAssistantActivityStore.getState();

    const controller = new AbortController();
    this.activeController = controller;

    const requestedEngine =
      options.engine ||
      activityStore.activeEngine ||
      (store.agentSelection?.engine as "frontier" | AgentEngine) ||
      (store.currentProfile === "max" ? "gemini" : "frontier");

    const streamEngine: "frontier" | "claude" | "codex" =
      requestedEngine === "gemini" ? "frontier" : requestedEngine;

    const streamMode: ModelModeId =
      requestedEngine === "gemini" ? "max" : "auto";

    activityStore.setTaskRunning(true, prompt);

    // 1. Initial acknowledgment in activity feed
    activityStore.logAction({
      type: "read",
      file: "Teminali Workspace",
      badge: "read",
      desc: `Task assigned to ${requestedEngine.toUpperCase()} assistant: "${prompt.substring(0, 36)}..."`,
    });

    const initialStatus = `Starting background execution with ${requestedEngine.toUpperCase()}...`;
    activityStore.setLatestProgress(initialStatus);
    options.onProgress?.(initialStatus);

    let accumulatedProse = "";
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
        prompt,
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

            if (name === "runCommand" || name === "bash") {
              const cmd = (args as any)?.command || inputStr;
              const cmdStr = typeof cmd === "string" ? cmd : "command";
              activityStore.logAction({
                type: "cmd",
                cmd: cmdStr,
                result: "Executing in background CLI...",
                status: "running",
              });
              const prog = `Running command: ${cmdStr.substring(0, 32)}...`;
              activityStore.setLatestProgress(prog);
              options.onProgress?.(prog);
            } else if (name === "writeFile" || name === "editFile") {
              const file = (args as any)?.path || "file";
              const filename = typeof file === "string" ? file.split("/").pop() : "file";
              // This fires when the call is *made*. The only line counts that
              // exist yet are the ones the provider attached to the call; the
              // measured ones arrive with the edit event below. Nothing is
              // invented to fill the gap.
              activityStore.logAction({
                type: "edit",
                file,
                badge: "modify",
                plus: call.diff ? `+${call.diff.additions}` : undefined,
                minus: call.diff ? `-${call.diff.deletions} lines` : undefined,
                desc: call.diff ? "Edit requested" : "Edit requested — line counts pending",
                status: call.status === "completed" ? "success" : call.status === "error" ? "failed" : "running",
              });
              const prog = `Modifying ${filename}...`;
              activityStore.setLatestProgress(prog);
              options.onProgress?.(prog);
            } else {
              activityStore.logAction({
                type: "read",
                file: (args as any)?.path || name,
                badge: "read",
                desc: `Tool executed: ${name}`,
              });
              activityStore.setLatestProgress(`Executing tool: ${name}`);
            }
          },
          onComplete: (data) => {
            if (data.fullText) accumulatedProse = data.fullText;
          },
        },
        [],
        {
          mode: streamMode,
          signal: options.signal || controller.signal,
          origin: "voice",
          onWorkspace: (event) => {
            if (event.action === "reveal") store.revealPath(event.path);
            else if (event.action === "open-file") void store.showFile(event.path);
            else if (event.action === "open-folder") store.showFolder(event.path);
            else if (event.action === "open-project") store.setWorkspacePath(event.path);
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
            store.openFile({
              path: event.path,
              name: event.path.split("/").pop() || event.path,
              content: event.after,
              language: languageForPath(event.path),
              encoding: "utf8",
              mimeType: "text/plain",
              size: event.size ?? undefined,
              modified: event.modified ?? undefined,
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
      });

      activityStore.setLatestProgress(
        failureCount > 0 ? `Finished with ${failureCount} failed ${failureCount === 1 ? "call" : "calls"}` : "Finished",
      );
      options.onCompleted?.(completionSummary);
      return completionSummary;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Execution failed";
      activityStore.logAction({
        type: "cmd",
        cmd: "Task Interrupted / Error",
        result: errMsg,
        status: "failed",
      });
      activityStore.setLatestProgress(`Error: ${errMsg}`);
      options.onCompleted?.(`The background assistant encountered an issue: ${errMsg}`);
      return `Error: ${errMsg}`;
    } finally {
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
    this.activeController?.abort();
    this.activeController = null;
    useAssistantActivityStore.getState().setTaskRunning(false);
    for (const entry of dropped) {
      entry.options.onCompleted?.(QUEUE_CLEARED_NOTE);
      entry.settle(QUEUE_CLEARED_NOTE);
    }
  }
}
