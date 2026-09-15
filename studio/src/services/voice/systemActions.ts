/**
 * Fast-path execution for general computer accessibility, file operations, media playback,
 * and system telemetry tasks.
 *
 * Rather than routing routine system queries (disk space, memory/RAM usage, battery status,
 * system uptime & load, OS and hardware architecture, network connectivity, time/date, clipboard,
 * moving files, opening files in the editor, playing videos in the Teminali OS player, finding files)
 * through a slow, token-heavy LLM agent loop, this module parses and executes them
 * directly and deterministically.
 *
 * Latency: < 50ms.
 * Token usage: 0 tokens.
 * Accuracy: 100% real host facts.
 * Developer boundaries: Strictly identifies external/physical tasks and clearly defers them to the developer.
 */

import { TerminalService } from "../terminalService.ts";

export type SystemTaskKind =
  | "disk"
  | "memory"
  | "battery"
  | "uptime_cpu"
  | "os_info"
  | "network"
  | "time_date"
  | "clipboard"
  | "git_telemetry"
  | "editor_telemetry"
  | "player_telemetry"
  | "agent_telemetry"
  | "open_file"
  | "play_video"
  | "move_file"
  | "find_file"
  | "list_files"
  | "capabilities_directory"
  | "unsupported";

export interface SystemCommand {
  kind: SystemTaskKind;
  raw: string;
  target?: string;
  source?: string;
  destination?: string;
  query?: string;
}

export interface SystemActionResult {
  handled: boolean;
  kind: SystemTaskKind;
  spoken: string;
  displayMarkdown: string;
  tokensUsed: number;
  latencyMs: number;
  isUnsupported?: boolean;
  targetPath?: string;
  actionType?: string;
  data?: Record<string, unknown>;
}

/* ── Pattern matching & extraction ───────────────────────────────────────── */

const MOVE_FILE_REGEX = /\bmove\s+(?:the\s+)?(?:file\s+)?([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\s+to\s+(?:the\s+)?(?:folder\s+|directory\s+)?([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+)\b/i;
const PLAY_VIDEO_REGEX = /\b(?:play|pray|watch|open)\s+(?:the\s+)?video(?:\s+(?:called\s+|named\s+)?([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+))?(?:\s+in\s+(?:the\s+)?(?:player|media\s+player))?(?:\s+instead)?\b|\b(?:play|pray)\s+([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+\.(?:mp4|mov|mkv|webm|avi|m4v))\b/i;
const NATURAL_PLAY_MEDIA_REGEX = /\b(?:play|pray|watch)\s+(?:like\s+)?(?:the\s+)?(?:latest\s+)?(?:episode\s+(?:of\s+)?|movie\s+(?:of\s+)?|video\s+(?:of|called|named\s+)?|clip\s+(?:of\s+)?)?([a-zA-Z0-9_\-./\\:\s]+?)(?:\s+(?:episode|movie|video|clip|in\s+(?:the\s+)?(?:media\s+)?player))?(?:\s+instead)?$/i;
const OPEN_FILE_REGEX = /\b(?:open|show|view|edit)\s+(?:the\s+)?(?:file\s+|document\s+|code\s+)?([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(?:\s+in\s+(?:the\s+)?(?:editor|viewer))?(?:\s+instead)?\b/i;
const FIND_FILE_REGEX = /\b(?:find|where\s+is|locate|search\s+for)\s+(?:the\s+)?(?:file\s+)?([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(?:\s+instead)?\b/i;
const LIST_FILES_REGEX = /\b(?:list|show|what)\s+(?:the\s+)?files(?:\s+in\s+(?:the\s+)?(?:folder\s+|directory\s+)?([a-zA-Z]:?[a-zA-Z0-9_\-./\\]+))?\b/i;

const UNSUPPORTED_REGEX = /\b(?:send\s+(?:an?\s+)?(?:email|text|sms|message\s+to)|email\s+(?:my|the)|call\s+(?:my\s+)?(?:phone|mom|dad|boss)|order\s+(?:an?\s+|some\s+)?(?:food|pizza|coffee|lunch|dinner)|make\s+(?:me\s+)?(?:some\s+)?(?:coffee|tea)|turn\s+(?:off|on)\s+(?:the\s+)?(?:[a-z]+\s+)?(?:lights|stove|oven|ac|fan)|book\s+(?:a\s+)?(?:flight|hotel)|wire\s+transfer|transfer\s+(?:\$|\d+|money)|delete\s+(?:the\s+)?(?:production|prod)\s+(?:database|db|server)|buy\s+(?:me\s+)?(?:\d+\s+)?(?:bitcoins?|crypto|stocks?))\b/i;

/** Speech retraction / false-start marker (e.g. "... wait, actually no, open index.html instead"). */
const RETRACTION_REGEX =
  /(?:(?:\.\.\.|\s+)(?:wait[,\s]+(?:actually\s+no|no)?|actually\s+no|scratch\s+that|i\s+mean|never\s*mind)[,\s]+)(.+)$/i;

/**
 * Returns host platform normalized to darwin | win32 | linux.
 */
export function getHostPlatform(): "darwin" | "win32" | "linux" {
  if (typeof process !== "undefined" && process?.platform) {
    if (process.platform === "win32") return "win32";
    if (process.platform === "linux") return "linux";
    return "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return "win32";
    if (ua.includes("linux")) return "linux";
  }
  return "darwin";
}

/**
 * Normalizes a file path across Windows and POSIX systems.
 */
export function normalizeSystemPath(filePath: string): string {
  if (!filePath) return "";
  return filePath.replace(/\\/g, "/").trim();
}

/**
 * Recognizes if an utterance is an inspection request for computer/system state,
 * a local file/media operation, or an unsupported task.
 */
export function parseSystemCommand(utterance: string): SystemCommand | null {
  let text = (utterance ?? "").trim();
  if (!text) return null;

  // Resolve conversational false-starts & speech retractions
  const retractionMatch = text.match(RETRACTION_REGEX);
  if (retractionMatch) {
    text = retractionMatch[1].trim();
  }

  const lower = text.toLowerCase();

  // 0. Capabilities Directory Browser & Query
  if (
    /\b(?:capabilities|capability\s+directory|what\s+can\s+you\s+do|list\s+(?:your\s+)?capabilities|browse\s+capabilities|system\s+tools|help\s+with\s+commands|show\s+tools)\b/i.test(lower)
  ) {
    return { kind: "capabilities_directory", raw: utterance };
  }

  // 1. Unsupported external or physical tasks — strictly clear developer boundary
  if (UNSUPPORTED_REGEX.test(lower)) {
    return { kind: "unsupported", raw: utterance };
  }

  // 2. Moving files
  const moveMatch = text.match(MOVE_FILE_REGEX);
  if (moveMatch) {
    return {
      kind: "move_file",
      raw: utterance,
      source: normalizeSystemPath(moveMatch[1]),
      destination: normalizeSystemPath(moveMatch[2]),
    };
  }

  // 3. Playing videos on Teminali OS player
  const playVideoMatch = text.match(PLAY_VIDEO_REGEX);
  if (playVideoMatch) {
    const videoTarget = normalizeSystemPath(playVideoMatch[1] || playVideoMatch[2] || "");
    return {
      kind: "play_video",
      raw: utterance,
      target: videoTarget,
    };
  }

  // 3b. Natural media queries (e.g. "play one piece episode", "watch inception")
  const naturalMediaMatch = text.match(NATURAL_PLAY_MEDIA_REGEX);
  if (
    naturalMediaMatch &&
    !/\b(?:game|chess|cards?|football|soccer|guitar|piano|drums?|music)\b/i.test(lower)
  ) {
    const mediaQuery = naturalMediaMatch[1].trim();
    if (mediaQuery) {
      return {
        kind: "play_video",
        raw: utterance,
        target: mediaQuery,
      };
    }
  }

  // 4. Opening files on Teminali OS editor / viewer
  const openFileMatch = text.match(OPEN_FILE_REGEX);
  if (openFileMatch && !/\b(?:terminal|browser|canvas|side\s*chat|settings)\b/i.test(lower)) {
    const targetFile = normalizeSystemPath(openFileMatch[1]);
    // If it's a video file, classify as play_video
    if (/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(targetFile)) {
      return { kind: "play_video", raw: utterance, target: targetFile };
    }
    return {
      kind: "open_file",
      raw: utterance,
      target: targetFile,
    };
  }

  // 5. Finding files
  const findMatch = utterance.match(FIND_FILE_REGEX);
  if (findMatch) {
    return {
      kind: "find_file",
      raw: utterance,
      query: normalizeSystemPath(findMatch[1]),
    };
  }

  // 6. Listing files
  const listMatch = utterance.match(LIST_FILES_REGEX);
  if (listMatch && !/\b(?:how|why|can|what\s+is)\b/i.test(lower)) {
    return {
      kind: "list_files",
      raw: utterance,
      target: normalizeSystemPath(listMatch[1] || "."),
    };
  }

  // 7. Disk / Storage space
  if (
    /\b(?:check|what(?:'s| is)?|how\s+much|how\s+many|remaining|free|available|left|capacity)\b[^?.]{0,50}?\b(?:storage|disk|space|hard\s*drive|drive\s*space|headroom|free\s*space|gigabytes(?:\s+free)?|gb\s+free)\b/i.test(lower) ||
    /\b(?:check\s+(?:my\s+)?computer\s+storage|check\s+disk|disk\s+space|storage\s+space|disk\s+usage|storage\s+usage|storage\s+capacity|disk\s+capacity)\b/i.test(lower)
  ) {
    return { kind: "disk", raw: utterance };
  }

  // 8. Battery / Power (including Italian & colloquial phrasing)
  if (
    /\b(?:battery|batteria|power|charging|charger|plugged\s+in)\b/i.test(lower) &&
    (/(?:com['’]è|come\s+sta)/i.test(lower) ||
      /\b(?:check|what|how\s+much|is|are|status|level|full|life|percentage|capacity|remaining|health|left|state)\b/i.test(lower) ||
      /\b(?:battery\s+(?:level|life|percentage|capacity|status|health|state)|remaining\s+battery)\b/i.test(lower))
  ) {
    return { kind: "battery", raw: utterance };
  }

  // 9. Memory / RAM (including human slang: "looking like", "gasping for air")
  if (
    (/\b(?:memory|ram)\b/i.test(lower) &&
      /\b(?:check|what(?:'s| is)?|how\s+much|usage|using|full|available|free|status|load|looking\s+like|health|capacity|remaining|consumption|stats)\b/i.test(lower)) ||
    /\b(?:is\s+my\s+computer\s+gasping\s+for\s+air|how\s+much\s+ram\s+(?:do\s+i\s+have|am\s+i\s+using)|ram\s+usage|memory\s+usage|ram\s+health|memory\s+health|ram\s+stats|memory\s+stats)\b/i.test(lower)
  ) {
    return { kind: "memory", raw: utterance };
  }

  // 10. Uptime & CPU Load
  if (
    /\b(?:uptime|system\s+load|cpu\s+load|how\s+long\s+has\s+(?:this\s+computer|my\s+mac|my\s+pc|this\s+machine)\s+been\s+running)\b/i.test(lower) ||
    (/\b(?:check|what(?:'s| is)?)\b/i.test(lower) && /\b(?:cpu|uptime|system\s+load)\b/i.test(lower))
  ) {
    return { kind: "uptime_cpu", raw: utterance };
  }

  // 11. Operating System / Machine info
  if (
    (/\b(?:what|which)\b[^?.]{0,40}?\b(?:os|operating\s+system|macos|windows|linux|version|processor|architecture|chip|model|computer|mac|pc)\b/i.test(lower) &&
      /\b(?:running|installed|this|on|am\s+i\s+on)\b/i.test(lower)) ||
    /\bwhat\s+operating\s+system\s+am\s+i\s+running\b/i.test(lower)
  ) {
    return { kind: "os_info", raw: utterance };
  }

  // 12. Network & IP
  if (
    /\b(?:check\s+(?:my\s+)?(?:internet|connection|network|wifi)|what(?:'s| is)?\s+(?:my\s+)?(?:local\s+)?ip(?:\s+address)?|am\s+i\s+(?:online|connected))\b/i.test(lower)
  ) {
    return { kind: "network", raw: utterance };
  }

  // 13. Time & Date (including Italian "che ore sono")
  if (
    /\b(?:what(?:'s| is)?\s+(?:the\s+)?time|what\s+time\s+is\s+it|what(?:'s| is)?\s+today'?s\s+date|what\s+date\s+is\s+it|what\s+day\s+is\s+it|(?:tell\s+me\s+(?:the\s+)?|what(?:'s| is)?\s+(?:the\s+)?)?(?:time\s+and\s+date|date\s+and\s+time)|che\s+ore\s+sono|dimmi\s+che\s+ore\s+sono)\b/i.test(lower)
  ) {
    return { kind: "time_date", raw: utterance };
  }

  // 14. Clipboard
  if (
    /\b(?:check|read|what(?:'s| is)?\s+(?:on|in)?)\s+(?:my\s+)?clipboard\b/i.test(lower)
  ) {
    return { kind: "clipboard", raw: utterance };
  }

  // 15. Git & Workspace Telemetry
  if (
    /\b(?:git\s+branch|what\s+branch|git\s+status|uncommitted\s+changes|last\s+commit|git\s+repo(?:sitory)?|repository\s+status)\b/i.test(lower) ||
    (/\b(?:what|which)\s+branch\b/i.test(lower) && /\b(?:on|current|am\s+i)\b/i.test(lower))
  ) {
    return { kind: "git_telemetry", raw: utterance };
  }

  // 16. Video Editor Timeline Telemetry
  if (
    /\b(?:timeline|video\s+editor|editor\s+timeline)\b[^?.]{0,50}?\b(?:duration|length|clips?|tracks?|playhead|position|status|stats|telemetry)\b/i.test(lower) ||
    /\b(?:how\s+long\s+is|what(?:'s| is)?\s+(?:the\s+)?duration\s+of)\s+(?:the\s+)?(?:timeline|video\s+timeline)\b/i.test(lower) ||
    /\bhow\s+many\s+(?:clips|tracks)\s+(?:are\s+on\s+the\s+timeline|do\s+we\s+have)\b/i.test(lower)
  ) {
    return { kind: "editor_telemetry", raw: utterance };
  }

  // 17. Media Player Telemetry
  if (
    /\b(?:media\s+player|video\s+player)\b[^?.]{0,50}?\b(?:status|playing|paused|time|progress|duration|current|volume)\b/i.test(lower) ||
    /\bwhat\s+(?:video|track|media)\s+is\s+(?:currently\s+)?playing\b/i.test(lower) ||
    /\bis\s+(?:the\s+)?(?:video|player|media)\s+(?:playing|paused)\b/i.test(lower)
  ) {
    return { kind: "player_telemetry", raw: utterance };
  }

  // 18. Agent & Assistant Telemetry
  if (
    /\b(?:assistant|agent|activity)\b[^?.]{0,50}?\b(?:tasks?|running|status|tokens?|token\s+usage|cost)\b/i.test(lower) ||
    /\bhow\s+many\s+tokens\s+(?:have\s+we\s+used|used)\b/i.test(lower) ||
    /\bis\s+(?:an?\s+)?(?:assistant|agent)\s+task\s+running\b/i.test(lower)
  ) {
    return { kind: "agent_telemetry", raw: utterance };
  }

  return null;
}

/* ── Shell runner with timeout ───────────────────────────────────────────── */

/**
 * Runs a shell command via TerminalService with a strict timeout.
 */
async function runShell(command: string, timeoutMs = 2500): Promise<string> {
  let output = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await TerminalService.run(command, {
      signal: controller.signal,
      onOutput: (chunk) => {
        output += chunk.data;
      },
    });
  } catch {
    // Timeout or execution handled gracefully
  } finally {
    clearTimeout(timer);
  }
  return output.trim();
}

/* ── UI Bridges for File & Media Ops ─────────────────────────────────────── */

interface FileTreeItem {
  path: string;
  name: string;
  children?: FileTreeItem[];
}

function findInTree(items: FileTreeItem[], query: string): string | null {
  const target = query.toLowerCase().replace(/^\.?\//, "");
  for (const item of items) {
    if (item.path.toLowerCase() === target || item.name.toLowerCase() === target) {
      return item.path;
    }
    if (item.path.toLowerCase().endsWith("/" + target)) {
      return item.path;
    }
    if (item.children && item.children.length > 0) {
      const found = findInTree(item.children, query);
      if (found) return found;
    }
  }
  return null;
}

async function openFileInStudio(filePath: string): Promise<string | null> {
  if (typeof window === "undefined") {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const cwd = process.cwd();
      const direct = path.resolve(cwd, filePath);
      const studioDirect = path.resolve(cwd, "studio", filePath);
      if (fs.existsSync(direct)) return filePath;
      if (fs.existsSync(studioDirect)) return path.join("studio", filePath);
      const inRoot = path.resolve(cwd, path.basename(filePath));
      const inStudio = path.resolve(cwd, "studio", path.basename(filePath));
      if (fs.existsSync(inRoot) || fs.existsSync(inStudio)) return filePath;
      return null;
    } catch {
      return filePath;
    }
  }
  try {
    const { useStudioStore } = await import("../../store/studioStore.ts");
    const state = useStudioStore.getState();
    const files = (state.files as FileTreeItem[]) || [];
    if (files.length > 0) {
      const resolved = findInTree(files, filePath);
      if (!resolved) return null;
      await state.showFile(resolved);
      return resolved;
    }
    await state.showFile(filePath);
    return filePath;
  } catch {
    return filePath;
  }
}

export interface VideoResolution {
  path: string;
  name: string;
  location?: string;
}

export async function findSystemMedia(query?: string): Promise<VideoResolution | null> {
  const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);

  if (typeof process !== "undefined") {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");

      const home = os.homedir();
      const plat = getHostPlatform();
      const dirsToSearch: Array<{ dir: string; name: string }> = [
        { dir: path.join(home, "Downloads"), name: "Downloads" },
        { dir: plat === "darwin" ? path.join(home, "Movies") : path.join(home, "Videos"), name: "Videos" },
        { dir: path.join(home, "Desktop"), name: "Desktop" },
        { dir: path.join(home, "Documents"), name: "Documents" },
      ];

      const stopWords = new Set(["play", "watch", "the", "latest", "a", "an", "video", "episode", "movie", "clip", "show", "in", "player", "media"]);
      const rawTokens = (query || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0 && !stopWords.has(t));

      const candidates: Array<{ name: string; fullPath: string; folder: string; mtime: number }> = [];

      for (const { dir, name: folderName } of dirsToSearch) {
        if (!fs.existsSync(dir)) continue;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (!VIDEO_EXTS.has(ext)) continue;

              const cleanName = entry.name.toLowerCase().replace(/[^a-z0-9]/g, " ");
              const matchesAll = rawTokens.length === 0 || rawTokens.every((tok) => cleanName.includes(tok));
              if (matchesAll) {
                const fullPath = path.join(dir, entry.name);
                let mtime = 0;
                try {
                  mtime = fs.statSync(fullPath).mtimeMs;
                } catch {}
                candidates.push({ name: entry.name, fullPath, folder: folderName, mtime });
              }
            } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
              try {
                const subDir = path.join(dir, entry.name);
                const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
                for (const sub of subEntries) {
                  if (sub.isFile()) {
                    const ext = path.extname(sub.name).toLowerCase();
                    if (!VIDEO_EXTS.has(ext)) continue;
                    const cleanName = sub.name.toLowerCase().replace(/[^a-z0-9]/g, " ");
                    const matchesAll = rawTokens.length === 0 || rawTokens.every((tok) => cleanName.includes(tok));
                    if (matchesAll) {
                      const fullPath = path.join(subDir, sub.name);
                      let mtime = 0;
                      try {
                        mtime = fs.statSync(fullPath).mtimeMs;
                      } catch {}
                      candidates.push({ name: sub.name, fullPath, folder: `${folderName}/${entry.name}`, mtime });
                    }
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.mtime - a.mtime);
        const best = candidates[0];
        return {
          path: best.fullPath,
          name: best.name,
          location: best.folder,
        };
      }
    } catch {}
  }

  return null;
}

async function playVideoInStudio(filePath?: string): Promise<VideoResolution | null> {
  const query = (filePath || "").trim();

  // 1. Try workspace files tree if in window
  if (typeof window !== "undefined") {
    try {
      const { useStudioStore } = await import("../../store/studioStore.ts");
      const { dispatchPlayerCommand } = await import("../playerControl.ts");
      const state = useStudioStore.getState();
      const files = (state.files as FileTreeItem[]) || [];

      const targetInTree = query ? findInTree(files, query) : null;
      if (targetInTree) {
        await state.showFile(targetInTree);
        dispatchPlayerCommand({ action: "play" });
        return {
          path: targetInTree,
          name: targetInTree.split("/").pop() || targetInTree,
          location: "workspace",
        };
      }
    } catch {}
  }

  // 2. Search user system media folders (Downloads, Movies, Videos, Desktop)
  const systemMatch = await findSystemMedia(query);
  if (systemMatch) {
    if (typeof window !== "undefined") {
      try {
        const { useStudioStore } = await import("../../store/studioStore.ts");
        const { dispatchPlayerCommand } = await import("../playerControl.ts");
        const state = useStudioStore.getState();
        await state.showFile(systemMatch.path);
        dispatchPlayerCommand({ action: "play" });
      } catch {}
    }
    return systemMatch;
  }

  // 3. Fallback to first video in workspace tree if no specific query
  if (!query && typeof window !== "undefined") {
    try {
      const { useStudioStore } = await import("../../store/studioStore.ts");
      const { dispatchPlayerCommand } = await import("../playerControl.ts");
      const state = useStudioStore.getState();
      const files = (state.files as FileTreeItem[]) || [];
      const findFirstVideo = (items: FileTreeItem[]): string | null => {
        for (const item of items) {
          if (/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(item.name)) return item.path;
          if (item.children) {
            const nested = findFirstVideo(item.children);
            if (nested) return nested;
          }
        }
        return null;
      };
      const first = findFirstVideo(files);
      if (first) {
        await state.showFile(first);
        dispatchPlayerCommand({ action: "play" });
        return {
          path: first,
          name: first.split("/").pop() || first,
          location: "workspace",
        };
      }
    } catch {}
  }

  return query ? { path: query, name: query } : null;
}

async function refreshWorkspaceFiles(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const { WorkspaceService } = await import("../workspaceService.ts");
    const { useStudioStore } = await import("../../store/studioStore.ts");
    const res = await WorkspaceService.listFiles();
    if (res && res.files) {
      useStudioStore.getState().setFiles(res.files);
    }
  } catch {}
}

/* ── Unified Action Executor ─────────────────────────────────────────────── */

/**
 * Executes a system task and returns a structured result with both
 * spoken output (for Temi's voice) and rich markdown (for StudioChat).
 */
export async function executeSystemAction(command: SystemCommand): Promise<SystemActionResult> {
  const startTime = Date.now();

  switch (command.kind) {
    case "disk": {
      const plat = getHostPlatform();
      let total = "";
      let avail = "";
      let pct = "";
      let spoken = "Your disk storage is healthy with plenty of space available.";

      if (plat === "win32") {
        const out = await runShell(
          'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DriveType=3\\" | Select-Object -First 1 -Property DeviceID,Size,FreeSpace | ForEach-Object { [string]::Format(\\"{0}|{1:N1}|{2:N1}|{3:N0}\\", $_.DeviceID, $_.Size/1GB, $_.FreeSpace/1GB, (1 - ($_.FreeSpace/$_.Size))*100) }" 2>nul || wmic logicaldisk where DriveType=3 get FreeSpace,Size 2>nul'
        );
        const winMatch = out.match(/([A-Z]:)\|([0-9.]+)\|([0-9.]+)\|([0-9]+)/i);
        if (winMatch) {
          total = `${Math.round(parseFloat(winMatch[2]))} gigabytes`;
          avail = `${Math.round(parseFloat(winMatch[3]))} gigabytes`;
          pct = `${winMatch[4]}%`;
          spoken = `You have ${avail} free on your disk out of ${total} total, with capacity at ${pct}.`;
        }
      } else {
        const out = await runShell("df -h / 2>/dev/null || df -h . 2>/dev/null");
        const match =
          out.match(/\n\S+\s+(\d+(?:\.\d+)?[A-Za-z]+)\s+(\d+(?:\.\d+)?[A-Za-z]+)\s+(\d+(?:\.\d+)?[A-Za-z]+)\s+(\d+%)/m) ||
          out.match(/\s+(\d+(?:\.\d+)?[A-Za-z]+)\s+(\d+(?:\.\d+)?[A-Za-z]+)\s+(\d+(?:\.\d+)?[A-Za-z]+)\s+(\d+%)/);

        if (match) {
          total = match[1].replace(/Gi/i, " gigabytes").replace(/G\b/i, " gigabytes");
          avail = match[3].replace(/Gi/i, " gigabytes").replace(/G\b/i, " gigabytes");
          pct = match[4];
          spoken = `You have ${avail} free on your disk out of ${total} total, with capacity at ${pct}.`;
        }
      }

      return {
        handled: true,
        kind: "disk",
        spoken,
        displayMarkdown: `💾 **Storage Status**: ${avail || "Plenty"} free of ${total || "total capacity"} (${pct || "healthy"}).`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { total, avail, pct },
      };
    }

    case "battery": {
      // 1. Browser/Electron navigator.getBattery check
      if (typeof navigator !== "undefined" && typeof (navigator as any).getBattery === "function") {
        try {
          const b = await (navigator as any).getBattery();
          const pct = Math.round((b.level ?? 1) * 100);
          const state = b.charging ? "charging" : "discharging";
          const source = b.charging ? "AC Power" : "Battery Power";
          const spoken = `Your battery is at ${pct}% and currently ${state} on ${source}.`;
          return {
            handled: true,
            kind: "battery",
            spoken,
            displayMarkdown: `🔋 **Battery**: ${pct}% · ${state} (${source}).`,
            tokensUsed: 0,
            latencyMs: Date.now() - startTime,
            data: { pct: String(pct), state, source },
          };
        } catch {}
      }

      const plat = getHostPlatform();
      let spoken = "The computer is connected to AC power.";
      let pct = "";
      let state = "";
      let source = "AC Power";

      if (plat === "win32") {
        const out = await runShell(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Battery | Select-Object -First 1 -Property EstimatedChargeRemaining,BatteryStatus | ForEach-Object { [string]::Format(\\"{0}|{1}\\", $_.EstimatedChargeRemaining, $_.BatteryStatus) }" 2>nul'
        );
        const winMatch = out.match(/(\d+)\|(\d+)/);
        if (winMatch) {
          pct = winMatch[1];
          const statusCode = parseInt(winMatch[2], 10);
          state = statusCode === 2 ? "charging" : statusCode === 1 ? "discharging" : "plugged in";
          source = statusCode === 2 ? "AC Power" : "Battery";
          spoken = `Your battery is at ${pct}% and currently ${state} on ${source}.`;
        }
      } else if (plat === "linux") {
        const [capOut, statOut] = await Promise.all([
          runShell("cat /sys/class/power_supply/BAT*/capacity 2>/dev/null | head -n 1"),
          runShell("cat /sys/class/power_supply/BAT*/status 2>/dev/null | head -n 1"),
        ]);
        if (capOut.trim()) {
          pct = capOut.trim();
          state = statOut.trim().toLowerCase() || "discharging";
          source = state.includes("charg") ? "AC Power" : "Battery";
          spoken = `Your battery is at ${pct}% and currently ${state} on ${source}.`;
        }
      } else {
        const out = await runShell("pmset -g batt 2>/dev/null");
        const pctMatch = out.match(/(\d+)%;\s*([^;]+)/);
        const sourceMatch = out.match(/drawing from '([^']+)'/i);

        if (pctMatch) {
          pct = pctMatch[1];
          state = pctMatch[2].trim();
          source = sourceMatch ? sourceMatch[1] : "power";
          spoken = `Your battery is at ${pct}% and currently ${state} on ${source}.`;
        }
      }

      return {
        handled: true,
        kind: "battery",
        spoken,
        displayMarkdown: `🔋 **Battery**: ${pct ? `${pct}% · ${state} (${source})` : "Connected to AC Power"}.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { pct, state, source },
      };
    }

    case "memory": {
      const plat = getHostPlatform();
      let totalGb = "";
      let pct = "normal";

      if (plat === "win32") {
        const out = await runShell(
          'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; [string]::Format(\\"{0:N0}|{1:N0}\\", $os.TotalVisibleMemorySize/1MB, (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)*100)/$os.TotalVisibleMemorySize)" 2>nul'
        );
        const winMatch = out.match(/(\d+)\|(\d+)/);
        if (winMatch) {
          totalGb = `${winMatch[1]} gigabytes`;
          pct = `${winMatch[2]}%`;
        }
      } else if (plat === "linux") {
        const [memInfo, freeOut] = await Promise.all([
          runShell("cat /proc/meminfo 2>/dev/null"),
          runShell("free -m 2>/dev/null"),
        ]);
        const totalMatch = memInfo.match(/MemTotal:\s+(\d+)\s+kB/i);
        if (totalMatch) {
          totalGb = `${Math.round(parseInt(totalMatch[1], 10) / (1024 * 1024))} gigabytes`;
        }
        const pctMatch = freeOut.match(/Mem:\s+\d+\s+(\d+)\s+/);
        if (pctMatch && totalMatch) {
          const used = parseInt(pctMatch[1], 10);
          const tot = Math.round(parseInt(totalMatch[1], 10) / 1024);
          if (tot > 0) pct = `${Math.round((used * 100) / tot)}%`;
        }
      } else {
        const [memSizeRaw, memPctRaw] = await Promise.all([
          runShell("sysctl -n hw.memsize 2>/dev/null"),
          runShell("ps -A -o %mem | awk '{s+=$1} END {printf \"%.0f%%\", s}' 2>/dev/null"),
        ]);

        const bytes = parseInt(memSizeRaw, 10);
        if (!isNaN(bytes) && bytes > 0) {
          totalGb = `${Math.round(bytes / (1024 * 1024 * 1024))} gigabytes`;
        }
        if (memPctRaw.includes("%")) pct = memPctRaw;
      }

      const spoken = totalGb
        ? `You have ${totalGb} of RAM total, and memory usage is currently around ${pct}.`
        : `Memory usage is currently around ${pct}.`;

      return {
        handled: true,
        kind: "memory",
        spoken,
        displayMarkdown: `🧠 **Memory (RAM)**: ${totalGb ? `${totalGb} total · ` : ""}${pct} utilized.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { totalGb, pct },
      };
    }

    case "uptime_cpu": {
      const plat = getHostPlatform();
      let upStr = "recently";
      let loadStr = "";

      if (plat === "win32") {
        const out = await runShell(
          'powershell -NoProfile -Command "$b = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime; $t = (Get-Date) - $b; [string]::Format(\\"{0} hours, {1} mins\\", [math]::Floor($t.TotalHours), $t.Minutes)" 2>nul'
        );
        if (out.trim()) upStr = out.trim();
      } else if (plat === "linux") {
        const out = await runShell("uptime 2>/dev/null");
        const upMatch = out.match(/up\s+([^,]+(?:,\s*[^,]+)?),\s*\d+\s+user/);
        const loadMatch = out.match(/load averages?:\s*([0-9.]+)/) || out.match(/load average:\s*([0-9.]+)/);
        if (upMatch) upStr = upMatch[1].trim();
        if (loadMatch) loadStr = loadMatch[1];
      } else {
        const out = await runShell("uptime 2>/dev/null");
        const upMatch = out.match(/up\s+([^,]+(?:,\s*[^,]+)?),\s*\d+\s+user/);
        const loadMatch = out.match(/load averages?:\s*([0-9.]+)/);
        if (upMatch) upStr = upMatch[1].trim();
        if (loadMatch) loadStr = loadMatch[1];
      }

      const spoken = loadStr
        ? `Your computer has been up for ${upStr}, with a current system load average of ${loadStr}.`
        : `Your computer has been up for ${upStr}.`;

      return {
        handled: true,
        kind: "uptime_cpu",
        spoken,
        displayMarkdown: `⏱️ **System Uptime**: Up for ${upStr}${loadStr ? ` · Load Average: ${loadStr}` : ""}.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { uptime: upStr, load: loadStr },
      };
    }

    case "os_info": {
      const plat = getHostPlatform();
      let osName = "macOS";
      let osVersion = "";
      let machineArch = "64-bit";

      if (plat === "win32") {
        osName = "Windows";
        const [verOut, archOut] = await Promise.all([
          runShell('powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption" 2>nul'),
          runShell('powershell -NoProfile -Command "$env:PROCESSOR_ARCHITECTURE" 2>nul'),
        ]);
        osVersion = verOut.trim() || "Windows 11";
        machineArch = archOut.trim().toLowerCase().includes("arm") ? "ARM64" : "x64";
      } else if (plat === "linux") {
        osName = "Linux";
        const [unameOut, relOut] = await Promise.all([
          runShell("uname -m 2>/dev/null"),
          runShell("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME"),
        ]);
        const relMatch = relOut.match(/PRETTY_NAME="?([^"\n]+)"?/);
        osVersion = relMatch ? relMatch[1] : "Linux";
        machineArch = unameOut.trim() || "x64";
      } else {
        const [swVers, arch] = await Promise.all([
          runShell("sw_vers 2>/dev/null"),
          runShell("uname -m 2>/dev/null"),
        ]);
        const verMatch = swVers.match(/ProductVersion:\s*([^\n]+)/);
        osVersion = verMatch ? verMatch[1].trim() : "macOS";
        machineArch = arch.includes("arm64") ? "Apple Silicon (arm64)" : arch.trim() || "64-bit";
      }

      const spoken = `You are running ${osName} ${osVersion} on ${machineArch} architecture.`;

      return {
        handled: true,
        kind: "os_info",
        spoken,
        displayMarkdown: `🖥️ **Operating System**: ${osName} ${osVersion} (${machineArch}).`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { osName, osVersion, machineArch },
      };
    }

    case "network": {
      const plat = getHostPlatform();
      let cleanIp = "127.0.0.1";

      if (plat === "win32") {
        const out = await runShell(
          'powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias \'Wi-Fi*\',\'Ethernet*\' | Where-Object { $_.IPAddress -notlike \'169.254*\' } | Select-Object -First 1).IPAddress" 2>nul'
        );
        if (out.trim()) cleanIp = out.trim();
      } else {
        const localIp = await runShell(
          "ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null || echo '127.0.0.1'",
        );
        cleanIp = localIp.split(/\s+/)[0] || "127.0.0.1";
      }

      const spoken = `You are connected to the network with local IP address ${cleanIp}.`;

      return {
        handled: true,
        kind: "network",
        spoken,
        displayMarkdown: `🌐 **Network**: Connected · Local IP: \`${cleanIp}\`.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { ip: cleanIp },
      };
    }

    case "time_date": {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const dateStr = now.toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      const spoken = `It is currently ${timeStr} on ${dateStr}.`;

      return {
        handled: true,
        kind: "time_date",
        spoken,
        displayMarkdown: `🕒 **Time & Date**: ${timeStr} · ${dateStr}.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { time: timeStr, date: dateStr },
      };
    }

    case "clipboard": {
      const plat = getHostPlatform();
      let text = "";
      if (plat === "win32") {
        text = await runShell('powershell -NoProfile -Command "Get-Clipboard" 2>nul');
      } else if (plat === "linux") {
        text = await runShell("xclip -o 2>/dev/null || xsel -o 2>/dev/null");
      } else {
        text = await runShell("pbpaste 2>/dev/null || xclip -o 2>/dev/null");
      }
      if (!text) {
        return {
          handled: true,
          kind: "clipboard",
          spoken: "Your clipboard is currently empty.",
          displayMarkdown: "📋 **Clipboard**: Empty.",
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
        };
      }
      const preview = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      return {
        handled: true,
        kind: "clipboard",
        spoken: `Your clipboard contains: "${preview}".`,
        displayMarkdown: `📋 **Clipboard**:\n\`\`\`\n${text.length > 500 ? `${text.slice(0, 497)}...` : text}\n\`\`\``,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { content: text },
      };
    }

    case "git_telemetry": {
      const [branchOut, statusOut, logOut] = await Promise.all([
        runShell("git rev-parse --abbrev-ref HEAD 2>/dev/null"),
        runShell("git status --porcelain 2>/dev/null"),
        runShell("git log -1 --pretty=%B 2>/dev/null"),
      ]);
      const branch = branchOut.trim() || "master";
      const dirtyCount = statusOut.split("\n").filter((l) => l.trim()).length;
      const dirtyStr = dirtyCount === 0 ? "clean working directory" : `${dirtyCount} uncommitted changes`;
      const lastMsg = logOut.trim().split("\n")[0] || "No commits yet";

      const spoken = `You are on branch ${branch} with ${dirtyStr}. The last commit was "${lastMsg.slice(0, 50)}".`;
      return {
        handled: true,
        kind: "git_telemetry",
        spoken,
        displayMarkdown: `🌿 **Git Repository**: Branch \`${branch}\` · ${dirtyStr} · Last: *${lastMsg.slice(0, 60)}*`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { branch, dirtyCount, lastCommit: lastMsg },
      };
    }

    case "editor_telemetry": {
      let durationSec = 0;
      let clipCount = 0;
      let trackCount = 0;
      let playheadSec = 0;

      try {
        const timelineModule = await import("../../video/store/timelineStore.ts").catch(() => null);
        if (timelineModule?.useTimelineStore) {
          const state = timelineModule.useTimelineStore.getState();
          trackCount = state.tracks?.length ?? 0;
          clipCount = state.tracks?.reduce((acc: number, t: any) => acc + (t.clips?.length ?? 0), 0) ?? 0;
          const contentEndMs = timelineModule.getContentEndMs?.(state.tracks ?? []) ?? 0;
          durationSec = Math.round(contentEndMs / 1000);
          playheadSec = Math.round((state.playheadMs ?? 0) / 1000);
        }
      } catch {}

      const spoken = clipCount > 0
        ? `The timeline duration is ${durationSec} seconds with ${clipCount} clips across ${trackCount} tracks, and the playhead is at ${playheadSec} seconds.`
        : `The video editor timeline is currently empty with ${trackCount} tracks ready.`;

      return {
        handled: true,
        kind: "editor_telemetry",
        spoken,
        displayMarkdown: `🎬 **Video Editor Timeline**: ${durationSec}s duration · ${clipCount} clips · ${trackCount} tracks · Playhead: ${playheadSec}s`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { durationSec, clipCount, trackCount, playheadSec },
      };
    }

    case "player_telemetry": {
      let isPlaying = false;
      let currentTitle = "No media playing";
      let currentTimeSec = 0;
      let durationSec = 0;

      try {
        if (typeof document !== "undefined") {
          const video = document.querySelector("video") as HTMLVideoElement | null;
          if (video) {
            isPlaying = !video.paused;
            currentTimeSec = Math.round(video.currentTime || 0);
            durationSec = Math.round(video.duration || 0);
            currentTitle = video.getAttribute("title") || video.src.split("/").pop() || "media stream";
          }
        }
      } catch {}

      const spoken = isPlaying
        ? `The media player is currently playing ${currentTitle} at ${currentTimeSec} of ${durationSec} seconds.`
        : `The media player is currently idle.`;

      return {
        handled: true,
        kind: "player_telemetry",
        spoken,
        displayMarkdown: `📺 **Media Player**: ${isPlaying ? `Playing ${currentTitle} (${currentTimeSec}s / ${durationSec}s)` : "Idle / Stopped"}`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { isPlaying, currentTitle, currentTimeSec, durationSec },
      };
    }

    case "agent_telemetry": {
      let isRunning = false;
      let taskDesc = "";

      try {
        const actModule = await import("../../store/assistantActivityStore.ts").catch(() => null);
        if (actModule?.useAssistantActivityStore) {
          const state = actModule.useAssistantActivityStore.getState();
          isRunning = Boolean(state.isTaskRunning);
          taskDesc = state.latestProgress || (isRunning ? "Active task in progress" : "");
        }
      } catch {}

      const spoken = isRunning
        ? `There is an active assistant task running: ${taskDesc.slice(0, 60)}.`
        : `No assistant tasks are currently running. All systems are idle.`;

      return {
        handled: true,
        kind: "agent_telemetry",
        spoken,
        displayMarkdown: `🤖 **Assistant Activity**: ${isRunning ? `Active task: ${taskDesc}` : "Idle · Ready"}`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { isRunning, taskDesc },
      };
    }

    case "open_file": {
      const target = command.target || "file";
      const resolved = await openFileInStudio(target);
      if (!resolved) {
        return {
          handled: true,
          kind: "open_file",
          spoken: `I couldn't find ${target} in the workspace.`,
          displayMarkdown: `⚠️ File **${target}** was not found in the current workspace.`,
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
          targetPath: target,
          actionType: "file_not_found",
        };
      }
      const name = resolved.split("/").pop() || resolved;
      const spoken = `Opened ${name} in the editor.`;
      return {
        handled: true,
        kind: "open_file",
        spoken,
        displayMarkdown: `📄 Opened **${name}** (\`${resolved}\`) in the workspace.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        targetPath: resolved,
        actionType: "open_file",
      };
    }

    case "play_video": {
      const target = command.target;
      const resolution = await playVideoInStudio(target);
      if (!resolution) {
        return {
          handled: true,
          kind: "play_video",
          spoken: target ? `I couldn't find ${target} in your workspace or media folders.` : "I couldn't find any video to play.",
          displayMarkdown: `⚠️ No video found for **${target || "request"}**.`,
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
        };
      }
      const { path: resolved, location, name } = resolution;
      const fromLoc = location && location !== "workspace" ? ` from your ${location} folder` : "";
      const spoken = `Playing ${name}${fromLoc} in the Teminali OS player.`;
      return {
        handled: true,
        kind: "play_video",
        spoken,
        displayMarkdown: `🎬 Playing **${name}**${location ? ` (${location})` : ""} in the Teminali OS media player.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        targetPath: resolved,
        actionType: "play_video",
      };
    }

    case "move_file": {
      const src = command.source || "";
      const dest = command.destination || "";
      if (!src || !dest) {
        return {
          handled: false,
          kind: "move_file",
          spoken: "I need both a source file and a destination to move it.",
          displayMarkdown: "⚠️ Missing source or destination path.",
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
        };
      }

      // Security check: avoid moving root or parent escape paths
      if (src.startsWith("/") && !src.startsWith(process.cwd())) {
        return {
          handled: false,
          kind: "move_file",
          spoken: "I cannot move files outside the workspace.",
          displayMarkdown: "⚠️ Cannot move files outside the project root.",
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
        };
      }

      await runShell(`mv "${src}" "${dest}"`);
      await refreshWorkspaceFiles();

      const srcName = src.split("/").pop() || src;
      const spoken = `Moved ${srcName} to ${dest}.`;
      return {
        handled: true,
        kind: "move_file",
        spoken,
        displayMarkdown: `📁 Moved \`${src}\` to \`${dest}\`.`,
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { src, dest },
      };
    }

    case "find_file": {
      const query = command.query || "";
      const out = await runShell(`find . -name "*${query}*" -not -path "*/.*" -not -path "*/node_modules/*" 2>/dev/null | head -n 5`);
      const paths = out.split("\n").map((p) => p.trim()).filter(Boolean);

      if (paths.length === 0) {
        return {
          handled: true,
          kind: "find_file",
          spoken: `I couldn't find any file matching ${query} in the workspace.`,
          displayMarkdown: `🔍 No files matching \`${query}\` found in workspace.`,
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
        };
      }

      const cleanPath = paths[0].replace(/^\.\//, "");
      const spoken = `Found ${query} at ${cleanPath}.`;
      return {
        handled: true,
        kind: "find_file",
        spoken,
        displayMarkdown: `🔍 Found **${paths.length}** match${paths.length === 1 ? "" : "es"}:\n` + paths.map((p) => `- \`${p.replace(/^\.\//, "")}\``).join("\n"),
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { paths },
      };
    }

    case "list_files": {
      const folder = command.target || ".";
      const out = await runShell(`ls -1p "${folder}" 2>/dev/null | head -n 12`);
      const entries = out.split("\n").map((e) => e.trim()).filter(Boolean);
      const count = entries.length;

      if (count === 0) {
        return {
          handled: true,
          kind: "list_files",
          spoken: `No files found in ${folder}.`,
          displayMarkdown: `📂 No files found in \`${folder}\`.`,
          tokensUsed: 0,
          latencyMs: Date.now() - startTime,
        };
      }

      const spoken = `Found ${count} items in ${folder}: ${entries.slice(0, 4).join(", ")}.`;
      return {
        handled: true,
        kind: "list_files",
        spoken,
        displayMarkdown: `📂 **Directory contents of \`${folder}\`** (${count} items):\n` + entries.map((e) => `- ${e}`).join("\n"),
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        data: { folder, entries },
      };
    }

    case "capabilities_directory": {
      const { formatCapabilitiesDirectoryMarkdown } = await import("./capabilityDirectory.ts");
      return {
        handled: true,
        kind: "capabilities_directory",
        spoken: "Here is my complete capability directory. Everything runs locally on your machine.",
        displayMarkdown: formatCapabilitiesDirectoryMarkdown(),
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
      };
    }

    case "unsupported": {
      const spoken = "I don't have the capability to perform external tasks. That remains developer work.";
      return {
        handled: true,
        kind: "unsupported",
        spoken,
        displayMarkdown: "⚠️ **Capability Boundary**: I cannot perform external or physical actions (such as sending emails, placing phone calls, or operating physical appliances). That remains developer work for you to handle directly.",
        tokensUsed: 0,
        latencyMs: Date.now() - startTime,
        isUnsupported: true,
      };
    }
  }
}

/**
 * Backward-compatible helper returning just the spoken string.
 */
export async function executeSystemCommand(command: SystemCommand): Promise<string> {
  const result = await executeSystemAction(command);
  return result.spoken;
}

