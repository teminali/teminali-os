import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { useStudioStore } from "../../store/studioStore";
import { LiveEditService } from "../../services/liveEditService";

function languageForPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    css: "css", html: "html", htm: "html", js: "javascript", jsx: "javascriptreact", json: "json",
    md: "markdown", mjs: "javascript", py: "python", svg: "xml", ts: "typescript", tsx: "typescriptreact",
    xml: "xml", yaml: "yaml", yml: "yaml",
  } as Record<string, string>)[extension || ""] || "plaintext";
}

export const CopilotLiveEditController: React.FC = () => {
  const snapshot = useSyncExternalStore(LiveEditService.subscribe, LiveEditService.getSnapshot, LiveEditService.getSnapshot);
  const { frontierMessages, tabs, activeTabId, openFile, syncFileContent, openBrowserPreview } = useStudioStore();
  const liveResponseIds = useRef(new Set<string>());
  const latestAssistant = [...frontierMessages].reverse().find((message) => message.role === "assistant");
  const assistantIndex = latestAssistant ? frontierMessages.findIndex((message) => message.id === latestAssistant.id) : -1;
  const previousUser = assistantIndex > 0
    ? [...frontierMessages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user")
    : undefined;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const dirtyPaths = tabs.filter((tab) => tab.isDirty && !tab.path.startsWith("untitled:")).map((tab) => tab.path);

  useEffect(() => {
    if (!latestAssistant) return;
    if (latestAssistant.isStreaming) liveResponseIds.current.add(latestAssistant.id);
    if (!liveResponseIds.current.has(latestAssistant.id)) return;
    if (!latestAssistant.isStreaming && (latestAssistant.cancelled || latestAssistant.errorCode)) {
      LiveEditService.cancelResponse(latestAssistant.id, latestAssistant.cancelled
        ? "Live Edit stopped with generation; incomplete edits were not committed"
        : "Live Edit stopped because generation failed; incomplete edits were not committed");
      liveResponseIds.current.delete(latestAssistant.id);
      return;
    }
    LiveEditService.observe({
      requestId: latestAssistant.id,
      text: latestAssistant.content,
      isStreaming: latestAssistant.isStreaming === true,
      activePath: activeTab?.path,
      userPrompt: previousUser?.content || "",
      dirtyPaths,
    });
    if (!latestAssistant.isStreaming) liveResponseIds.current.delete(latestAssistant.id);
  }, [latestAssistant?.id, latestAssistant?.content, latestAssistant?.isStreaming, latestAssistant?.cancelled, latestAssistant?.errorCode, activeTab?.path, previousUser?.content, dirtyPaths.join("\0")]);

  useEffect(() => {
    if (!snapshot.path || snapshot.phase === "idle" || snapshot.phase === "error") return;
    const name = snapshot.path.split("/").pop() || snapshot.path;
    const file = snapshot.file;
    if (snapshot.following) {
      openFile({
        path: snapshot.path,
        name,
        content: snapshot.displayedContent,
        language: languageForPath(snapshot.path),
        encoding: "utf8",
        mimeType: file?.mimeType || "text/plain",
        size: file?.size,
        modified: file?.modified,
      });
      if (name.endsWith(".html") || name.endsWith(".htm")) {
        openBrowserPreview(snapshot.path);
      }
    } else {
      syncFileContent({
        path: snapshot.path,
        content: snapshot.displayedContent,
        modified: file?.modified,
        size: file?.size,
        mimeType: file?.mimeType,
      });
    }
  }, [snapshot.revision, openFile, syncFileContent]);

  return null;
};
