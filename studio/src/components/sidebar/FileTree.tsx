import React, { useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import type { FileItem } from "../../types";
import { useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";

function languageFor(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    css: "css", csv: "plaintext", html: "html", htm: "html", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", mjs: "javascript", py: "python", rs: "rust", sh: "shell",
    sql: "sql", svg: "xml", toml: "toml", ts: "typescript", tsx: "typescript", txt: "plaintext",
    xml: "xml", yaml: "yaml", yml: "yaml",
  };
  return languages[extension || ""] || "plaintext";
}

export const FileIcon: React.FC<{ name: string; isDirectory?: boolean; isOpen?: boolean }> = ({ name, isDirectory, isOpen }) => {
  if (isDirectory) {
    return isOpen 
      ? <FolderOpen size={15} className="text-[#dcb67a] flex-shrink-0" />
      : <Folder size={15} className="text-[#dcb67a] flex-shrink-0" />;
  }

  const ext = name.split(".").pop()?.toLowerCase() || "";
  const lowerName = name.toLowerCase();

  if (lowerName === "package.json") {
    return <span className="w-3.5 h-3.5 rounded-sm bg-[#cb3837]/20 text-[#cb3837] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">npm</span>;
  }
  if (lowerName === "tsconfig.json") {
    return <span className="w-3.5 h-3.5 rounded-sm bg-[#3178c6]/20 text-[#3178c6] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">TS</span>;
  }
  if (lowerName.startsWith(".git")) {
    return <span className="w-3.5 h-3.5 rounded-sm bg-[#f05032]/20 text-[#f05032] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">git</span>;
  }

  switch (ext) {
    case "ts":
    case "tsx":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#3178c6]/20 text-[#3178c6] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">TS</span>;
    case "js":
    case "jsx":
    case "mjs":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#f7df1e]/20 text-[#e5a00d] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">JS</span>;
    case "json":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#cbcb41]/20 text-[#cbcb41] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">{"{}"}</span>;
    case "css":
    case "scss":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#42a5f5]/20 text-[#42a5f5] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">#</span>;
    case "html":
    case "svg":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#e44d26]/20 text-[#e44d26] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">&lt;&gt;</span>;
    case "md":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#61afef]/20 text-[#61afef] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">M↓</span>;
    case "py":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#3776ab]/20 text-[#3776ab] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">PY</span>;
    case "rs":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#dea584]/20 text-[#dea584] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">RS</span>;
    case "sh":
    case "zsh":
      return <span className="w-3.5 h-3.5 rounded-sm bg-[#4eaa25]/20 text-[#4eaa25] text-[9px] font-bold flex items-center justify-center font-mono flex-shrink-0">$_</span>;
    default:
      return <File size={14} className="text-[#858585] flex-shrink-0" />;
  }
};

export const FileTreeItem: React.FC<{
  item: FileItem;
  depth?: number;
  filter?: string;
  onError?: (message: string) => void;
}> = ({ item, depth = 0, filter = "", onError }) => {
  const [isOpen, setIsOpen] = useState(depth === 0 && ["src", "studio"].includes(item.name));
  const [isLoading, setIsLoading] = useState(false);
  const { openFile, tabs, activeTabId } = useStudioStore();
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

  const handleClick = async () => {
    if (isDirectory) {
      setIsOpen((current) => !current);
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
        {!isDirectory && typeof item.size === "number" && <small className="text-[#666666]">{item.size < 1024 ? `${item.size} B` : `${Math.ceil(item.size / 1024)} KB`}</small>}
      </button>
      {isDirectory && isOpen && matchingChildren?.map((child) => (
        <FileTreeItem key={child.id} item={child} depth={depth + 1} filter={filter} onError={onError} />
      ))}
    </div>
  );
};
