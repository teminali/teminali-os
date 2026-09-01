import React, { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, LoaderCircle, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useStudioStore } from "../../store/studioStore";
import { WorkspaceService } from "../../services/workspaceService";
import { GlobalSearchView } from "../search/GlobalSearchView";
import { ExtensionMarketplace } from "../extensions/ExtensionMarketplace";
import { FileTreeItem } from "./FileTree";

export const Sidebar: React.FC<{ activeView: string }> = ({ activeView }) => {
  const { files, setFiles } = useStudioStore();
  const [rootName, setRootName] = useState("frontier");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [entryCount, setEntryCount] = useState(0);
  const [isTruncated, setIsTruncated] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setError("");
    try {
      const workspace = await WorkspaceService.listFiles(signal);
      setFiles(workspace.files);
      setRootName(workspace.rootName);
      setEntryCount(workspace.entryCount);
      setIsTruncated(workspace.truncated);
    } catch (requestError) {
      if (signal?.aborted) return;
      setError(requestError instanceof Error ? requestError.message : "Workspace unavailable.");
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, [setFiles]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const visibleFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return files;
    return files.filter((item) => item.path.toLowerCase().includes(query) || item.children?.some((child) => child.path.toLowerCase().includes(query)));
  }, [files, filter]);

  if (activeView === "search") return <aside className="explorer-panel"><GlobalSearchView /></aside>;
  if (activeView === "extensions") return <aside className="explorer-panel explorer-feature-panel"><ExtensionMarketplace /></aside>;
  if (activeView === "source-control") {
    return (
      <aside className="explorer-panel source-control-empty">
        <div className="panel-title"><span>SOURCE CONTROL</span><GitBranch size={16} /></div>
        <div className="truthful-empty-state">
          <ShieldCheck size={24} />
          <strong>Repository is protected</strong>
          <p>Source-control mutations are not exposed in the browser UI yet. Use the verified terminal workflow for commits and branches.</p>
          <button type="button" disabled title="Git mutations are intentionally unavailable in this browser build">Commit actions unavailable</button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="explorer-panel">
      <div className="panel-title explorer-title-row">
        <span>EXPLORER</span>
        <button type="button" onClick={() => void refresh()} disabled={isLoading} aria-label="Refresh workspace" title="Refresh workspace">
          {isLoading ? <LoaderCircle size={16} className="workspace-spin" /> : <RefreshCw size={16} />}
        </button>
      </div>
      <div className="explorer-filter">
        <Search size={14} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" aria-label="Filter workspace files" />
      </div>
      <div className="workspace-root-label">
        <span>{rootName}</span>
        <small>{entryCount}{isTruncated ? "+" : ""} entries · read only</small>
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}
      <div className="workspace-tree" aria-label={`${rootName} files`}>
        {!isLoading && visibleFiles.length === 0 && !error && <p className="workspace-empty">No supported files match.</p>}
        {visibleFiles.map((item) => <FileTreeItem key={item.id} item={item} filter={filter} onError={setError} />)}
      </div>
    </aside>
  );
};
