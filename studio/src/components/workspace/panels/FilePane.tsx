import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Save, RotateCcw, AlertTriangle } from "lucide-react";
import { WorkspaceService } from "../../../services/workspaceService";
import { highlightCode } from "../../../utils/syntaxHighlight";
import { IconButton, EmptyState } from "../../ui";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { useStudioStore } from "../../../store/studioStore";

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
 */

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

  const preRef = useRef<HTMLPreElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!panel.path) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    WorkspaceService.readFile(panel.path, controller.signal)
      .then((file) => {
        if (file.encoding === "base64") {
          setError("This file is binary and cannot be shown as text.");
          setContent(null);
          return;
        }
        setContent(file.content);
        setOriginal(file.content);
        setModified(file.modified);
        update(panel.id, { label: file.name });
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

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (!panel.path) {
    return <EmptyState title="No file selected" detail="Open a file from the sidebar or a chat message." />;
  }

  if (error && content === null) {
    return (
      <EmptyState
        icon={<AlertTriangle size={26} strokeWidth={1.6} />}
        title="This file could not be opened"
        detail={error}
      />
    );
  }

  const lineCount = content ? content.split("\n").length : 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-9 flex-shrink-0 flex items-center gap-2 px-4 border-b border-edge-chrome text-2xs text-ink-muted font-mono">
        <span className="truncate">{panel.path.split("/").join(" / ")}</span>
        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" title="Unsaved changes" />}
        <div className="flex-1" />
        <span className="text-ink-disabled">{lineCount} lines</span>
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
          aria-label={`Contents of ${panel.path}`}
          className="absolute inset-0 pl-12 pr-4 pt-4 bg-transparent text-transparent caret-ink-high resize-none outline-none whitespace-pre overflow-auto font-mono text-xs leading-[1.75] selection:bg-accent/25"
        />
      </div>
    </div>
  );
};
