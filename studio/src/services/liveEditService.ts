import { GatewayError } from "./gatewayClient";
import { WorkspaceService, type WorkspaceFileResponse } from "./workspaceService";
import { parseWorkspaceEdits, type ParsedWorkspaceEdit } from "./liveEditProtocol";
export { parseWorkspaceEdits } from "./liveEditProtocol";

export type LiveEditPhase = "idle" | "streaming" | "committing" | "complete" | "stopped" | "error";

export interface LiveEditSnapshot {
  revision: number;
  requestId: string | null;
  path: string | null;
  displayedContent: string;
  line: number;
  phase: LiveEditPhase;
  following: boolean;
  committed: boolean;
  detail: string;
  file?: WorkspaceFileResponse;
}

/**
 * One file, written. Emitted after the bytes are on disk so a reviewer can
 * offer to put them back — see `store/changeStore.ts`.
 *
 * `before` is the content this service already read to play the edit back
 * against; capturing it here costs nothing and is the only moment it is
 * knowable, because the write that follows destroys it.
 */
export interface CommittedEdit {
  path: string;
  before: string;
  after: string;
  /** False when the assistant created the file — rejecting then means removing it. */
  existedBefore: boolean;
  requestId: string;
}

interface ObserveInput {
  requestId: string;
  text: string;
  isStreaming: boolean;
  activePath?: string;
  userPrompt: string;
  dirtyPaths: string[];
}

class CopilotLiveEditService {
  private listeners = new Set<() => void>();
  private snapshot: LiveEditSnapshot = {
    revision: 0,
    requestId: null,
    path: null,
    displayedContent: "",
    line: 1,
    phase: "idle",
    following: false,
    committed: false,
    detail: "Live Edit idle",
  };
  private baseByPath = new Map<string, WorkspaceFileResponse | null>();
  private targetContent = "";
  private timer: number | null = null;
  private stoppedRequests = new Set<string>();
  private finalizedRequests = new Set<string>();
  private pendingLoads = new Map<string, Promise<WorkspaceFileResponse | null>>();
  private dirtyPaths = new Set<string>();
  private draftRevision = 0;

  private commitListeners = new Set<(edit: CommittedEdit) => void>();

  /** Subscribe to committed writes. Returns the unsubscribe. */
  onCommit = (listener: (edit: CommittedEdit) => void) => {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  observe(input: ObserveInput) {
    this.dirtyPaths = new Set(input.dirtyPaths);
    const edits = parseWorkspaceEdits(input.text, { activePath: input.activePath, userPrompt: input.userPrompt });
    if (input.isStreaming) {
      const draft = edits.at(-1);
      if (draft) {
        this.draftRevision += 1;
        void this.showDraft(input.requestId, draft, this.draftRevision);
      }
      return;
    }
    if (this.finalizedRequests.has(input.requestId)) return;
    this.finalizedRequests.add(input.requestId);
    const completeEdits = edits.filter((edit) => edit.complete);
    if (completeEdits.length > 0) void this.commitEdits(input.requestId, completeEdits);
  }

  stopFollowing = () => {
    if (!this.snapshot.requestId || !this.snapshot.following) return;
    this.stoppedRequests.add(this.snapshot.requestId);
    this.clearTimer();
    const base = this.baseByPath.get(this.snapshot.path || "");
    this.publish({
      displayedContent: this.snapshot.file?.content ?? base?.content ?? "",
      line: 1,
      phase: "stopped",
      following: false,
      detail: "Live Edit view stopped; file commits remain safe",
    });
  };

  cancelResponse = (requestId: string, detail = "Live Edit cancelled; no incomplete file block was committed") => {
    this.finalizedRequests.add(requestId);
    this.stoppedRequests.add(requestId);
    this.draftRevision += 1;
    if (this.snapshot.requestId !== requestId) return;
    this.clearTimer();
    const base = this.baseByPath.get(this.snapshot.path || "");
    this.publish({
      displayedContent: base?.content ?? "",
      line: 1,
      phase: "stopped",
      following: false,
      committed: false,
      detail,
      file: base ?? undefined,
    });
  };

  private async readBase(path: string): Promise<WorkspaceFileResponse | null> {
    if (this.baseByPath.has(path)) return this.baseByPath.get(path) ?? null;
    const pending = this.pendingLoads.get(path);
    if (pending) return pending;
    const request = WorkspaceService.readFile(path)
      .catch((error) => {
        if (error instanceof GatewayError && error.code === "WORKSPACE_FILE_NOT_FOUND") return null;
        throw error;
      })
      .then((file) => {
        this.baseByPath.set(path, file);
        this.pendingLoads.delete(path);
        return file;
      });
    this.pendingLoads.set(path, request);
    return request;
  }

  private async showDraft(requestId: string, edit: ParsedWorkspaceEdit, revision: number) {
    if (this.dirtyPaths.has(edit.path)) {
      this.publish({ requestId, path: edit.path, phase: "error", following: false, committed: false, detail: "Live Edit blocked: save or discard the local unsaved changes first" });
      return;
    }
    try {
      const base = await this.readBase(edit.path);
      if (revision !== this.draftRevision || this.finalizedRequests.has(requestId)) return;
      const switchingFile = this.snapshot.requestId !== requestId || this.snapshot.path !== edit.path;
      const following = !this.stoppedRequests.has(requestId);
      if (switchingFile) {
        this.clearTimer();
        this.publish({
          requestId,
          path: edit.path,
          displayedContent: base?.content ?? "",
          line: 1,
          phase: following ? "streaming" : "stopped",
          following,
          committed: false,
          detail: following ? `Following ${edit.path}` : "Live Edit view stopped",
          file: base ?? undefined,
        });
      }
      this.targetContent = edit.content;
      if (following) this.scheduleTick();
    } catch (error) {
      this.fail(requestId, edit.path, error);
    }
  }

  private async commitEdits(requestId: string, edits: ParsedWorkspaceEdit[]) {
    for (const edit of edits) {
      if (this.dirtyPaths.has(edit.path)) {
        this.fail(requestId, edit.path, new Error("Save or discard local unsaved changes before Copilot edits this file."));
        continue;
      }
      try {
        const base = await this.readBase(edit.path);
        const following = !this.stoppedRequests.has(requestId);
        this.clearTimer();
        this.targetContent = edit.content;
        this.publish({
          requestId,
          path: edit.path,
          displayedContent: following ? (base?.content ?? "") : edit.content,
          line: 1,
          phase: "committing",
          following,
          committed: false,
          detail: `Committing ${edit.path}`,
          file: base ?? undefined,
        });
        const written = await WorkspaceService.writeFile(edit.path, edit.content, base?.modified ?? null);
        this.commitListeners.forEach((listener) =>
          listener({
            path: edit.path,
            before: base?.content ?? "",
            after: written.content,
            existedBefore: base !== null,
            requestId,
          }),
        );
        this.baseByPath.set(edit.path, written);
        this.targetContent = written.content;
        if (following) {
          this.publish({ file: written, committed: true, detail: `Saved ${edit.path}; finishing Live Edit playback` });
          this.scheduleTick();
          await this.waitUntilPlaybackSettles();
        }
        this.publish({
          displayedContent: written.content,
          line: Math.max(1, written.content.split("\n").length),
          phase: following ? "complete" : "stopped",
          following: false,
          committed: true,
          detail: following ? `Live Edit saved ${edit.path}` : `Saved ${edit.path}; Live Edit view remains stopped`,
          file: written,
        });
      } catch (error) {
        this.fail(requestId, edit.path, error);
      }
    }
  }

  private scheduleTick() {
    if (this.timer !== null || !this.snapshot.following) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const current = this.snapshot.displayedContent;
      let prefix = 0;
      while (prefix < current.length && prefix < this.targetContent.length && current[prefix] === this.targetContent[prefix]) prefix += 1;
      const stable = current.slice(0, prefix);
      const remaining = this.targetContent.slice(prefix);
      const chunkSize = Math.max(2, Math.ceil(remaining.length / 24));
      const next = stable + remaining.slice(0, chunkSize);
      this.publish({ displayedContent: next, line: Math.max(1, next.split("\n").length) });
      if (next !== this.targetContent) this.scheduleTick();
    }, 24);
  }

  private waitUntilPlaybackSettles(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.snapshot.following || this.snapshot.displayedContent === this.targetContent) resolve();
        else window.setTimeout(check, 24);
      };
      check();
    });
  }

  private clearTimer() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(requestId: string, path: string, error: unknown) {
    const detail = error instanceof Error ? error.message : "Workspace edit failed.";
    this.publish({ requestId, path, phase: "error", following: false, committed: false, detail });
  }

  private publish(change: Partial<LiveEditSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change, revision: this.snapshot.revision + 1 };
    this.listeners.forEach((listener) => listener());
  }
}

export const LiveEditService = new CopilotLiveEditService();
