/* ═══════════════════════════════════════════════════════════════════
   Video projects — the half that only the main process can do.

   Three things live here because a renderer cannot reach any of them:
   the native folder dialogs, a write to an arbitrary path outside the
   workspace, and Finder reveal.

   Deliberately a DUMB TRANSPORT. It moves bytes and never inspects
   them: the marker, the version and the shape of a project file are
   `src/video/project/format.ts`'s business, and it is the renderer
   that serialises and parses. Two copies of a format are two formats,
   and this side has no need of one — it writes the text it is handed
   and hands back the text it read.

   The one rule it does enforce is the same one `recorder:writeTakeAsset`
   enforces: the file written is always `project.json` at the root of the
   directory named, never a path the caller composed. A renderer cannot
   use this to write anywhere it likes under any name it likes.
   ═══════════════════════════════════════════════════════════════════ */

const { app, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/** Kept in step with `VIDEO_PROJECT_FILE` by `tests/video-project-format.test.mjs`. */
const PROJECT_FILE = "project.json";

function initVideoProjects(mainWindowGetter) {
  const target = () => {
    try {
      return mainWindowGetter() || null;
    } catch {
      return null;
    }
  };

  /*
    Save As. A save dialog rather than an open dialog because the operator
    is naming something that does not exist yet — a project is a DIRECTORY,
    and this is the one flow in the app that creates one. The directory is
    made here, after the name is chosen, so a cancelled dialog leaves
    nothing behind.
  */
  ipcMain.handle("videoProject:chooseSaveDir", async (_event, p) => {
    const win = target();
    const result = await dialog.showSaveDialog(win, {
      title: "Save Video Project",
      buttonLabel: "Save Project",
      nameFieldStringValue: (p && p.suggestedName) || "Untitled Project",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const dir = path.resolve(result.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `That folder could not be created: ${err.message}` };
    }
    if (!fs.statSync(dir).isDirectory()) {
      return { ok: false, error: "A file of that name already exists there." };
    }
    return { ok: true, dir, name: path.basename(dir) };
  });

  ipcMain.handle("videoProject:chooseOpenDir", async () => {
    const win = target();
    const result = await dialog.showOpenDialog(win, {
      title: "Open Video Project",
      buttonLabel: "Open Project",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    const dir = path.resolve(result.filePaths[0]);
    return { ok: true, dir, name: path.basename(dir) };
  });

  /*
    The write is atomic — temp file then rename — for the same reason
    `server/projects.js` does it: a crash halfway through must leave the
    previous project intact rather than a truncated one. A project file
    is the only record of hours of edits.
  */
  ipcMain.handle("videoProject:save", async (_event, p) => {
    if (!p || typeof p.dir !== "string" || typeof p.json !== "string") {
      return { ok: false, error: "A project directory and its contents are required." };
    }
    const dir = path.resolve(p.dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `That folder could not be created: ${err.message}` };
    }

    const file = path.join(dir, PROJECT_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, p.json, "utf8");
      fs.renameSync(temporary, file);
    } catch (err) {
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
      return { ok: false, error: err.message };
    }
    return { ok: true, dir, path: file, name: path.basename(dir) };
  });

  ipcMain.handle("videoProject:read", async (_event, p) => {
    if (!p || typeof p.dir !== "string") return { ok: false, error: "A project directory is required." };
    const file = path.join(path.resolve(p.dir), PROJECT_FILE);
    if (!fs.existsSync(file)) {
      return { ok: false, error: "That folder is not a video project — it has no project.json." };
    }
    try {
      return { ok: true, dir: path.resolve(p.dir), path: file, json: fs.readFileSync(file, "utf8") };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("videoProject:reveal", async (_event, p) => {
    if (!p || !p.path) return false;
    shell.showItemInFolder(p.path);
    return true;
  });

  const getAutoSavePath = () => {
    const userData = app ? app.getPath("userData") : process.cwd();
    return path.join(userData, "video-autosave.json");
  };

  ipcMain.handle("videoProject:saveAutoSave", async (_event, p) => {
    if (!p || typeof p.json !== "string") return { ok: false, error: "JSON payload required." };
    try {
      const file = getAutoSavePath();
      const temporary = `${file}.${process.pid}.tmp`;
      const payload = JSON.stringify({ json: p.json, dir: p.dir || null, savedAt: Date.now() });
      fs.writeFileSync(temporary, payload, "utf8");
      fs.renameSync(temporary, file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("videoProject:getAutoSave", async () => {
    try {
      const file = getAutoSavePath();
      if (!fs.existsSync(file)) return { ok: false };
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      return { ok: true, json: parsed.json, dir: parsed.dir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("videoProject:clearAutoSave", async () => {
    try {
      const file = getAutoSavePath();
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

/*
  Nothing here holds a shortcut, a window or a file handle, so there is
  nothing to release. The function exists so `main.cjs` treats this module
  exactly like the recorder's, and so a later verb that DOES hold something
  has an obvious place to give it back.
*/
function shutdownVideoProjects() {
  /* intentionally empty — see above */
}

module.exports = { initVideoProjects, shutdownVideoProjects, VIDEO_PROJECT_FILE: PROJECT_FILE };
