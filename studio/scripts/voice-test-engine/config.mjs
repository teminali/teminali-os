/**
 * Teminali OS Voice Test Engine — Configuration & Environment Discovery
 *
 * Provides smart, wise, and portable defaults:
 * - Parses CLI arguments and environment variables cleanly.
 * - Dynamically discovers output directories without hardcoded user paths.
 * - Manages query presets for single and multi-turn suite testing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDIO_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(STUDIO_ROOT, "..");

export const BENCHMARK_SUITE = [
  {
    id: "storage_delegation",
    title: "Tool Delegation Turn",
    query: "what is the total remaining size of my computer storage?",
    expectedKeywords: ["gigabyte", "storage", "available", "checking", "gb"],
    timeoutMs: 50000,
  },
  {
    id: "system_clock",
    title: "System Clock Turn",
    query: "what time is it right now?",
    expectedKeywords: ["time", "clock", "am", "pm", "is"],
    timeoutMs: 25000,
  },
  {
    id: "conversational_greeting",
    title: "Conversational Turn",
    query: "hello Temi, how are you today?",
    expectedKeywords: ["hello", "hi", "good", "ready", "temi", "how"],
    timeoutMs: 20000,
  },
];

export const CONTINUOUS_CONVERSATION_SUITE = [
  {
    id: "turn1_greeting",
    title: "Continuous Turn 1: Greeting",
    query: "hello Temi, how are you today?",
    expectedKeywords: ["hello", "hi", "good", "ready", "temi", "how", "well", "doing"],
    timeoutMs: 20000,
  },
  {
    id: "turn2_system_clock",
    title: "Continuous Turn 2: Natural Follow-up (No Wake Word)",
    query: "what time is it right now?",
    expectedKeywords: ["time", "clock", "am", "pm", "is", "it's"],
    timeoutMs: 20000,
  },
  {
    id: "turn3_storage_delegation",
    title: "Continuous Turn 3: Delegation Follow-up",
    query: "can you check my remaining storage?",
    expectedKeywords: ["storage", "gigabyte", "gb", "available", "checking", "free"],
    timeoutMs: 45000,
  },
];

/**
 * Parses CLI arguments into a structured options object.
 * @param {string[]} argv
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const getArg = (flag, alias, defaultValue) => {
    let idx = argv.indexOf(flag);
    if (idx === -1 && alias) idx = argv.indexOf(alias);
    if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
    return defaultValue;
  };

  const hasFlag = (...flags) => flags.some((f) => argv.includes(f));

  const isCi = hasFlag("--ci") || process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const mode = getArg("--mode", "-m", process.env.VOICE_TEST_MODE || (isCi ? "direct" : "acoustic"));
  const port = Number(getArg("--port", "-p", process.env.CDP_PORT || process.env.ELECTRON_REMOTE_DEBUGGING_PORT || "9222"));
  const query = getArg("--query", "-q", process.env.VOICE_TEST_QUERY || BENCHMARK_SUITE[0].query);
  const timeoutMs = Number(getArg("--timeout", "-t", process.env.VOICE_TEST_TIMEOUT || "50000"));
  const suite = hasFlag("--suite", "-s");
  const continuous = hasFlag("--continuous", "-c");
  const skipFocus = hasFlag("--no-focus") || isCi;
  const skipPlay = hasFlag("--no-play") || isCi;
  const forceReload = hasFlag("--reload", "-r");
  const fast = hasFlag("--fast", "-f");
  const jsonOutput = hasFlag("--json");
  const help = hasFlag("--help", "-h");

  // Smart output directory discovery
  const cliOutputDir = getArg("--output-dir", "-o", null);
  const envOutputDir = process.env.VOICE_TEST_OUTPUT_DIR || process.env.ANTIGRAVITY_ARTIFACTS_DIR;

  let resolvedOutputDir;
  if (cliOutputDir) {
    resolvedOutputDir = path.resolve(cliOutputDir);
  } else if (envOutputDir && fs.existsSync(envOutputDir)) {
    resolvedOutputDir = path.resolve(envOutputDir);
  } else {
    // Check if running inside an Antigravity agent session
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const brainDir = path.join(homeDir, ".gemini/antigravity-ide/brain");
    let detectedBrainScratch = null;

    if (fs.existsSync(brainDir)) {
      try {
        const convDirs = fs.readdirSync(brainDir).filter((d) => !d.startsWith("."));
        if (convDirs.length > 0) {
          // Sort by mtime descending to get the active conversation
          const sorted = convDirs
            .map((d) => ({ dir: d, mtime: fs.statSync(path.join(brainDir, d)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          const activeScratch = path.join(brainDir, sorted[0].dir, "scratch");
          if (fs.existsSync(activeScratch)) {
            detectedBrainScratch = activeScratch;
          }
        }
      } catch {
        // Fall back gracefully
      }
    }

    if (detectedBrainScratch) {
      resolvedOutputDir = detectedBrainScratch;
    } else {
      resolvedOutputDir = path.join(STUDIO_ROOT, "test-output", "voice");
    }
  }

  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  return {
    isCi,
    mode,
    port,
    query,
    timeoutMs,
    suite,
    continuous,
    skipFocus,
    skipPlay,
    forceReload,
    fast,
    jsonOutput,
    help,
    outputDir: resolvedOutputDir,
    studioRoot: STUDIO_ROOT,
    repoRoot: REPO_ROOT,
  };
}

export function printHelp() {
  console.log(`
Teminali OS — Smart, Wise & Portable Live Voice Dev Engine

Usage:
  npm run test:voice-live [options]
  node scripts/liveVoiceDevEngine.mjs [options]

Options:
  -q, --query <text>       Spoken query to test (default: computer storage check)
  -m, --mode <mode>        Engine mode: "direct" (fast pipeline) or "acoustic" (room mic) [default: direct]
  -s, --suite              Run the full 3-turn multi-scenario benchmark suite
  -f, --fast               Fast testing mode: background audio playback & minimal wait overhead
  -r, --reload             Force full stage reload before running test turn
  -p, --port <number>      CDP remote debugging port (default: 9222, auto-scans 9222-9226)
  -t, --timeout <ms>       Maximum turn completion timeout in ms [default: 50000]
  -o, --output-dir <path>  Directory to save WAV audio, screenshots, and JSON report
      --ci                 Headless CI mode: disables GUI focus & audio playback, enforces pass/fail exit code
      --no-focus           Do not bring Teminali OS or IDE to the foreground
      --no-play            Do not play captured voice audio aloud through speakers
      --json               Output only raw JSON benchmark report to stdout
  -h, --help               Display this help message

Environment Variables:
  CDP_PORT, ELECTRON_REMOTE_DEBUGGING_PORT  Port for Chrome DevTools Protocol
  VOICE_TEST_OUTPUT_DIR                     Path to output directory for test artifacts
  VOICE_TEST_MODE                           Default mode ("direct" | "acoustic")
  CI                                        Enables headless CI mode when "true"
`);
}
