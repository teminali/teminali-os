/*
  The typed shape of `window.teminali.videoProjects`.

  The bridge is optional on `window.teminali`: a browser build has no main
  process, so there is no folder dialog and no write to an arbitrary path.
  Saving is therefore a desktop-only capability and the editor says so rather
  than offering a button that cannot work.

  Every verb here answers one `videoProject:*` handler in
  `electron/videoProjects.cjs`. `tests/video-project-bridge.test.mjs` reads
  this file, the preload and the main module together and asserts the three
  agree — the guard exists because the recorder shipped with all three files
  individually correct and the feature dead.
*/

/** What every verb that can fail returns. `canceled` is a dismissed dialog, not an error. */
export interface VideoProjectDirResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  dir?: string;
  name?: string;
}

export interface VideoProjectSaveResult {
  ok: boolean;
  error?: string;
  dir?: string;
  /** The `project.json` itself, for Finder reveal. */
  path?: string;
  name?: string;
}

export interface VideoProjectReadResult {
  ok: boolean;
  error?: string;
  dir?: string;
  path?: string;
  /** The file's raw text. `parseProject` in `src/video/project/format.ts` owns reading it. */
  json?: string;
}

export interface VideoProjectsBridge {
  /** Save As: names a new directory and creates it. Cancelling leaves nothing behind. */
  chooseSaveDir: (suggestedName?: string) => Promise<VideoProjectDirResult>;
  chooseOpenDir: () => Promise<VideoProjectDirResult>;
  save: (dir: string, json: string) => Promise<VideoProjectSaveResult>;
  read: (dir: string) => Promise<VideoProjectReadResult>;
  reveal: (path: string) => Promise<boolean>;
}
