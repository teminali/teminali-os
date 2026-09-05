import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Save, RotateCcw, AlertTriangle, FolderInput } from "lucide-react";
import { WorkspaceService } from "../../../services/workspaceService";
import { highlightCode } from "../../../utils/syntaxHighlight";
import { IconButton, EmptyState, Button } from "../../ui";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { useStudioStore } from "../../../store/studioStore";
import { formatBytes } from "../../../services/guardianService";
import { describesWorkspaceDrop, resolveWorkspaceDrop, workspaceRelative } from "../../../services/workspaceDrop";

/**
 * File viewer and editor.
 *
 * A highlighted <pre> sits underneath a transparent <textarea>, which is the
 * trick that keeps caret behaviour, selection, undo and IME support native
 * while still colouring the code. The two must share font metrics exactly or
 * the caret drifts, so both read the same tokens.
 *
 * Saving is guarded by the modified timestamp the read returned: if the file
 * changed on disk in the meantime the gateway rejects the write rather than
 * silently discarding someone else's edit.
 *
 * A file the gateway sends as base64 is not text and never goes near the
 * textarea. It becomes an object URL — a picture for an image, Chromium's own
 * viewer for a PDF — because the alternative this replaced was a flat refusal
 * to show a file the operator had just clicked on. The bytes are already in
 * memory as base64; the Blob exists so the DOM holds one copy rather than a
 * second one inlined into an attribute.
 *
 * It is also the landing for a dropped file, from the Explorer or from Finder.
 * `services/workspaceDrop.ts` decides what a drop means; this component only
 * acts on the answer, and the one answer it cannot act on alone — a file that
 * lives outside the project — becomes an offer to switch projects rather than a
 * silent failure or a read across the workspace boundary.
 */

interface Preview {
  url: string;
  mimeType: string;
  size: number;
}

function blobFrom(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  cjs: "javascript", json: "json", css: "css", scss: "css", html: "markup",
  svg: "markup", md: "markdown", py: "python", sql: "sql", yml: "yaml",
  yaml: "yaml", sh: "bash", bash: "bash", zsh: "bash",
};

function languageOf(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGES[extension] ?? "javascript";
}

export const FilePane: React.FC<{ panel: PanelTab }> = ({ panel }) => {
  const update = usePanelStore((state) => state.update);
  const syncFileContent = useStudioStore((state) => state.syncFileContent);

  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [modified, setModified] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const workspacePath = useStudioStore((state) => state.workspacePath);
  const showFile = useStudioStore((state) => state.showFile);
  const setWorkspacePath = useStudioStore((state) => state.setWorkspacePath);
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  /** A drop from outside the project, waiting for the operator to say yes. */
  const [offer, setOffer] = useState<{ folder: string; file: string | null } | null>(null);
  const [switching, setSwitching] = useState(false);

  const preRef = useRef<HTMLPreElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * What a drop onto this pane does.
   *
   * `DataTransfer` is emptied the moment this handler returns, so everything is
   * read out of it synchronously and the decision made before any await.
   * `dragover` only sees the *types*, never the payload — the platform hides
   * the data until a drop actually happens — so the highlight is as specific as
   * it is allowed to be and no more.
   */
  const handleDrop = (event: React.DragEvent) => {
    if (!describesWorkspaceDrop(event.dataTransfer?.types)) return;
    event.preventDefault();
    setDragging(false);
    setDropNote(null);

    const bridge = (window.teminali as unknown as {
      media?: { getPathForFile?: (file: File) => string | null };
    } | undefined)?.media;

    const outcome = resolveWorkspaceDrop<File>(event.dataTransfer, {
      root: workspacePath,
      getPathForFile: bridge?.getPathForFile,
    });
    if (!outcome) return;

    if (outcome.kind === "unavailable") {
      setDropNote(outcome.reason);
      return;
    }
    if (outcome.kind === "switch") {
      setOffer({ folder: outcome.folder, file: outcome.file });
      return;
    }
    setOffer(null);
    // Each path gets its own panel, exactly as a click or `open_file` would;
    // the last one dropped ends up in front, which is what a hand expects.
    for (const path of outcome.paths) void showFile(path);
    if (outcome.skipped > 0) {
      setDropNote(
        outcome.skipped === 1
          ? "One item was outside this project and was not opened."
          : `${outcome.skipped} items were outside this project and were not opened.`,
      );
    }
  };

  /**
   * Accepting the offer takes the same road a My Projects click takes —
   * `openProject` rebinds every workspace and terminal route at the gateway —
   * and only then asks for the file, now that it is inside the new root. There
   * is no path that reads a file from outside the workspace.
   */
  const acceptOffer = async () => {
    if (!offer) return;
    setSwitching(true);
    setDropNote(null);
    try {
      const response = await WorkspaceService.openProject(offer.folder);
      const root = response.current.path;
      setWorkspacePath(root);
      setOffer(null);
      if (offer.file) {
        const relative = workspaceRelative(`${offer.folder}/${offer.file}`, root);
        if (relative) void showFile(relative);
      }
    } catch (failure) {
      setDropNote((failure as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  useEffect(() => {
    if (!panel.path) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPreview(null);

    WorkspaceService.readFile(panel.path, controller.signal)
      .then((file) => {
        update(panel.id, { label: file.name });
        if (file.encoding === "base64") {
          setContent(null);
          setPreview({ url: URL.createObjectURL(blobFrom(file.content, file.mimeType)), mimeType: file.mimeType, size: file.size });
          return;
        }
        setContent(file.content);
        setOriginal(file.content);
        setModified(file.modified);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError((failure as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.path, panel.id]);

  // One object URL is alive at a time; the browser holds the bytes until it is
  // revoked, so this runs on every replacement and not only on unmount.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  const dirty = content !== null && content !== original;
  const language = useMemo(() => languageOf(panel.path ?? ""), [panel.path]);
  const highlighted = useMemo(
    () => (content === null ? "" : highlightCode(content, language)),
    [content, language],
  );

  const save = async () => {
    if (!panel.path || content === null || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const written = await WorkspaceService.writeFile(panel.path, content, modified);
      setOriginal(content);
      setModified(written.modified);
      syncFileContent({ path: written.path, content, modified: written.modified, size: written.size });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // The highlighted layer must track the textarea's scroll exactly.
  const syncScroll = () => {
    const pre = preRef.current;
    const area = areaRef.current;
    if (!pre || !area) return;
    pre.scrollTop = area.scrollTop;
    pre.scrollLeft = area.scrollLeft;
  };

  const lineCount = content ? content.split("\n").length : 0;
  const path = panel.path;

  /*
    One body, four shapes — assigned rather than returned early, because all
    four have to hang inside the same drop target below. A pane showing nothing
    is the one most likely to be dropped on.
  */
  let body: React.ReactNode;

  if (loading) {
    body = (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  } else if (!path) {
    body = <EmptyState title="No file selected" detail="Open a file from the sidebar, drop one here, or ask in a chat message." />;
  } else if (error && content === null && !preview) {
    body = (
      <EmptyState
        icon={<AlertTriangle size={26} strokeWidth={1.6} />}
        title="This file could not be opened"
        detail={error}
      />
    );
  } else {
    body = (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-9 flex-shrink-0 flex items-center gap-2 px-4 border-b border-edge-chrome text-2xs text-ink-muted font-mono">
        <span className="truncate">{path.split("/").join(" / ")}</span>
        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" title="Unsaved changes" />}
        <div className="flex-1" />
        <span className="text-ink-disabled">{preview ? formatBytes(preview.size) : `${lineCount} lines`}</span>
        {dirty && (
          <>
            <IconButton onClick={() => setContent(original)} title="Revert" size={22}>
              <RotateCcw size={12} />
            </IconButton>
            <IconButton onClick={save} disabled={saving} title="Save (⌘S)" size={22}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            </IconButton>
          </>
        )}
      </div>

      {error && <div className="px-4 py-2 text-2xs text-danger border-b border-edge-chrome">{error}</div>}

      {preview ? (
        <PreviewSurface preview={preview} path={path} />
      ) : (
      <div className="flex-1 min-h-0 relative font-mono text-xs leading-[1.75]">
        {/* Gutter */}
        <div
          aria-hidden
          className="absolute top-0 left-0 bottom-0 w-12 pt-4 text-right pr-3 text-ink-disabled select-none overflow-hidden"
        >
          {Array.from({ length: lineCount }).map((_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>

        <pre
          ref={preRef}
          aria-hidden
          className="absolute inset-0 pl-12 pr-4 pt-4 m-0 overflow-auto whitespace-pre text-ink-code pointer-events-none"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
        <textarea
          ref={areaRef}
          value={content ?? ""}
          onChange={(event) => setContent(event.target.value)}
          onScroll={syncScroll}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
          spellCheck={false}
          aria-label={`Contents of ${path}`}
          className="absolute inset-0 pl-12 pr-4 pt-4 bg-transparent text-transparent caret-ink-high resize-none outline-none whitespace-pre overflow-auto font-mono text-xs leading-[1.75] selection:bg-accent/25"
        />
      </div>
      )}
    </div>
    );
  }

  /*
    The drop target.

    `dragover` must be accepted — `preventDefault` — or no `drop` event is ever
    delivered here, and the window guard in `services/dropGuard.ts` would refuse
    the drag on this pane's behalf. `dragleave` fires on every child boundary
    crossed on the way in, so the highlight is only taken down when the pointer
    has actually left this element.
  */
  return (
    <div
      className={`flex-1 min-h-0 flex flex-col relative ${dragging ? "lit lit-accent" : ""}`}
      onDragOver={(event) => {
        if (!describesWorkspaceDrop(event.dataTransfer?.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {body}

      {dragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/80 backdrop-blur-[2px] pointer-events-none">
          <p className="text-xs text-accent">Drop to open here.</p>
        </div>
      )}

      {offer && (
        <div className="flex-shrink-0 border-t border-edge-chrome px-4 py-3 flex items-start gap-3">
          <FolderInput size={16} className="text-ink-muted mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-ink-high">
              {offer.file ? `“${offer.file}” is outside this project.` : "That folder is not this project."}
            </p>
            <p className="text-2xs text-ink-muted font-mono truncate mt-0.5">{offer.folder}</p>
          </div>
          <Button size="xs" variant="ghost" onClick={() => setOffer(null)} disabled={switching}>
            Cancel
          </Button>
          <Button size="xs" variant="primary" onClick={() => void acceptOffer()} loading={switching}>
            Open as project
          </Button>
        </div>
      )}

      {dropNote && (
        <div className="flex-shrink-0 border-t border-edge-chrome px-4 py-2 text-2xs text-ink-muted flex items-center gap-2">
          <span className="flex-1 min-w-0 truncate">{dropNote}</span>
          <button type="button" className="text-ink-disabled hover:text-ink-high" onClick={() => setDropNote(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * The non-text half of the pane.
 *
 * PDFs go to an <iframe>, which in the desktop app is Chromium's PDF viewer —
 * paging, zoom, find and print for free, and no dependency to keep current.
 * That viewer needs `plugins: true` on the window (electron/main.cjs); without
 * it the frame renders blank rather than failing loudly, which is why the
 * flag and this component have to move together.
 *
 * Anything else that arrives as bytes — a spreadsheet today — says so plainly
 * instead of pretending to be broken.
 */
const PreviewSurface: React.FC<{ preview: Preview; path?: string }> = ({ preview, path }) => {
  if (preview.mimeType.startsWith("image/")) {
    return (
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6 bg-surface-sunken">
        <img src={preview.url} alt={path ?? "Image preview"} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }

  if (preview.mimeType === "application/pdf") {
    return <iframe src={preview.url} title={path ?? "PDF preview"} className="flex-1 min-h-0 w-full border-0 bg-surface-sunken" />;
  }

  return (
    <EmptyState
      icon={<AlertTriangle size={26} strokeWidth={1.6} />}
      title="No viewer for this format yet"
      detail={`${preview.mimeType} · ${formatBytes(preview.size)}. It opens in an external application until a viewer lands here.`}
    />
  );
};
