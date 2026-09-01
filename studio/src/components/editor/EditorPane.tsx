import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Editor from "@monaco-editor/react";
import { Check, ChevronDown, Copy, Eye, FileCode2, FileText, Plus, Sparkles, Square, X } from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { AutocompleteService } from "../../services/autocompleteService";
import { InlineCommandBar } from "./InlineCommandBar";
import { LiveEditService } from "../../services/liveEditService";
import { shouldPersistEditorChange } from "../../store/tabIdentity";
import { FileIcon } from "../sidebar/FileTree";

export const EditorPane: React.FC<{ onPreview: () => void }> = ({ onPreview }) => {
  const [isInlineBarOpen, setIsInlineBarOpen] = useState(false);
  const [cursorPos, setCursorPos] = useState({ lineNumber: 1, column: 1 });
  const [zoom, setZoom] = useState(88);
  const [isZoomOpen, setZoomOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<any>(null);
  const liveDecorationsRef = useRef<string[]>([]);
  const liveEdit = useSyncExternalStore(LiveEditService.subscribe, LiveEditService.getSnapshot, LiveEditService.getSnapshot);
  const { tabs, activeTabId, setActiveTab, closeTab, updateTabContent, addUntitledTab, targetEditorScroll } = useStudioStore();
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) || null, [tabs, activeTabId]);
  const isBinary = activeTab?.encoding === "base64";
  const isLiveActive = liveEdit.following && liveEdit.path === activeTab?.path && ["streaming", "committing"].includes(liveEdit.phase);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!isLiveActive) {
      liveDecorationsRef.current = editor.deltaDecorations(liveDecorationsRef.current, []);
      return;
    }
    const line = Math.min(Math.max(1, liveEdit.line), editor.getModel()?.getLineCount() || 1);
    editor.setPosition({ lineNumber: line, column: editor.getModel()?.getLineMaxColumn(line) || 1 });
    editor.revealLineInCenterIfOutsideViewport(line, 0);
    liveDecorationsRef.current = editor.deltaDecorations(liveDecorationsRef.current, [{
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: true, className: "copilot-live-edit-line" },
    }]);
  }, [liveEdit.revision, isLiveActive]);

  
  // Smooth scroll and line highlight when jumping from chat code snippet
  useEffect(() => {
    if (!targetEditorScroll || !editorRef.current) return;
    const editor = editorRef.current;
    const model = editor.getModel();
    if (!model) return;

    const line = Math.min(Math.max(1, targetEditorScroll.lineNumber), model.getLineCount());
    const endLine = Math.min(Math.max(line, targetEditorScroll.endLineNumber || line), model.getLineCount());

    editor.revealLineInCenter(line, 0);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.setSelection({
      startLineNumber: line,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: model.getLineMaxColumn(endLine),
    });

    const highlightDecorations = editor.deltaDecorations([], [
      {
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: endLine,
          endColumn: model.getLineMaxColumn(endLine),
        },
        options: {
          isWholeLine: true,
          className: "bg-[#FF6C37]/20 border-l-2 border-[#FF6C37]",
        },
      },
    ]);

    const timer = setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.deltaDecorations(highlightDecorations, []);
      }
    }, 2800);

    return () => clearTimeout(timer);
  }, [targetEditorScroll, activeTabId]);

  const copyActiveFile = async () => {
    if (!activeTab || isBinary) return;
    await navigator.clipboard.writeText(activeTab.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <div className="editor-shell relative">
      <InlineCommandBar
        isOpen={isInlineBarOpen}
        onClose={() => setIsInlineBarOpen(false)}
        cursorPosition={cursorPos}
        onApplyCode={(newCode) => {
          const editor = editorRef.current;
          if (!editor) return;
          const selection = editor.getSelection();
          editor.executeEdits("frontier-inline", [{ range: selection, text: `${newCode}\n`, forceMoveMarkers: true }]);
        }}
      />

      <div className="tabs-row">
        <div className="file-tabs" role="tablist" aria-label="Open files">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={tab.id === activeTabId} onClick={() => setActiveTab(tab.id)} className={`file-tab ${tab.id === activeTabId ? "active" : ""}`} title={tab.path}>
              <FileIcon name={tab.name} />
              <span>{tab.name}{tab.isDirty ? " •" : ""}</span>
              <X size={13} onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }} aria-label={`Close ${tab.name}`} />
            </button>
          ))}
          <button type="button" className="new-tab" aria-label="New untitled file" title="New untitled file" onClick={addUntitledTab}><Plus size={15} /></button>
        </div>

        <div className="editor-tools">
          {isLiveActive ? (
            <div className="live-edit-toolbar" role="status" aria-live="polite">
              <span><i />Live Edit · read mode</span>
              <button type="button" onClick={LiveEditService.stopFollowing} title="Stop following Copilot edits without cancelling or corrupting the file write"><Square size={10} fill="currentColor" />Stop Live Edit</button>
            </div>
          ) : <span className="workspace-readonly-badge" title="Files are editable normally; Copilot Live Edit temporarily uses read mode">Editor</span>}
          <button type="button" onClick={() => setIsInlineBarOpen(true)} className="editor-ai-command" title="Inline AI Prompt (⌘K)"><Sparkles size={13} /><span>⌘K</span></button>
          <div className="editor-zoom-wrap">
            <button type="button" className="zoom" onClick={() => setZoomOpen((value) => !value)} aria-expanded={isZoomOpen}>{zoom}% <ChevronDown size={12} /></button>
            {isZoomOpen && <div className="editor-zoom-menu" role="menu">{[75, 88, 100, 115, 130].map((value) => <button type="button" key={value} onClick={() => { setZoom(value); setZoomOpen(false); }}>{value}%{zoom === value && <Check size={12} />}</button>)}</div>}
          </div>
          <button type="button" className="editor-secondary-tool" aria-label="Copy file contents" title={isBinary ? "Binary files cannot be copied as text" : "Copy file contents"} disabled={!activeTab || isBinary} onClick={() => void copyActiveFile()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
          <button type="button" className="editor-secondary-tool" aria-label="Open Preview" title="Open selected file in Preview" onClick={onPreview} disabled={!activeTab}><Eye size={15} /></button>
        </div>
      </div>

      {activeTab && (
        <div className="editor-breadcrumbs flex items-center gap-1.5 px-3 py-1 bg-[#1e1e1e] border-b border-[#252526] text-3xs text-[#858585] select-none font-mono flex-shrink-0">
          <span className="text-[#969696] hover:text-[#cccccc] cursor-pointer">frontier</span>
          <span>&gt;</span>
          {activeTab.path?.split("/").slice(0, -1).filter(Boolean).map((segment, idx) => (
            <React.Fragment key={idx}>
              <span className="text-[#858585] hover:text-[#cccccc] cursor-pointer">{segment}</span>
              <span>&gt;</span>
            </React.Fragment>
          ))}
          <FileIcon name={activeTab.name} />
          <span className="text-[#cccccc] font-medium">{activeTab.name}</span>
        </div>
      )}

      <div className="code-wrap relative" style={{ height: "calc(100% - 51px)", padding: 0 }}>
        {!activeTab ? (
          <div className="editor-empty-state"><FileCode2 size={30} /><strong>No file open</strong><p>Select a workspace file in Explorer or create an untitled buffer.</p></div>
        ) : isBinary ? (
          <div className="editor-empty-state"><Eye size={30} /><strong>{activeTab.name} is a preview file</strong><p>Use Preview to inspect this {activeTab.mimeType || "binary"} file safely.</p><button type="button" onClick={onPreview}>Open Preview</button></div>
        ) : (
          <Editor
            height="100%"
            theme="vs-dark"
            path={activeTab.path}
            language={activeTab.language}
            value={activeTab.content}
            onChange={(content) => {
              if (shouldPersistEditorChange(isLiveActive)) updateTabContent(activeTab.id, content ?? "");
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              editor.onDidChangeCursorPosition((event: any) => setCursorPos({ lineNumber: event.position.lineNumber, column: event.position.column }));
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => setIsInlineBarOpen(true));
              monaco.languages.registerInlineCompletionsProvider(activeTab.language, {
                provideInlineCompletions: async (model: any, position: any) => {
                  const before = model.getValueInRange({ startLineNumber: Math.max(1, position.lineNumber - 30), startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
                  if (before.trim().length < 5) return { items: [] };
                  const after = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 10), endColumn: 100 });
                  const text = await AutocompleteService.getInlineCompletion(before, after, activeTab.language);
                  return text ? { items: [{ insertText: text, range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column } }] } : { items: [] };
                },
                freeInlineCompletions: () => {},
              });
            }}
            options={{
              fontSize: Math.round(13.5 * zoom / 88), fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace",
              minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, smoothScrolling: true,
              cursorBlinking: "smooth", cursorSmoothCaretAnimation: "on", lineNumbers: "on", renderLineHighlight: "all",
              inlineSuggest: { enabled: true, mode: "subword" }, bracketPairColorization: { enabled: true }, stickyScroll: { enabled: true }, tabSize: 2, padding: { top: 12 },
              readOnly: isLiveActive,
              readOnlyMessage: { value: "Copilot Live Edit is playing. Use Stop Live Edit to regain manual control without cancelling the underlying file write." },
            }}
          />
        )}
      </div>
    </div>
  );
};
