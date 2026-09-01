export function findTabByFileIdentity<T extends { path?: string; name: string }>(tabs: T[], filePath: string, name: string): T | undefined {
  return tabs.find((tab) => tab.path === filePath)
    ?? tabs.find((tab) => !tab.path && tab.name === name);
}

export function shouldPersistEditorChange(isCopilotLiveEditActive: boolean): boolean {
  return !isCopilotLiveEditActive;
}
