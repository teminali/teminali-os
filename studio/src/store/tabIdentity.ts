export function findTabByFileIdentity<T extends { path?: string; name: string }>(
  tabs: T[],
  filePath: string,
  name: string = ""
): T | undefined {
  const fileName = name || filePath.split("/").pop() || filePath;
  // Exact workspace path is the only trustworthy identity. Matching on bare
  // filename would focus an unrelated tab whenever a repo has repeated names
  // (package.json, index.ts, README.md), so the fallback is limited to legacy
  // persisted tabs that carry no path at all.
  return (
    tabs.find((tab) => tab.path === filePath) ??
    tabs.find((tab) => !tab.path && tab.name === fileName)
  );
}

export function shouldPersistEditorChange(isCopilotLiveEditActive: boolean): boolean {
  return !isCopilotLiveEditActive;
}
