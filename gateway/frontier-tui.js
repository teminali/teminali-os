import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { PROFILES, listAvailableSkills, launchFrontier } from "./frontier-runner.js";

// ANSI Color Tokens
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  
  // Clean Modern Studio Colors (Matching OpenCode / Claude Code minimalism)
  white: "\x1b[38;5;255m",
  lightGray: "\x1b[38;5;250m",
  gray: "\x1b[38;5;244m",
  darkGray: "\x1b[38;5;238m",
  faintGray: "\x1b[38;5;236m",
  
  cyan: "\x1b[38;5;39m",
  blue: "\x1b[38;5;75m",
  purple: "\x1b[38;5;141m",
  green: "\x1b[38;5;48m",
  orange: "\x1b[38;5;214m",
  yellow: "\x1b[38;5;221m",
  red: "\x1b[38;5;196m",
  
  // Backgrounds
  bgCard: "\x1b[48;5;235m",
  bgSubtle: "\x1b[48;5;234m",
};

export function getTerminalWidth() {
  return process.stdout.columns || 80;
}

export function centerText(text, width = getTerminalWidth()) {
  const cleanLength = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  if (cleanLength >= width) return text;
  const leftPad = Math.max(0, Math.floor((width - cleanLength) / 2));
  return " ".repeat(leftPad) + text;
}

export function renderHeroBanner() {
  const width = getTerminalWidth();
  
  // Compact, ultra-clean 2-line pixel font that fits any terminal width without breaking
  const logoLine1 = `${C.bold}${C.white}█▀▀ █▀█ █▀█ █▄░█ ▀█▀ █ █▀▀ █▀█   █▀▀ █▀█ █▀▄ █▀▀${C.reset}`;
  const logoLine2 = `${C.bold}${C.gray}█▀░ █▀▄ █▄█ █░▀█ ░█░ █ ██▄ █▀▄   █▄▄ █▄█ █▄▀ ██▄${C.reset}`;
  
  return `\n${centerText(logoLine1, width)}\n${centerText(logoLine2, width)}\n`;
}

export function renderInputCard(state) {
  const width = Math.min(getTerminalWidth() - 4, 76);
  const profile = PROFILES[state.profile] || PROFILES.local;
  const isLocal = state.profile === "local";
  
  const modePill = `${C.blue}${C.bold}Build${C.reset}`;
  const modelPill = isLocal 
    ? `${C.white}Devstral 24B ${C.gray}Local${C.reset}`
    : `${C.white}Claude Sonnet 5 ${C.gray}Frontier${C.reset}`;
  const skillPill = state.skill ? `${C.purple}${state.skill}${C.reset}` : `${C.gray}medium${C.reset}`;
  const costPill = isLocal ? `${C.green}$0.00 / tok${C.reset}` : `${C.orange}max $${state.budget}${C.reset}`;
  
  const topBar = `${C.blue}│${C.reset}`;
  const placeholder = `${C.gray}Ask anything... "Refactor component to clean CSS tokens"${C.reset}`;
  const metaLine = `${modePill}  ${C.darkGray}·${C.reset}  ${modelPill}  ${C.darkGray}·${C.reset}  ${skillPill}  ${C.darkGray}·${C.reset}  ${costPill}`;
  
  const card = [
    `${C.bgCard}  ${topBar} ${placeholder}${" ".repeat(Math.max(0, width - placeholder.replace(/\x1b\[[0-9;]*m/g, "").length - 6))}  ${C.reset}`,
    `${C.bgCard}  ${topBar}                                                                            ${C.reset}`,
    `${C.bgCard}  ${topBar} ${metaLine}${" ".repeat(Math.max(0, width - metaLine.replace(/\x1b\[[0-9;]*m/g, "").length - 6))}  ${C.reset}`,
  ].join("\n");

  const hints = `${C.bold}tab${C.reset} ${C.gray}skills${C.reset}   ${C.bold}ctrl+p${C.reset} ${C.gray}commands${C.reset}   ${C.bold}/profile${C.reset} ${C.gray}models${C.reset}`;
  const tip = `${C.orange}●${C.reset} ${C.bold}Tip${C.reset} ${C.gray}Use${C.reset} ${C.white}/help${C.reset} ${C.gray}to show the command dialog${C.reset}`;

  return `
${card}

${hints}

  ${tip}
`;
}

export function renderFooter(state) {
  const dir = state.targetDir.replace(os.homedir(), "~");
  const version = "1.0.0";
  const width = getTerminalWidth();
  const space = Math.max(2, width - dir.length - version.length - 2);
  return `${C.darkGray}${dir}${" ".repeat(space)}${version}${C.reset}`;
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
    skill: initialOptions.skill || null,
    budget: initialOptions.budget || "0.20",
    targetDir: initialOptions.targetDir || process.cwd(),
    verbose: initialOptions.verbose || false,
  };

  function redrawScreen() {
    console.clear();
    console.log(renderHeroBanner());
    console.log(renderInputCard(state));
    console.log("\n".repeat(Math.max(1, (process.stdout.rows || 24) - 16)));
    console.log(renderFooter(state));
  }

  redrawScreen();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[38;5;39m❯\x1b[0m `,
  });

  rl.prompt();

  rl.on("line", async (rawLine) => {
    const input = rawLine.trim();

    if (!input) {
      redrawScreen();
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
  ${C.cyan}/profile <name>${C.reset}   Switch model routing profile (local, auto, claude-sonnet, claude-opus)
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
          redrawScreen();
          rl.prompt();
          return;
        }

        case "/profile": {
          const profileName = args[0];
          if (PROFILES[profileName]) {
            state.profile = profileName;
            console.log(`${C.green}Switched to profile: ${profileName}${C.reset}`);
          } else {
            console.log(`${C.yellow}Available profiles: ${Object.keys(PROFILES).join(", ")}${C.reset}`);
          }
          redrawScreen();
          rl.prompt();
          return;
        }

        case "/budget": {
          const budgetVal = args[0];
          if (budgetVal && !isNaN(parseFloat(budgetVal))) {
            state.budget = budgetVal;
          }
          redrawScreen();
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
    console.log(`\n${C.blue}● Executing with Frontier Code...${C.reset}\n`);

    try {
      await launchFrontier({
        command: "run",
        prompt: input,
        profile: state.profile,
        skill: state.skill,
        budget: state.budget,
        targetDir: state.targetDir,
        verbose: state.verbose,
      });
      console.log(`\n${C.green}✔ Finished.${C.reset}\n`);
    } catch (err) {
      console.error(`\n${C.red}[Error] ${err.message}${C.reset}\n`);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${C.gray}Frontier Code session ended.${C.reset}`);
    process.exit(0);
  });
}
