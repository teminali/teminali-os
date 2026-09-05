import React, { useEffect, useRef, useState } from "react";
import {
  Braces, ChevronDown, ChevronRight, Code, File, FileCode, FileCog, FileTerminal, FileText,
  Folder, FolderOpen, GitBranch, Hash, LoaderCircle, Package,
} from "lucide-react";
import type { FileItem } from "../../types";
import { useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import { languageForPath as languageFor } from "../../services/language";

/**
 * A file's glyph, tinted in its language colour.
 *
 * This used to render a filled text chip — a 14px square holding "npm", "PY",
 * "{}" and so on. Two things were wrong with it. The chips were a different
 * width on every row, because a flex item's `min-width: auto` lets its content
 * override an explicit `w-3.5`, so each label pushed its own box out by however
 * wide that label happened to be; the result was a ragged column of coloured
 * bars. And a filled chip is not what an editor does: Cursor, like VS Code
 * under it, draws a monochrome glyph tinted in the language's brand colour and
 * puts no background behind it, so the tree reads as a list of files rather
 * than as a stack of labels.
 *
 * A `size`d lucide icon has an intrinsic width, so the alignment problem cannot
 * come back. The hexes here are third-party brand marks, which DESIGN.md §2
 * exempts from the token rule — they identify someone else's language, and are
 * not ours to re-theme.
 */
const LANG = {
  ts: "#3178c6", js: "#f7df1e", json: "#cbcb41", css: "#1572b6", html: "#e44d26",
  md: "#519aba", py: "#3776ab", rs: "#dea584", sh: "#4eaa25", npm: "#cb3837",
  git: "#f05032", folder: "#dcb67a",
} as const;

export const FileIcon: React.FC<{ name: string; isDirectory?: boolean; isOpen?: boolean }> = ({ name, isDirectory, isOpen }) => {
  const Glyph = (icon: React.ElementType, color: string) =>
    React.createElement(icon, { size: 15, strokeWidth: 1.7, className: "shrink-0", style: { color } });

  if (isDirectory) return Glyph(isOpen ? FolderOpen : Folder, LANG.folder);

  const ext = name.split(".").pop()?.toLowerCase() || "";
  const lowerName = name.toLowerCase();

  if (lowerName === "package.json" || lowerName === "package-lock.json") return Glyph(Package, LANG.npm);
  if (lowerName === "tsconfig.json") return Glyph(FileCog, LANG.ts);
  if (lowerName.startsWith(".git")) return Glyph(GitBranch, LANG.git);

  switch (ext) {
    case "ts": case "tsx":            return Glyph(FileCode, LANG.ts);
    case "js": case "jsx": case "mjs": case "cjs": return Glyph(FileCode, LANG.js);
    case "json":                      return Glyph(Braces, LANG.json);
    case "yaml": case "yml": case "toml": return Glyph(FileCog, LANG.json);
    case "css": case "scss":          return Glyph(Hash, LANG.css);
    case "html": case "htm": case "svg": case "xml": return Glyph(Code, LANG.html);
    case "md":                        return Glyph(FileText, LANG.md);
    case "py":                        return Glyph(FileCode, LANG.py);
    case "rs":                        return Glyph(FileCode, LANG.rs);
    case "sh": case "zsh": case "bash": return Glyph(FileTerminal, LANG.sh);
    default:
      return <File size={15} strokeWidth={1.7} className="text-ink-placeholder shrink-0" />;
  }
};

export const FileTreeItem: React.FC<{
  item: FileItem;
  depth?: number;
  filter?: string;
  onError?: (message: string) => void;
}> = ({ item, depth = 0, filter = "", onError }) => {
  const [isLoading, setIsLoading] = useState(false);
  const { openFile, tabs, activeTabId, expandedPaths, toggleExpanded, revealTarget, clearRevealTarget } = useStudioStore();
  const isOpen = expandedPaths.has(item.path);
  const rowRef = useRef<HTMLButtonElement>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isDirectory = item.type === "directory";
  const isSelected = activeTab?.path === item.path;
  const normalizedFilter = filter.trim().toLowerCase();
  const matchingChildren = item.children?.filter((child) => {
    if (!normalizedFilter) return true;
    const matches = child.name.toLowerCase().includes(normalizedFilter) || child.path.toLowerCase().includes(normalizedFilter);
    const descendantMatches = child.children?.some((descendant) => descendant.path.toLowerCase().includes(normalizedFilter));
    return matches || descendantMatches;
  });

  /**
   * Scroll to a row the store asked for. `revealPath` expands the ancestors
   * before this runs, so by the time the target row exists it is mounted and
   * can bring itself into view; it then clears the target so a later reveal of
   * the same path — with a fresh timestamp — scrolls again.
   */
  useEffect(() => {
    if (revealTarget?.path !== item.path) return;
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    clearRevealTarget();
  }, [revealTarget, item.path, clearRevealTarget]);

  const handleClick = async () => {
    if (isDirectory) {
      toggleExpanded(item.path);
      return;
    }
    setIsLoading(true);
    onError?.("");
    try {
      const file = await WorkspaceService.readFile(item.path);
      openFile({ ...file, language: languageFor(file.name) });
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "The file could not be opened.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <button
        ref={rowRef}
        type="button"
        onClick={() => void handleClick()}
        className={`workspace-tree-item ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        title={item.path}
        aria-expanded={isDirectory ? isOpen : undefined}
      >
        {isLoading ? <LoaderCircle size={13} className="workspace-spin" /> : isDirectory ? (
          isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />
        ) : <span className="workspace-tree-spacer" />}
        <FileIcon name={item.name} isDirectory={isDirectory} isOpen={isOpen} />
        <span className="truncate">{item.name}</span>
        {!isDirectory && typeof item.size === "number" && <small className="text-ink-ghost">{item.size < 1024 ? `${item.size} B` : `${Math.ceil(item.size / 1024)} KB`}</small>}
      </button>
      {isDirectory && isOpen && matchingChildren?.map((child) => (
        <FileTreeItem key={child.id} item={child} depth={depth + 1} filter={filter} onError={onError} />
      ))}
    </div>
  );
};
