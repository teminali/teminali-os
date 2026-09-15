/**
 * Teminali OS — Unified System Capability Directory
 *
 * Single source of truth for all built-in capabilities, local deterministic fast-paths,
 * media player controls, editor operations, system telemetry, and developer boundaries.
 *
 * Latency Standard: Sub-50ms (0 model tokens).
 */

export interface SystemCapability {
  id: string;
  name: string;
  category: "hardware" | "system" | "media" | "workspace" | "control" | "boundary";
  description: string;
  latencyBudget: string;
  tokenCost: number;
  samplePhrases: string[];
  executionTarget: string;
}

export const SYSTEM_CAPABILITIES: SystemCapability[] = [
  {
    id: "battery",
    name: "Battery & Power Health",
    category: "hardware",
    description: "Real-time battery percentage, charging state, cycle life, power source, and health telemetry.",
    latencyBudget: "< 35ms",
    tokenCost: 0,
    samplePhrases: [
      "What is my battery level?",
      "remaining battery battery capacity",
      "Is my laptop charging?",
      "Com'è la batteria?",
    ],
    executionTarget: "pmset -g batt (host fast-path)",
  },
  {
    id: "memory",
    name: "RAM & Memory Pressure",
    category: "hardware",
    description: "Physical RAM usage, free memory headroom, swap consumption, and system memory pressure.",
    latencyBudget: "< 40ms",
    tokenCost: 0,
    samplePhrases: [
      "Checking RAM health",
      "How much RAM am I using?",
      "Is my computer gasping for air?",
      "RAM usage stats",
    ],
    executionTarget: "vm_stat / sysctl (host fast-path)",
  },
  {
    id: "disk",
    name: "Storage & Disk Headroom",
    category: "hardware",
    description: "Root disk storage headroom, gigabytes free, total capacity, and volume utilization.",
    latencyBudget: "< 40ms",
    tokenCost: 0,
    samplePhrases: [
      "Check computer storage",
      "How much disk space is left?",
      "Check remaining storage headroom",
      "Available disk space",
    ],
    executionTarget: "df -k / (host fast-path)",
  },
  {
    id: "uptime_cpu",
    name: "System Uptime & Load",
    category: "system",
    description: "System boot time, active uptime duration, and 1/5/15 minute CPU load averages.",
    latencyBudget: "< 30ms",
    tokenCost: 0,
    samplePhrases: [
      "What is the system uptime?",
      "How long has this computer been running?",
      "Check CPU load",
    ],
    executionTarget: "uptime (host fast-path)",
  },
  {
    id: "os_info",
    name: "Operating System & Architecture",
    category: "system",
    description: "Host OS kernel version, platform release, and hardware architecture (Apple Silicon / Intel / x86).",
    latencyBudget: "< 25ms",
    tokenCost: 0,
    samplePhrases: [
      "What operating system am I running?",
      "What architecture is this machine?",
      "Which OS version is installed?",
    ],
    executionTarget: "uname -a / sw_vers (host fast-path)",
  },
  {
    id: "network",
    name: "Network & Connectivity",
    category: "system",
    description: "Default gateway connectivity, ping latency, local IP address, and offline detection.",
    latencyBudget: "< 60ms",
    tokenCost: 0,
    samplePhrases: [
      "Check my internet connection",
      "What is my local IP address?",
      "Am I online?",
    ],
    executionTarget: "route / scutil / ping (host fast-path)",
  },
  {
    id: "time_date",
    name: "Local Time & Date",
    category: "system",
    description: "Deterministic host local time, timezone abbreviation, and calendar date formatting.",
    latencyBudget: "< 10ms",
    tokenCost: 0,
    samplePhrases: [
      "What time is it?",
      "What's today's date?",
      "Che ore sono?",
      "Dimmi che ore sono",
    ],
    executionTarget: "Host system clock (deterministic)",
  },
  {
    id: "clipboard",
    name: "Clipboard Access",
    category: "system",
    description: "Reading or verifying text content currently held in the host operating system clipboard.",
    latencyBudget: "< 35ms",
    tokenCost: 0,
    samplePhrases: [
      "Check clipboard",
      "What's in my clipboard?",
      "Read clipboard content",
    ],
    executionTarget: "pbpaste / powershell clipboard (host fast-path)",
  },
  {
    id: "play_video",
    name: "Teminali OS Media Player",
    category: "media",
    description: "Instant playback of video files, movies, episodes, and clips in the native Teminali OS player.",
    latencyBudget: "< 30ms",
    tokenCost: 0,
    samplePhrases: [
      "Play one piece episode",
      "Play the video intro.mp4 in player",
      "Watch trailer.mov",
      "Pray episode 1000",
    ],
    executionTarget: "Teminali OS Player IPC (openMedia/play)",
  },
  {
    id: "open_file",
    name: "Code Editor File Viewer",
    category: "workspace",
    description: "Directly open and focus source code files, documents, or scripts in the Teminali code editor.",
    latencyBudget: "< 25ms",
    tokenCost: 0,
    samplePhrases: [
      "Open App.tsx",
      "Show file package.json",
      "Open index.html in the editor",
      "View README.md",
    ],
    executionTarget: "Teminali OS Editor Service (openFile)",
  },
  {
    id: "move_file",
    name: "File Organization & Move",
    category: "workspace",
    description: "Safely move or relocate files within the workspace or between directories.",
    latencyBudget: "< 45ms",
    tokenCost: 0,
    samplePhrases: [
      "Move file logo.png to assets",
      "Move data.json to src/config",
    ],
    executionTarget: "Host filesystem atomic move (fs.rename)",
  },
  {
    id: "find_file",
    name: "Fast File Locator",
    category: "workspace",
    description: "Locate matching file paths across the active project workspace.",
    latencyBudget: "< 50ms",
    tokenCost: 0,
    samplePhrases: [
      "Find file styles.css",
      "Where is vite.config.ts?",
      "Locate test.mjs",
    ],
    executionTarget: "Workspace file index (ripgrep/find)",
  },
  {
    id: "list_files",
    name: "Directory Lister",
    category: "workspace",
    description: "List files and subdirectories within a given folder or workspace root.",
    latencyBudget: "< 40ms",
    tokenCost: 0,
    samplePhrases: [
      "List files in src",
      "Show files in components folder",
      "What files are in root?",
    ],
    executionTarget: "Workspace directory scan",
  },
  {
    id: "spoken_approval",
    name: "Spoken Permissions & Voice Approvals",
    category: "control",
    description: "Spoken answers ('yes', 'allow', 'always', 'deny', 'no') immediately settle and dismiss permission modals.",
    latencyBudget: "< 10ms",
    tokenCost: 0,
    samplePhrases: [
      "Yes",
      "Allow",
      "Always allow",
      "No",
      "Refuse",
    ],
    executionTarget: "Unified approval store (useApprovalStore/commandApproval)",
  },
  {
    id: "capabilities_directory",
    name: "Capabilities Directory Browser",
    category: "system",
    description: "Interactive directory of all local actions, hardware tools, and latency standards available to the operator.",
    latencyBudget: "< 15ms",
    tokenCost: 0,
    samplePhrases: [
      "What are your capabilities?",
      "Show capabilities directory",
      "What can you do?",
      "List system capabilities",
    ],
    executionTarget: "Capability Directory Engine",
  },
  {
    id: "unsupported",
    name: "Strict Developer Boundaries",
    category: "boundary",
    description: "Instantly and deterministically identifies external/physical requests and clarifies they remain developer work.",
    latencyBudget: "< 5ms",
    tokenCost: 0,
    samplePhrases: [
      "Send an email to my boss",
      "Order a pizza",
      "Book a flight",
      "Transfer money",
    ],
    executionTarget: "Developer boundary governor (deterministic refusal)",
  },
];

/**
 * Returns all registered system capabilities.
 */
export function getAllCapabilities(): SystemCapability[] {
  return [...SYSTEM_CAPABILITIES];
}

/**
 * Returns capabilities filtered by category.
 */
export function getCapabilitiesByCategory(
  category: SystemCapability["category"]
): SystemCapability[] {
  return SYSTEM_CAPABILITIES.filter((c) => c.category === category);
}

/**
 * Formats the capability directory into a clean, compact Markdown table
 * matching Cursor UI standards.
 */
export function formatCapabilitiesDirectoryMarkdown(): string {
  const header = `### ⚡ Teminali OS — Capability Directory\n\n` +
    `*All capabilities execute locally via deterministic fast-paths in **< 50ms** consuming **0 model tokens**.*\n\n` +
    `| Capability | Latency | Tokens | Trigger Examples |\n` +
    `| :--- | :--- | :--- | :--- |\n`;

  const rows = SYSTEM_CAPABILITIES.map((c) => {
    const examples = c.samplePhrases.slice(0, 2).map((p) => `\`${p}\``).join(", ");
    return `| **${c.name}** | \`${c.latencyBudget}\` | \`${c.tokenCost}\` | ${examples} |`;
  }).join("\n");

  const footer = `\n\n> 🛡️ **Developer Boundaries**: External operations (emails, bookings, financial transactions, physical appliances) are strictly identified as operator developer work.`;

  return `${header}${rows}${footer}`;
}

/**
 * Formats an authoritative system prompt segment for Gemini Live and Local Voice Engine,
 * instructing the model about its direct fast-path tools and forbidding hallucinations or terminal bypasses.
 */
export function formatCapabilitiesDirectoryPrompt(): string {
  return `DIRECT BUILT-IN CAPABILITIES DIRECTORY (< 50ms, 0 TOKENS):
You are directly attached to Teminali OS with hard-coded fast-path execution for the following system capabilities:
- Battery & Power: Real-time charge, status, and health.
- RAM & Memory: Active RAM usage, free memory headroom, memory pressure.
- Storage & Disk: Root storage headroom, gigabytes free, total capacity.
- Uptime & CPU: System uptime and CPU load averages.
- OS & Architecture: macOS / Windows / Linux version and architecture.
- Media Player: Direct playback of video files, movies, and episodes (e.g. "play one piece episode", "play intro.mp4"). NEVER say you cannot play video!
- Code Editor: Direct opening and viewing of source code files (e.g. "open App.tsx").
- File System: Fast file moving, finding, and listing.
- Spoken Approvals: Spoken replies ("yes", "allow", "always", "refuse") resolve pending actions in < 10ms.
- Developer Boundaries: Physical or external actions (emails, phone calls, ordering food, banking) are strictly stated as developer work for the operator.
- Capability Directory: Complete directory of all actions when asked "what can you do".

CRITICAL RULE:
When the operator asks for any of these capabilities, NEVER run shell terminal commands (like pmset, df, vm_stat), NEVER spawn a CLI agent, and NEVER hallucinate that you lack tools. They are resolved automatically and deterministically by the system actions engine in under 50ms.`;
}
