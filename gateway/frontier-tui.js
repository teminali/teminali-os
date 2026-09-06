import readline from "node:readline";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import os from "node:os";
import {
  MODEL_MODES,
  PROFILES,
  isExpertModelQualified,
  listAvailableSkills,
  launchFrontier,
  modelModeForProfile,
  selectProfileForMode,
} from "./frontier-runner.js";

/*
  The version in the footer, read from the root manifest rather than written
  out here. `npm_package_version` is set only when the TUI was started through
  an npm script, so the fallback beside it is what a directly-executed run
  shows — and a literal went stale the moment the version moved: the 0.0.1
  reset would have shipped a footer still claiming 0.1.0.
*/
const PACKAGE_VERSION = (() => {
  try {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(manifest, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const COLOR_ENABLED = Boolean(process.stdout.isTTY)
  && !("NO_COLOR" in process.env)
  && process.env.TERM !== "dumb";
const tone = (code) => COLOR_ENABLED ? code : "";

// ANSI Color Tokens. Plain output is automatic for pipes, CI capture, and NO_COLOR.
const C = {
  reset: tone("\x1b[0m"),
  bold: tone("\x1b[1m"),
  dim: tone("\x1b[2m"),
  italic: tone("\x1b[3m"),
  
  // Clean Modern Studio Colors (Matching OpenCode / Claude Code minimalism)
  white: tone("\x1b[38;5;255m"),
  lightGray: tone("\x1b[38;5;250m"),
  gray: tone("\x1b[38;5;244m"),
  darkGray: tone("\x1b[38;5;238m"),
  faintGray: tone("\x1b[38;5;236m"),
  
  cyan: tone("\x1b[38;5;39m"),
  blue: tone("\x1b[38;5;75m"),
  purple: tone("\x1b[38;5;141m"),
  green: tone("\x1b[38;5;48m"),
  orange: tone("\x1b[38;5;214m"),
  yellow: tone("\x1b[38;5;221m"),
  red: tone("\x1b[38;5;196m"),
  
  // Backgrounds
  bgCard: tone("\x1b[48;5;235m"),
  bgSubtle: tone("\x1b[48;5;234m"),
};

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ACTIVITY_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

export function visibleLength(text) {
  return [...stripAnsi(text)].length;
}

export function fitAnsi(text, width) {
  const limit = Math.max(0, Number(width) || 0);
  if (visibleLength(text) <= limit) return String(text ?? "");
  if (limit === 0) return "";
  const tokens = String(text ?? "").match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? [];
  let visible = 0;
  let output = "";
  for (const token of tokens) {
    if (ANSI_PATTERN.test(token)) {
      ANSI_PATTERN.lastIndex = 0;
      output += token;
      continue;
    }
    ANSI_PATTERN.lastIndex = 0;
    if (visible >= limit - 1) break;
    output += token;
    visible += 1;
  }
  return `${output}…${C.reset}`;
}

export function padAnsi(text, width) {
  const fitted = fitAnsi(text, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleLength(fitted)))}`;
}

export function supportsMotion({
  isTTY = process.stdout.isTTY,
  reducedMotion = process.env.FRONTIER_REDUCED_MOTION === "1",
  ci = Boolean(process.env.CI),
  term = process.env.TERM,
} = {}) {
  return Boolean(isTTY) && !reducedMotion && !ci && term !== "dumb";
}

export function renderActivityFrame({
  label = "Working",
  detail = "",
  frame = 0,
  elapsedMs = 0,
  width = getTerminalWidth(),
  animate = true,
} = {}) {
  const glyph = animate ? ACTIVITY_FRAMES[frame % ACTIVITY_FRAMES.length] : "\u2022";
  const elapsed = elapsedMs >= 1_000 ? ` ${Math.floor(elapsedMs / 1_000)}s` : "";
  const text = `${glyph} ${label}${detail ? ` \u00b7 ${detail}` : ""}${elapsed}`;
  const limit = Math.max(12, width - 2);
  const chars = [...text];
  const fitted = chars.length > limit ? `${chars.slice(0, limit - 1).join("")}\u2026` : text;
  return `${C.cyan}${fitted.slice(0, 1)}${C.reset}${C.white}${fitted.slice(1)}${C.reset}`;
}

export function createActivityIndicator({
  output = process.stdout,
  intervalMs = 100,
  animate = supportsMotion({ isTTY: output.isTTY }),
  now = () => Date.now(),
} = {}) {
  let active = false;
  let timer;
  let frame = 0;
  let label = "Working";
  let detail = "";
  let startedAt = 0;
  const draw = () => {
    if (!active) return;
    const value = renderActivityFrame({ label, detail, frame, elapsedMs: now() - startedAt, width: output.columns || 80, animate });
    output.write(`${output.isTTY ? "\r\x1b[2K" : ""}${value}${output.isTTY ? "" : "\n"}`);
    frame += 1;
  };
  return {
    start(nextLabel, nextDetail = "") {
      if (active) {
        label = nextLabel || label;
        detail = nextDetail;
        draw();
        return;
      }
      active = true;
      label = nextLabel;
      detail = nextDetail;
      startedAt = now();
      if (animate) output.write("\x1b[?25l");
      draw();
      if (animate) timer = setInterval(draw, intervalMs).unref();
    },
    update(nextLabel, nextDetail = "") {
      label = nextLabel || label;
      detail = nextDetail;
      if (!animate) draw();
    },
    stop(message = "") {
      if (!active) return;
      if (timer) clearInterval(timer);
      active = false;
      if (output.isTTY) output.write("\r\x1b[2K");
      if (message) output.write(`${C.green}\u2713${C.reset} ${message}\n`);
      if (animate) output.write("\x1b[?25h");
    },
    isActive() {
      return active;
    },
  };
}

export function friendlyError(error) {
  const detail = String(error?.message ?? error ?? "Unknown error");
  if (/memory|GB free/i.test(detail)) return { title: "Not enough free memory", hint: "Close memory-heavy apps or switch to Flash, then retry.", detail };
  if (/Max is locked|qualification/i.test(detail)) return { title: "Max is not ready yet", hint: "Use Auto or Flash until the expert model passes qualification.", detail };
  if (/cancel|SIGINT|SIGTERM/i.test(detail)) return { title: "Run cancelled", hint: "FrontierCode stopped safely and is releasing local model memory.", detail };
  if (/timeout|timed out/i.test(detail)) return { title: "Run timed out", hint: "Retry with a smaller task or inspect the active model and gateway health.", detail };
  if (/Ollama is unavailable|ECONNREFUSED/i.test(detail)) return { title: "Local model service is offline", hint: "Start Ollama, then retry. Auto and Flash stay local.", detail };
  if (/required_change_missing|made no workspace changes/i.test(detail)) return { title: "No verified change was produced", hint: "FrontierCode kept the workspace safe. Refine the request or inspect the run evidence.", detail };
  return { title: "Run stopped", hint: "Review the detail below, then retry or use /help.", detail };
}

export function activityCopy(phase, detail = "") {
  const labels = {
    preparing: "Preparing model",
    gateway: "Starting secure gateway",
    thinking: "Working",
    tool: "Applying change",
    verifying: "Verifying",
    recovery: "Recovering unfinished work",
    cancelling: "Cancelling safely",
    cleanup: "Releasing model memory",
  };
  return { label: labels[phase] ?? "Working", detail };
}

export function getTerminalWidth() {
  return process.stdout.columns || 80;
}

export function centerText(text, width = getTerminalWidth()) {
  const cleanLength = visibleLength(text);
  if (cleanLength >= width) return text;
  const leftPad = Math.max(0, Math.floor((width - cleanLength) / 2));
  return " ".repeat(leftPad) + text;
}

export function renderHeroBanner(width = getTerminalWidth()) {
  if (width < 52) {
    return `\n${centerText(`${C.bold}${C.white}◆ Frontier Code${C.reset}`, width)}\n`;
  }
  
  // Compact, ultra-clean 2-line pixel font that fits any terminal width without breaking
  const logoLine1 = `${C.bold}${C.white}█▀▀▀ █▀▀█ █▀▀█ █▄ █   ▀█▀ █ █▀▀█ █▀▀█${C.reset}`;
  const logoLine2 = `${C.bold}${C.gray}█▀▀  █▄▄▀ █  █ █ ▀█    █  █ █▀▀  █▄▄▀${C.reset}`;
  
  return `\n${centerText(logoLine1, width)}\n${centerText(logoLine2, width)}\n`;
}

export function renderInputCard(state) {
  const terminalWidth = state.terminalWidth ?? getTerminalWidth();
  const width = Math.max(16, Math.min(terminalWidth - 2, 76));
  const profile = PROFILES[state.profile] || PROFILES.local;
  const modelMode = state.modelMode === undefined
    ? modelModeForProfile(state.profile)
    : state.modelMode;
  const expertQualified = state.expertQualified ?? isExpertModelQualified();
  const isLocal = Boolean(modelMode)
    || state.profile === "local"
    || state.profile === "local-expert"
    || state.profile === "local-24b";
  
  const modePill = `${C.blue}${C.bold}Build${C.reset}`;
  const modelPill = modelMode === "flash"
    ? `${C.white}Qwen Coder 14B ${C.gray}Lightweight${C.reset}`
    : modelMode === "auto"
      ? expertQualified
        ? `${C.white}Qwen 14B ↔ Qwen3.8 ${C.gray}Hybrid${C.reset}`
        : `${C.white}Qwen 14B ${C.gray}Auto · Max locked${C.reset}`
      : modelMode === "max"
        ? `${C.white}Qwen3.8 27B IQ3_M ${C.gray}Heavyweight${C.reset}`
        : state.profile === "local-expert"
          ? `${C.white}Qwen3.8 27B IQ3_M ${C.gray}Local Expert${C.reset}`
      : state.profile === "local-24b"
        ? `${C.white}Devstral 24B ${C.gray}Local · 32GB+${C.reset}`
      : state.profile === "auto"
        ? `${C.white}Qwen 14B + Claude ${C.gray}Auto${C.reset}`
        : `${C.white}Claude Sonnet 5 ${C.gray}Frontier${C.reset}`;
  const skillPill = state.skill ? `${C.purple}${state.skill}${C.reset}` : `${C.gray}medium${C.reset}`;
  const costPill = isLocal ? `${C.green}$0.00 / tok${C.reset}` : `${C.orange}max $${state.budget}${C.reset}`;
  const modeSelector = Object.entries(MODEL_MODES).map(([name, item]) => {
    const pending = name === "max" && !expertQualified ? " · locked" : "";
    return name === modelMode
      ? `${C.blue}${C.bold}[${item.label}${pending}]${C.reset}`
      : `${C.gray}${item.label}${pending}${C.reset}`;
  }).join(`  ${C.darkGray}·${C.reset}  `);
  
  const topBar = `${C.blue}│${C.reset}`;
  const placeholder = terminalWidth < 58
    ? `${C.bold}${C.white}FrontierCode${C.reset} ${C.gray}ready${C.reset}`
    : `${C.bold}${C.white}FrontierCode${C.reset} ${C.gray}ready for your next task · type below${C.reset}`;
  const metaLine = `${modePill}  ${C.darkGray}·${C.reset}  ${modelPill}  ${C.darkGray}·${C.reset}  ${skillPill}  ${C.darkGray}·${C.reset}  ${costPill}`;
  const row = (content = "") => `${C.bgCard}${topBar} ${padAnsi(content, width - 2)}${C.reset}`;
  const card = [
    row(placeholder),
    row(),
    row(modeSelector),
    row(metaLine),
  ].join("\n");

  const hints = terminalWidth < 58
    ? `${C.bold}/mode${C.reset} ${C.gray}models${C.reset}   ${C.bold}/help${C.reset} ${C.gray}commands${C.reset}`
    : `${C.bold}/mode${C.reset} ${C.gray}Flash · Auto · Max${C.reset}   ${C.bold}/skills${C.reset} ${C.gray}specialists${C.reset}   ${C.bold}/help${C.reset} ${C.gray}commands${C.reset}`;
  const tip = `${C.orange}●${C.reset} ${C.bold}Tip${C.reset} ${C.gray}Use${C.reset} ${C.white}/help${C.reset} ${C.gray}to show the command dialog${C.reset}`;

  return `
${card}

${fitAnsi(hints, terminalWidth)}

  ${fitAnsi(tip, Math.max(1, terminalWidth - 2))}
`;
}

export function renderFooter(state) {
  const dir = state.targetDir.replace(os.homedir(), "~");
  const version = process.env.npm_package_version || PACKAGE_VERSION;
  const width = state.terminalWidth ?? getTerminalWidth();
  const available = Math.max(4, width - version.length - 2);
  const fittedDir = fitAnsi(dir, available);
  const space = Math.max(1, width - visibleLength(fittedDir) - version.length);
  return `${C.darkGray}${fittedDir}${" ".repeat(space)}${version}${C.reset}`;
}

export function renderBanner() {
  return renderHeroBanner();
}

export function renderStatusBar(state) {
  return renderInputCard(state);
}

export async function startFrontierTui(initialOptions = {}) {
  const state = {
    profile: initialOptions.profile || "local",
    modelMode: initialOptions.modelMode
      ?? modelModeForProfile(initialOptions.profile)
      ?? "auto",
    skill: initialOptions.skill || null,
    budget: initialOptions.budget || "0.20",
    targetDir: initialOptions.targetDir || process.cwd(),
    verbose: initialOptions.verbose || false,
  };

  function redrawScreen() {
    if (process.stdout.isTTY) console.clear();
    console.log(renderHeroBanner());
    console.log(renderInputCard(state));
    console.log(renderFooter(state));
    console.log();
  }

  redrawScreen();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}╰─${C.reset} ${C.bold}❯${C.reset} `,
  });

  rl.prompt();

  rl.on("line", async (rawLine) => {
    const input = rawLine.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle Slash Commands
    if (input.startsWith("/")) {
      const [cmd, ...args] = input.split(" ");

      switch (cmd.toLowerCase()) {
        case "/help":
          console.log(`
${C.bold}Commands:${C.reset}
  ${C.cyan}/skill <name>${C.reset}     Mount a specialist skill (website-builder, frontiercut-copilot)
  ${C.cyan}/skills${C.reset}           List available specialist skills
  ${C.cyan}/mode <name>${C.reset}      Select Flash, Auto, or Max model behavior
  ${C.cyan}/profile <name>${C.reset}   Switch an advanced routing profile directly
  ${C.cyan}/budget <usd>${C.reset}     Set maximum hard run budget in USD (e.g. 0.50)
  ${C.cyan}/clear${C.reset}            Clear terminal screen
  ${C.cyan}/exit${C.reset} or ${C.cyan}/quit${C.reset}   Exit Frontier Code
`);
          rl.prompt();
          return;

        case "/skills": {
          const skills = listAvailableSkills();
          console.log(`\n${C.bold}Available Skills:${C.reset}`);
          for (const s of skills) {
            console.log(`  ${C.purple}• ${s.name.padEnd(22)}${C.reset} ${C.gray}${s.description.slice(0, 50)}...${C.reset}`);
          }
          console.log();
          rl.prompt();
          return;
        }

        case "/skill": {
          const skillName = args[0];
          if (!skillName || skillName === "none" || skillName === "clear") {
            state.skill = null;
            console.log(`${C.gray}Skill cleared.${C.reset}`);
          } else {
            const available = listAvailableSkills().map((s) => s.name);
            if (available.includes(skillName)) {
              state.skill = skillName;
              console.log(`${C.green}Mounted skill: ${skillName}${C.reset}`);
            } else {
              console.log(`${C.yellow}Unknown skill: ${skillName}. Run /skills to see available packs.${C.reset}`);
            }
          }
          rl.prompt();
          return;
        }

        case "/profile": {
          const profileName = args[0];
          if (PROFILES[profileName]) {
            state.profile = profileName;
            state.modelMode = modelModeForProfile(profileName);
            console.log(`${C.green}Switched to profile: ${profileName}${C.reset}`);
          } else {
            console.log(`${C.yellow}Available profiles: ${Object.keys(PROFILES).join(", ")}${C.reset}`);
          }
          rl.prompt();
          return;
        }

        case "/mode": {
          const modeName = args[0]?.toLowerCase();
          if (modeName === "max" && !isExpertModelQualified()) {
            console.log(`${C.yellow}Max is locked until the heavyweight model passes qualification. Auto and Flash are ready.${C.reset}`);
          } else if (MODEL_MODES[modeName]) {
            state.modelMode = modeName;
            console.log(`${C.green}Model mode: ${MODEL_MODES[modeName].label}${C.reset}`);
          } else {
            console.log(`${C.yellow}Available modes: Flash, Auto, Max${C.reset}`);
          }
          rl.prompt();
          return;
        }

        case "/budget": {
          const budgetVal = args[0];
          if (budgetVal && !isNaN(parseFloat(budgetVal))) {
            state.budget = budgetVal;
          }
          rl.prompt();
          return;
        }

        case "/clear":
          redrawScreen();
          rl.prompt();
          return;

        case "/exit":
        case "/quit":
          console.log(`${C.gray}Goodbye!${C.reset}`);
          process.exit(0);
          break;

        default:
          console.log(`${C.yellow}Unknown command: ${cmd}. Type /help for assistance.${C.reset}`);
          rl.prompt();
          return;
      }
    }

    // Execute Instruction
    rl.pause();
    console.log();

    const activity = createActivityIndicator();
    const presentStatus = ({ phase, detail }) => {
      if (phase === "streaming") {
        if (activity.isActive()) activity.stop("Connected · streaming live");
        return;
      }
      const copy = activityCopy(phase, detail);
      if (activity.isActive()) activity.update(copy.label, copy.detail);
      else activity.start(copy.label, copy.detail);
    };
    try {
      const selection = state.modelMode
        ? selectProfileForMode(state.modelMode, input)
        : { profile: state.profile, reason: "advanced_profile", expertQualified: false };
      if (state.modelMode === "auto") {
        const selectedName = selection.profile === "local-expert" ? "Qwen3.8 Max" : "Qwen 14B Flash";
        console.log(`${C.gray}Auto selected ${selectedName}.${C.reset}\n`);
      }
      const selectedProfile = PROFILES[selection.profile];
      activity.start("Preparing", selectedProfile?.label ?? selection.profile);
      let outcome = await launchFrontier({
        command: "run",
        prompt: input,
        profile: selection.profile,
        skill: state.skill,
        budget: state.budget,
        targetDir: state.targetDir,
        verbose: state.verbose,
        onStatus: presentStatus,
      });
      if (
        state.modelMode === "auto"
        && selection.profile === "local"
        && selection.expertQualified
        && outcome?.ok === false
      ) {
        console.log(`${C.orange}Auto is escalating recovery to Qwen3.8 Max.${C.reset}\n`);
        outcome = await launchFrontier({
          command: "run",
          prompt: input,
          profile: "local-expert",
          skill: state.skill,
          budget: state.budget,
          targetDir: state.targetDir,
          verbose: state.verbose,
          onStatus: presentStatus,
        });
      }
      if (outcome?.ok === false || (Number.isInteger(outcome?.code) && outcome.code !== 0)) {
        activity.stop();
        const error = friendlyError(outcome?.reason ?? `Process exited with code ${outcome?.code ?? 1}`);
        console.error(`\n${C.red}✖ ${error.title}${C.reset}`);
        console.error(`${C.gray}${error.hint}${C.reset}`);
        console.error(`${C.darkGray}${error.detail}${C.reset}\n`);
      } else {
        activity.stop("Finished");
        console.log();
      }
    } catch (err) {
      activity.stop();
      const error = friendlyError(err);
      console.error(`\n${C.red}✖ ${error.title}${C.reset}`);
      console.error(`${C.gray}${error.hint}${C.reset}`);
      console.error(`${C.darkGray}${error.detail}${C.reset}\n`);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${C.gray}Frontier Code session ended.${C.reset}`);
    process.exit(0);
  });
}
