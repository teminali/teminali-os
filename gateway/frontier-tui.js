import readline from "node:readline";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { PROFILES, listAvailableSkills, launchFrontier } from "./frontier-runner.js";

// ANSI TrueColor and 256-Color Palette
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  
  // Vibrant Neon & Modern Pastels
  brand: "\x1b[38;5;45m",       // Electric Cyan
  brandPurple: "\x1b[38;5;141m", // Neon Lavender
  brandGreen: "\x1b[38;5;49m",   // Emerald Neon
  brandGold: "\x1b[38;5;221m",   // Warm Gold
  brandRose: "\x1b[38;5;204m",   // Soft Rose
  
  // Grays & Dark UI
  gray: "\x1b[38;5;246m",
  darkGray: "\x1b[38;5;239m",
  dimBorder: "\x1b[38;5;238m",
  activeBorder: "\x1b[38;5;75m",
  bgSubtle: "\x1b[48;5;236m",
  bgCard: "\x1b[48;5;235m",
  
  // Status Colors
  success: "\x1b[38;5;48m",
  error: "\x1b[38;5;196m",
  warning: "\x1b[38;5;214m",
  info: "\x1b[38;5;117m",
};

export function renderHeroBanner() {
  const width = 80;
  const topBorder = `${C.brand}╭${"─".repeat(width - 2)}╮${C.reset}`;
  const bottomBorder = `${C.brand}╰${"─".repeat(width - 2)}╯${C.reset}`;
  
  return `
${topBorder}
${C.brand}│  ${C.bold}███████╗██████╗  ██████╗ ███╗   ██╗████████╗██╗███████╗██████╗ ${C.brandPurple} ██████╗ ██████╗ ██████╗ ███████╗${C.brand} │
${C.brand}│  ${C.bold}██╔════╝██╔══██╗██╔═══██╗████╗  ██║╚══██╔══╝██║██╔════╝██╔══██╗${C.brandPurple}██╔════╝██╔═══██╗██╔══██╗██╔════╝${C.brand} │
${C.brand}│  ${C.bold}█████╗  ██████╔╝██║   ██║██╔██╗ ██║   ██║   ██║█████╗  ██████╔╝${C.brandPurple}██║     ██║   ██║██║  ██║█████╗  ${C.brand} │
${C.brand}│  ${C.bold}██╔══╝  ██╔══██╗██║   ██║██║╚██╗██║   ██║   ██║██╔══╝  ██╔══██╗${C.brandPurple}██║     ██║   ██║██║  ██║██╔══╝  ${C.brand} │
${C.brand}│  ${C.bold}██║     ██║  ██║╚██████╔╝██║ ╚████║   ██║   ██║███████╗██║  ██║${C.brandPurple}╚██████╗╚██████╔╝██████╔╝███████╗${C.brand} │
${C.brand}│  ${C.bold}╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝${C.brandPurple} ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝${C.brand} │
${C.brand}│                                                                              │
${C.brand}│  ${C.gray}⚡ ${C.bold}Local-First Speed${C.reset}  •  ${C.gray}🧠 ${C.bold}Skill-Native Specialist Roles${C.reset}  •  ${C.gray}🛡️ ${C.bold}Hard Budget Control${C.reset}${C.brand}  │
${bottomBorder}`;
}

export function renderDashboardCards(state) {
  const profile = PROFILES[state.profile] || PROFILES.local;
  const isLocal = state.profile === "local";
  const costLabel = isLocal ? `${C.brandGreen}● $0.00 / token (100% Free Local Loopback)${C.reset}` : `${C.brandGold}● Dynamic Cap: $${state.budget} max${C.reset}`;
  const skillLabel = state.skill ? `${C.brandPurple}📦 ${state.skill}${C.reset}` : `${C.gray}Standard Engineering${C.reset}`;
  const dirName = path.basename(state.targetDir) || state.targetDir;
  
  return `
${C.dimBorder}┌─ ${C.bold}${C.brand}ACTIVE WORKSPACE${C.reset}${C.dimBorder} ──────────────────────────────────────┬─ ${C.bold}${C.brandPurple}ROUTING & INTELLIGENCE${C.reset}${C.dimBorder} ───────────┐${C.reset}
${C.dimBorder}│${C.reset}  📂 ${C.bold}${dirName.padEnd(24)}${C.reset} ${C.gray}[${state.targetDir.slice(-24)}]${C.reset}  ${C.dimBorder}│${C.reset}  ⚡ Mode:   ${C.bold}${C.brand}${state.profile.toUpperCase().padEnd(16)}${C.reset}       ${C.dimBorder}│${C.reset}
${C.dimBorder}│${C.reset}  🛠️  Skill: ${skillLabel.padEnd(46)} ${C.dimBorder}│${C.reset}  🎯 Engine: ${C.dim}${profile.label.slice(0, 24).padEnd(24)}${C.reset} ${C.dimBorder}│${C.reset}
${C.dimBorder}│${C.reset}  💰 Token Cost: ${costLabel.padEnd(43)} ${C.dimBorder}│${C.reset}  🛡️ Safety: Hard process isolation  ${C.dimBorder}│${C.reset}
${C.dimBorder}└─────────────────────────────────────────────────────────┴───────────────────────────────────────┘${C.reset}

 ${C.gray}Quick Commands:${C.reset} ${C.cyan}/skills${C.reset} ${C.gray}(select specialist)${C.reset}  •  ${C.cyan}/profile${C.reset} ${C.gray}(switch model)${C.reset}  •  ${C.cyan}/budget${C.reset} ${C.gray}(set USD limit)${C.reset}  •  ${C.cyan}/help${C.reset}
`;
}

export function renderBanner() {
  return renderHeroBanner();
}

export function renderStatusBar(state) {
  return renderDashboardCards(state);
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
  console.log(renderHeroBanner());
  console.log(renderDashboardCards(state));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\n${C.brand}${C.bold}frontier${C.reset} ${C.brandPurple}❯${C.reset} `,
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
${C.brand}${C.bold}╭─ FRONTIER CODE COMMAND MATRIX ──────────────────────────────────────────╮${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/skills${C.reset}             List all available specialist skill packs          ${C.brand}│${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/skill <name>${C.reset}       Mount specialist skill (website-builder, frontiercut) ${C.brand}│${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/profile <name>${C.reset}     Switch lane (local, auto, claude-sonnet, claude-opus)${C.brand}│${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/budget <usd>${C.reset}       Set maximum hard run budget in USD (e.g. 0.50)     ${C.brand}│${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/status${C.reset}             Refresh dashboard cards and model telemetry        ${C.brand}│${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/clear${C.reset}              Clear terminal and redraw dashboard                ${C.brand}│${C.reset}
${C.brand}│${C.reset}  ${C.cyan}/exit${C.reset} or ${C.cyan}/quit${C.reset}         Safely terminate session and gateway               ${C.brand}│${C.reset}
${C.brand}╰─────────────────────────────────────────────────────────────────────────╯${C.reset}
`);
          break;

        case "/skills": {
          const skills = listAvailableSkills();
          console.log(`\n${C.brandPurple}${C.bold}╭─ SPECIALIST SKILL PACKS ────────────────────────────────────────────────╮${C.reset}`);
          for (const s of skills) {
            console.log(`${C.brandPurple}│${C.reset}  📦 ${C.bold}${C.brandGold}${s.name.padEnd(22)}${C.reset} ${C.gray}${s.description.slice(0, 46)}...${C.reset} ${C.brandPurple}│${C.reset}`);
          }
          console.log(`${C.brandPurple}╰─────────────────────────────────────────────────────────────────────────╯${C.reset}`);
          console.log(`  ${C.gray}Mount a skill using:${C.reset} ${C.cyan}/skill ${skills[0]?.name || "website-builder"}${C.reset}\n`);
          break;
        }

        case "/skill": {
          const skillName = args[0];
          if (!skillName || skillName === "none" || skillName === "clear") {
            state.skill = null;
            console.log(`\n  ${C.gray}ℹ Specialist skill dismounted. Standard engineering active.${C.reset}\n`);
          } else {
            const available = listAvailableSkills().map((s) => s.name);
            if (available.includes(skillName)) {
              state.skill = skillName;
              console.log(`\n  ${C.brandGreen}✔ Mounted specialist skill: ${C.bold}${skillName}${C.reset}\n`);
            } else {
              console.log(`\n  ${C.warning}⚠ Unknown skill: ${skillName}. Run /skills to see available packs.${C.reset}\n`);
            }
          }
          break;
        }

        case "/profile": {
          const profileName = args[0];
          if (PROFILES[profileName]) {
            state.profile = profileName;
            console.log(`\n  ${C.brandGreen}✔ Switched to profile: ${C.bold}${profileName}${C.reset} (${C.dim}${PROFILES[profileName].label}${C.dim})\n`);
          } else {
            console.log(`\n  ${C.warning}⚠ Unknown profile. Options: ${Object.keys(PROFILES).join(", ")}${C.reset}\n`);
          }
          break;
        }

        case "/budget": {
          const budgetVal = args[0];
          if (budgetVal && !isNaN(parseFloat(budgetVal))) {
            state.budget = budgetVal;
            console.log(`\n  ${C.brandGreen}✔ Budget limit set to USD $${budgetVal}${C.reset}\n`);
          } else {
            console.log(`\n  ${C.warning}⚠ Usage: /budget <usd_amount> (e.g. /budget 0.50)${C.reset}\n`);
          }
          break;
        }

        case "/status":
          console.log(renderDashboardCards(state));
          break;

        case "/clear":
          console.clear();
          console.log(renderHeroBanner());
          console.log(renderDashboardCards(state));
          break;

        case "/exit":
        case "/quit":
          console.log(`\n  ${C.brandPurple}⚡ Frontier Code session terminated cleanly. Have a great day!${C.reset}\n`);
          process.exit(0);
          break;

        default:
          console.log(`\n  ${C.warning}⚠ Unknown command: ${cmd}. Type /help for command list.${C.reset}\n`);
      }

      rl.prompt();
      return;
    }

    // Execute Instruction with Visual Activity Card
    rl.pause();
    const skillBadge = state.skill ? ` [${state.skill}]` : "";
    console.log(`\n${C.brand}┌─ DISPATCHING INSTRUCTION${skillBadge} ─────────────────────────────────┐${C.reset}`);
    console.log(`${C.brand}│${C.reset}  💬 "${C.bold}${input.slice(0, 64)}${input.length > 64 ? "..." : ""}${C.reset}"`);
    console.log(`${C.brand}│${C.reset}  🚀 Engine: ${C.cyan}${state.profile}${C.reset}  │  🛡️ Limit: ${C.cyan}$${state.budget}${C.reset}`);
    console.log(`${C.brand}└─────────────────────────────────────────────────────────────────┘${C.reset}\n`);

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
      console.log(`\n${C.brandGreen}${C.bold}✔ Execution complete.${C.reset}\n`);
    } catch (err) {
      console.error(`\n${C.error}[Frontier Code Execution Error] ${err.message}${C.reset}\n`);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${C.gray}Frontier Code session ended.${C.reset}\n`);
    process.exit(0);
  });
}
