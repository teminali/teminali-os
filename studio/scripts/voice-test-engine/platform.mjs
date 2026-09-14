/**
 * Teminali OS Voice Test Engine — Cross-Platform OS Abstractions
 *
 * Provides safe, graceful, and portable implementations for:
 * - Window focus management (macOS osascript, Linux wmctrl/xdotool, Windows PowerShell, graceful no-op)
 * - Audio playback (afplay, aplay, paplay, ffplay, PowerShell)
 * - Speech synthesis (say, espeak, PowerShell SAPI)
 */

import fs from "node:fs";
import { exec, spawn } from "node:child_process";

export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export const IS_WIN = process.platform === "win32";

/**
 * Executes a shell command safely without throwing.
 * @param {string} cmd
 * @returns {Promise<{ stdout: string, stderr: string, error: Error | null }>}
 */
function safeExec(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({ stdout: stdout ? stdout.trim() : "", stderr: stderr ? stderr.trim() : "", error });
    });
  });
}

/**
 * Activates a window / application by bundle ID or application name.
 * Respects `skipFocus` flag and gracefully no-ops on unsupported platforms.
 * @param {string | string[]} identifiers
 * @param {boolean} skipFocus
 */
export async function activateApp(identifiers, skipFocus = false) {
  if (skipFocus) return;

  const idList = Array.isArray(identifiers) ? identifiers : [identifiers];

  if (IS_MAC) {
    for (const id of idList) {
      // Try bundle ID first, then application name
      const script = id.includes(".")
        ? `tell application id "${id}" to activate`
        : `tell application "${id}" to activate`;
      const { error } = await safeExec(`osascript -e '${script}'`);
      if (!error) return; // Successfully activated
    }
  } else if (IS_LINUX) {
    for (const name of idList) {
      const shortName = name.split(".").pop();
      // Try wmctrl or xdotool
      const { error: wmErr } = await safeExec(`wmctrl -a "${shortName}" 2>/dev/null`);
      if (!wmErr) return;
      const { error: xdoErr } = await safeExec(`xdotool search --name "${shortName}" windowactivate 2>/dev/null`);
      if (!xdoErr) return;
    }
  } else if (IS_WIN) {
    for (const name of idList) {
      const shortName = name.split(".").pop();
      const psCmd = `powershell -Command "(New-Object -ComObject WScript.Shell).AppActivate('${shortName}')"`;
      const { error } = await safeExec(psCmd);
      if (!error) return;
    }
  }
}

/**
 * Brings Teminali OS (Electron) to the foreground.
 * @param {boolean} skipFocus
 */
export async function focusTemi(skipFocus = false) {
  return activateApp(["com.github.Electron", "Electron", "Teminali OS"], skipFocus);
}

/**
 * Brings the active IDE / editor (Google Antigravity IDE) to the foreground.
 * @param {boolean} skipFocus
 */
export async function focusIde(skipFocus = false) {
  return activateApp(["com.google.antigravity-ide", "Antigravity", "Code"], skipFocus);
}

/**
 * Plays an audio file aloud through the system speakers using native players.
 * Resolves safely if player exits, errors, or if audio playback is disabled.
 * When `asyncPlay` is true, launches playback in the background and resolves immediately.
 * @param {string} filePath
 * @param {boolean} skipPlay
 * @param {boolean} asyncPlay
 */
export function playAudioFile(filePath, skipPlay = false, asyncPlay = false) {
  if (skipPlay || !filePath || !fs.existsSync(filePath)) {
    return Promise.resolve();
  }

  if (asyncPlay) {
    try {
      if (IS_MAC) spawn("afplay", [filePath], { detached: true, stdio: "ignore" }).unref();
      else if (IS_LINUX) spawn("aplay", [filePath], { detached: true, stdio: "ignore" }).unref();
      else if (IS_WIN) spawn("powershell", ["-Command", `(New-Object Media.SoundPlayer '${filePath}').Play()`], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // Ignore background playback errors
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let player = null;

    if (IS_MAC) {
      player = spawn("afplay", [filePath]);
    } else if (IS_LINUX) {
      // Check for aplay, paplay, or ffplay
      player = spawn("aplay", [filePath]);
      player.on("error", () => {
        const fallback = spawn("paplay", [filePath]);
        fallback.on("close", resolve);
        fallback.on("error", () => resolve());
      });
      player.on("close", resolve);
      return;
    } else if (IS_WIN) {
      const psScript = `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`;
      player = spawn("powershell", ["-Command", psScript]);
    }

    if (player) {
      player.on("close", resolve);
      player.on("error", () => resolve());
    } else {
      resolve();
    }
  });
}

/**
 * Synthesizes text to a local audio file for acoustic microphone testing.
 * Reuses existing synthesis if cached to eliminate redundant generation overhead.
 * @param {string} text
 * @param {string} outPath
 * @param {{ rate?: number, force?: boolean }} options
 * @returns {Promise<boolean>} Whether synthesis succeeded
 */
export async function synthesizeSpeech(text, outPath, { rate = 220, force = false } = {}) {
  if (!force && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
    return true;
  }

  const sanitized = text.replace(/"/g, '\\"');

  if (IS_MAC) {
    const { error } = await safeExec(`say -v Samantha -r ${rate} "${sanitized}" -o "${outPath}"`);
    if (error) {
      // Try default voice
      const { error: fallbackErr } = await safeExec(`say -r ${rate} "${sanitized}" -o "${outPath}"`);
      return !fallbackErr && fs.existsSync(outPath);
    }
    return fs.existsSync(outPath);
  } else if (IS_LINUX) {
    const { error } = await safeExec(`espeak -s ${rate} "${sanitized}" -w "${outPath}" 2>/dev/null`);
    return !error && fs.existsSync(outPath);
  } else if (IS_WIN) {
    const psScript = `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.Rate = 2; $synth.SetOutputToWaveFile('${outPath}'); $synth.Speak('${sanitized}')`;
    const { error } = await safeExec(`powershell -Command "${psScript}"`);
    return !error && fs.existsSync(outPath);
  }

  return false;
}

/**
 * Returns platform details for diagnostics and benchmark reports.
 */
export function getPlatformInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    isMac: IS_MAC,
    isLinux: IS_LINUX,
    isWindows: IS_WIN,
  };
}
