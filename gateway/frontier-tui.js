import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import { PROFILES, listAvailableSkills, launchFrontier } from "./frontier-runner.js";

// ANSI Color Tokens
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[38;5;39m",
  green: "\x1b[38;5;42m",
  yellow: "\x1b[38;5;220m",
  blue: "\x1b[38;5;75m",
  magenta: "\x1b[38;5;177m",
  gray: "\x1b[38;5;244m",
  darkGray: "\x1b[38;5;238m",
  bgDark: "\x1b[48;5;235m",
};

export function renderBanner() {
  const line = `${C.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`;
  return `
${C.cyan}${C.bold}   ███████╗██████╗  ██████╗ ███╗   ██╗████████╗██╗███████╗██████╗      ██████╗ ██████╗ ██████╗ ███████╗
   ██╔════╝██╔══██╗██╔═══██╗████╗  ██║╚══██╔══╝██║██╔════╝██╔══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
   █████╗  ██████╔╝██║   ██║██╔██╗ ██║   ██║   ██║█████╗  ██████╔╝    ██║     ██║   ██║██║  ██║█████╗  
   ██╔══╝  ██╔══██╗██║   ██║██║╚██╗██║   ██║   ██║██╔══╝  ██╔══██╗    ██║     ██║   ██║██║  ██║██╔══╝  
   ██║     ██║  ██║╚██████╔╝██║ ╚████║   ██║   ██║███████╗██║  ██║    ╚██████╗╚██████╔╝██████╔╝███████╗
   ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝${C.reset}
   ${C.gray}The local-first, skill-native autonomous AI software engineering terminal.${C.reset}
${line}`;
}

export function renderStatusBar(state) {
  const profileLabel = PROFILES[state.profile]?.label || state.profile;
  const skillLabel = state.skill ? `${C.yellow}📦 ${state.skill}${C.reset}` : `${C.gray}None${C.reset}`;
  const dirLabel = path.basename(state.targetDir) || state.targetDir;

  return `
 ${C.gray}Directory:${C.reset} ${C.bold}${dirLabel}${C.reset}  │  ${C.gray}Profile:${C.reset} ${C.green}${state.profile}${C.reset} (${C.dim}${profileLabel}${C.dim})  │  ${C.gray}Skill:${C.reset} ${skillLabel}  │  ${C.gray}Budget:${C.reset} ${C.cyan}$${state.budget}${C.reset}
 ${C.gray}Type ${C.bold}/help${C.reset}${C.gray} for commands, ${C.bold}/skill <name>${C.reset}${C.gray} to mount a skill, or enter an instruction.${C.reset}
`;
}

export async function startFrontierTui(initialOptions = {}) {
  const state = {
    profile: initialOptions.profile || "local",
    skill: initialOptions.skill || null,
    budget: initialOptions.budget || "0.20",
    targetDir: initialOptions.targetDir || process.cwd(),
    verbose: initialOptions.verbose || false,
  };

  console.clear();
  console.log(renderBanner());
  console.log(renderStatusBar(state));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}${C.bold}frontier${C.reset} ${C.gray}❯${C.reset} `,
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
${C.bold}Frontier Code Commands:${C.reset}
  ${C.cyan}/skill <name>${C.reset}     Mount a specialist skill (website-builder, frontiercut-copilot, none)
  ${C.cyan}/skills${C.reset}           List available specialist skills
  ${C.cyan}/profile <name>${C.reset}   Switch model routing profile (local, auto, claude-sonnet, claude-opus)
  ${C.cyan}/budget <usd>${C.reset}     Set maximum hard run budget in USD (e.g. /budget 0.50)
  ${C.cyan}/status${C.reset}           Show current session state and gateway status
  ${C.cyan}/clear${C.reset}            Clear terminal screen
  ${C.cyan}/exit${C.reset} or ${C.cyan}/quit${C.reset}   Exit Frontier Code
`);
          break;

        case "/skills": {
          const skills = listAvailableSkills();
          console.log(`\n${C.bold}Available Skills:${C.reset}`);
          for (const s of skills) {
            console.log(`  ${C.yellow}• ${s.name.padEnd(20)}${C.reset} ${C.gray}${s.description}${C.reset}`);
          }
          console.log();
          break;
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
          break;
        }

        case "/profile": {
          const profileName = args[0];
          if (PROFILES[profileName]) {
            state.profile = profileName;
            console.log(`${C.green}Switched to profile: ${profileName} (${PROFILES[profileName].label})${C.reset}`);
          } else {
            console.log(`${C.yellow}Unknown profile. Available: ${Object.keys(PROFILES).join(", ")}${C.reset}`);
          }
          break;
        }

        case "/budget": {
          const budgetVal = args[0];
          if (budgetVal && !isNaN(parseFloat(budgetVal))) {
            state.budget = budgetVal;
            console.log(`${C.green}Budget limit set to USD $${budgetVal}${C.reset}`);
          } else {
            console.log(`${C.yellow}Usage: /budget <usd_amount> (e.g. /budget 0.50)${C.reset}`);
          }
          break;
        }

        case "/status":
          console.log(renderStatusBar(state));
          break;

        case "/clear":
          console.clear();
          console.log(renderBanner());
          console.log(renderStatusBar(state));
          break;

        case "/exit":
        case "/quit":
          console.log(`${C.gray}Goodbye!${C.reset}`);
          process.exit(0);
          break;

        default:
          console.log(`${C.yellow}Unknown command: ${cmd}. Type /help for assistance.${C.reset}`);
      }

      rl.prompt();
      return;
    }

    // Execute Instruction
    rl.pause();
    console.log(`\n${C.cyan}${C.bold}⚡ Executing with Frontier Code...${C.reset}\n`);

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
      console.log(`\n${C.green}✔ Done.${C.reset}\n`);
    } catch (err) {
      console.error(`\n${C.yellow}[Error] ${err.message}${C.reset}\n`);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${C.gray}Frontier Code session ended.${C.reset}`);
    process.exit(0);
  });
}
