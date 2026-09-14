#!/usr/bin/env node
/**
 * Teminali OS — Autonomous Unscripted Endurance Edit Tester
 *
 * Runs progressive code editing turns on real project files in test-website.
 * Dynamically analyzes workspace state, generates contextual unscripted edit requests,
 * speaks aloud hands-free, approves shell commands, checks live code streaming,
 * verifies diff staging in the review dock, clicks compact Accept all,
 * and validates syntax & disk integrity after every turn.
 *
 * Continues turn after turn until a breaking condition or failure occurs (or max limit reached).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = path.resolve(__dirname, "..");
const TARGET_DIR = "/Users/teminali/Documents/my_projects/test-website";
const OUTPUT_DIR = path.join(STUDIO_ROOT, "benchmark-results", "endurance-edit-test");
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, "screenshots");
const TURNS_DIR = path.join(OUTPUT_DIR, "turns");
const LEDGER_PATH = path.join(OUTPUT_DIR, "endurance_ledger.json");

for (const d of [OUTPUT_DIR, SCREENSHOTS_DIR, TURNS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const IS_MAC = process.platform === "darwin";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse CLI flags
const rawArgs = process.argv.slice(2);
const MAX_TURNS = (() => {
  const t = rawArgs.find((a) => a.startsWith("--max-turns="));
  return t ? parseInt(t.split("=")[1], 10) : 15;
})();
const CLEAN_SLATE = rawArgs.includes("--clean");

// Ensure system volume is clearly audible
if (IS_MAC) {
  try {
    execSync("osascript -e 'set volume output volume 75'", { stdio: "ignore" });
  } catch {}
}

function speakAloud(text, voice = "Ava (Enhanced)", rate = 185) {
  return new Promise((resolve) => {
    if (IS_MAC) {
      const p = spawn("say", ["-v", voice, "-r", String(rate), text]);
      p.on("close", resolve);
      p.on("error", () => {
        const fallback = spawn("say", ["-r", String(rate), text]);
        fallback.on("close", resolve);
        fallback.on("error", resolve);
      });
    } else {
      const p = spawn("espeak", ["-s", String(rate), text]);
      p.on("close", resolve);
      p.on("error", resolve);
    }
  });
}

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.consoleLogs = [];

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = msg.params?.args?.map((a) => a.value ?? a.description ?? "").join(" ");
          if (text) this.consoleLogs.push({ type: msg.params.type, text, time: Date.now() });
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };
  }

  static async connect(preferredPort = 9222) {
    const candidatePorts = [preferredPort, 9223, 9224, 9225, 9226];
    for (const port of candidatePorts) {
      try {
        const res = await fetch(`http://localhost:${port}/json`);
        if (!res.ok) continue;
        const pages = await res.json();
        const temi = pages.find((p) => p.url?.includes("3000") || p.title?.toLowerCase().includes("teminali"));
        if (temi && temi.webSocketDebuggerUrl) {
          const ws = new WebSocket(temi.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
          });
          const client = new CDPClient(ws);
          await client.call("Runtime.enable");
          await client.call("Page.enable");
          return client;
        }
      } catch {}
    }
    throw new Error(`Could not connect to Electron CDP on ports [${candidatePorts.join(", ")}].`);
  }

  call(method, params = {}) {
    const curId = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(curId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  async eval(expression, awaitPromise = false) {
    const res = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || "JS Evaluation Exception");
    }
    return res?.result?.value;
  }

  async captureScreenshot(filename) {
    try {
      const res = await this.call("Page.captureScreenshot", { format: "png" });
      if (res?.data) {
        const filePath = path.join(SCREENSHOTS_DIR, filename);
        fs.writeFileSync(filePath, Buffer.from(res.data, "base64"));
        return filePath;
      }
    } catch {}
    return null;
  }

  close() {
    this.ws.close();
  }
}

/**
 * Unscripted dynamic prompt generator.
 * Inspects the current state of files in target directory and generates
 * creative, progressive edit requests that push features, state, styling, and architecture.
 */
function generateDynamicEditGoal(turnIndex, targetDir) {
  const hasIndex = fs.existsSync(path.join(targetDir, "index.html"));
  const hasStyle = fs.existsSync(path.join(targetDir, "style.css"));
  const hasAppJs = fs.existsSync(path.join(targetDir, "app.js"));
  const hasSpecials = fs.existsSync(path.join(targetDir, "specials.json"));

  let htmlContent = "";
  let cssContent = "";
  let jsContent = "";

  try {
    if (hasIndex) htmlContent = fs.readFileSync(path.join(targetDir, "index.html"), "utf8");
    if (hasStyle) cssContent = fs.readFileSync(path.join(targetDir, "style.css"), "utf8");
    if (hasAppJs) jsContent = fs.readFileSync(path.join(targetDir, "app.js"), "utf8");
  } catch {}

  // Turn 1: If empty or clean slate, create initial baseline
  if (!hasIndex || !hasStyle || htmlContent.length < 100) {
    return {
      type: "create-baseline",
      prompt: "Temi, write an index.html and style.css for our Italian espresso bar in this project.",
      approval: "Yes Temi, I allow you to run that command.",
      expectFiles: ["index.html", "style.css"],
    };
  }

  // Turn 2+: Progressive unscripted edits
  if (!hasAppJs || jsContent.length < 50) {
    return {
      type: "create-app-js",
      prompt: "Temi, create an app.js file that implements an interactive shopping cart with an item counter, a subtotal calculator with 10% tax, and link it in index.html.",
      approval: "Yes Temi, I allow creating app dot js.",
      expectFiles: ["app.js", "index.html"],
    };
  }

  if (!htmlContent.includes("cart-drawer") && !htmlContent.includes("shopping-cart")) {
    return {
      type: "add-cart-drawer",
      prompt: "Temi, update index.html and style.css to add a slide-out shopping cart drawer overlay with frosted glass blur and a checkout button.",
      approval: "Yes Temi, I allow updating index dot html and style dot css.",
      expectFiles: ["index.html", "style.css"],
    };
  }

  if (!cssContent.includes("--primary") && !cssContent.includes("--accent")) {
    return {
      type: "refactor-css-variables",
      prompt: "Temi, refactor style.css to define a comprehensive CSS custom properties system in :root with warm espresso dark mode tokens, and add hover micro-animations to all menu cards.",
      approval: "Yes Temi, I allow the style refactor.",
      expectFiles: ["style.css"],
    };
  }

  if (!htmlContent.includes("reservation") && !htmlContent.includes("modal")) {
    return {
      type: "add-reservation-modal",
      prompt: "Temi, update index.html and app.js to add an espresso bar table reservation modal with inputs for name, guests, date, and interactive confirmation feedback.",
      approval: "Yes Temi, I allow adding the reservation modal.",
      expectFiles: ["index.html", "app.js"],
    };
  }

  if (!htmlContent.includes("review") && !htmlContent.includes("testimonial")) {
    return {
      type: "add-reviews-carousel",
      prompt: "Temi, update index.html and style.css to add a customer reviews section featuring 5-star rating badges and authentic quotes from Milanese regulars.",
      approval: "Yes Temi, I allow adding the customer reviews section.",
      expectFiles: ["index.html", "style.css"],
    };
  }

  if (!hasSpecials) {
    return {
      type: "create-specials-json",
      prompt: "Temi, create a specials.json file with Italian pastries like Cannoli and Tiramisu, and update app.js to dynamically fetch and render them in a daily specials section.",
      approval: "Yes Temi, I allow creating specials dot json and updating app dot js.",
      expectFiles: ["specials.json", "app.js"],
    };
  }

  if (!cssContent.includes("@keyframes") && !cssContent.includes("animation")) {
    return {
      type: "add-css-animations",
      prompt: "Temi, update style.css to add realistic rising coffee steam animations and a smooth breathing pulse effect on the primary call to action button.",
      approval: "Yes Temi, I allow adding steam and pulse animations.",
      expectFiles: ["style.css"],
    };
  }

  if (!jsContent.includes("localStorage")) {
    return {
      type: "add-local-storage",
      prompt: "Temi, update app.js to persist cart items and reservation state in localStorage so customer orders remain saved across browser reloads.",
      approval: "Yes Temi, I allow adding local storage persistence.",
      expectFiles: ["app.js"],
    };
  }

  if (!htmlContent.includes("accordion") && !htmlContent.includes("faq")) {
    return {
      type: "add-faq-accordion",
      prompt: "Temi, update index.html and app.js to add an interactive FAQ accordion section explaining our coffee bean origins and roasting process with smooth toggle transitions.",
      approval: "Yes Temi, I allow adding the FAQ accordion.",
      expectFiles: ["index.html", "app.js"],
    };
  }

  if (!htmlContent.includes("newsletter") && !htmlContent.includes("subscribe")) {
    return {
      type: "add-newsletter-form",
      prompt: "Temi, update index.html and style.css to add an artisanal newsletter subscription form with client-side email format validation and a glowing submit button.",
      approval: "Yes Temi, I allow adding the newsletter form.",
      expectFiles: ["index.html", "style.css"],
    };
  }

  // Deep refactoring and polishing turns
  const polishTurns = [
    {
      type: "theme-toggle",
      prompt: "Temi, update app.js and style.css to implement a one-click dark and warm light theme toggle switch with a smooth CSS transition.",
      approval: "Yes Temi, I allow adding the theme toggle.",
      expectFiles: ["app.js", "style.css"],
    },
    {
      type: "coffee-quiz",
      prompt: "Temi, update index.html and app.js to add a mini 3-question coffee personality quiz that recommends either an Espresso Macchiato, Cortado, or Affogato based on answers.",
      approval: "Yes Temi, I allow adding the coffee quiz.",
      expectFiles: ["index.html", "app.js"],
    },
    {
      type: "sound-effects-api",
      prompt: "Temi, update app.js to synthesize a subtle Web Audio API chime sound whenever an item is added to the cart.",
      approval: "Yes Temi, I allow adding the Web Audio chime.",
      expectFiles: ["app.js"],
    },
    {
      type: "mobile-nav-refinement",
      prompt: "Temi, update index.html and style.css to implement an animated hamburger navigation bar for mobile viewports with WCAG AA compliance.",
      approval: "Yes Temi, I allow updating the mobile navigation.",
      expectFiles: ["index.html", "style.css"],
    },
  ];

  const selected = polishTurns[(turnIndex - 11) % polishTurns.length];
  return selected;
}

/**
 * Validates code syntax on disk. Returns null if valid, or error message string if broken.
 */
function validateDiskSyntax(targetDir) {
  const errors = [];

  // 1. JavaScript validation
  const jsFiles = ["app.js", "main.js", "script.js"];
  for (const f of jsFiles) {
    const p = path.join(targetDir, f);
    if (fs.existsSync(p)) {
      try {
        execSync(`node -c "${p}"`, { stdio: "pipe" });
      } catch (err) {
        errors.push(`JavaScript syntax error in ${f}: ${err.stderr?.toString() || err.message}`);
      }
    }
  }

  // 2. JSON validation
  const jsonFiles = ["specials.json", "menu.json", "data.json"];
  for (const f of jsonFiles) {
    const p = path.join(targetDir, f);
    if (fs.existsSync(p)) {
      try {
        JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (err) {
        errors.push(`JSON parse error in ${f}: ${err.message}`);
      }
    }
  }

  // 3. HTML basic integrity
  const htmlPath = path.join(targetDir, "index.html");
  if (fs.existsSync(htmlPath)) {
    const content = fs.readFileSync(htmlPath, "utf8");
    if (content.length === 0) errors.push("index.html is empty (0 bytes).");
    if (!content.includes("<html") || !content.includes("</html>")) {
      errors.push("index.html has unclosed or missing <html> tags.");
    }
  }

  // 4. CSS basic integrity
  const cssPath = path.join(targetDir, "style.css");
  if (fs.existsSync(cssPath)) {
    const content = fs.readFileSync(cssPath, "utf8");
    if (content.length === 0) errors.push("style.css is empty (0 bytes).");
    // Check balanced braces
    const openBraces = (content.match(/\{/g) || []).length;
    const closeBraces = (content.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      errors.push(`style.css has mismatched braces: ${openBraces} open vs ${closeBraces} close.`);
    }
  }

  return errors.length > 0 ? errors.join(" | ") : null;
}

async function runConversationalTurn(cdp, turnIndex, goal, screenshotPrefix) {
  console.log("\n==================================================================");
  console.log(`[TURN ${turnIndex}] DYNAMIC GOAL: ${goal.type.toUpperCase()}`);
  console.log(`ASSISTANT (Speaking Aloud Into Room): "${goal.prompt}"`);
  console.log("==================================================================");

  // Mute mic so Ava's speech and room audio don't cause self-echo or unwanted barge-in
  await cdp.eval(`window.__temiVoiceTest?.muteMic?.()`);
  await speakAloud(goal.prompt);
  await pause(400);

  console.log("  Sending spoken turn to Temi...");
  const turnPromise = cdp.eval(
    `window.__temiVoiceTest.runVoiceTestTurn(${JSON.stringify(goal.prompt)}, 75000)`,
    true
  );

  let turnFinished = false;
  let turnResult = null;
  turnPromise.then((res) => {
    turnFinished = true;
    turnResult = res;
  }).catch((err) => {
    turnFinished = true;
    console.warn("  Turn result note:", err?.message || String(err));
  });

  // Wait for background task to initialize
  console.log("  [MONITOR] Watching for task delegation...");
  let started = false;
  for (let i = 0; i < 30; i++) {
    const isRunning = await cdp.eval(`Boolean(window.__temiVoiceTest?.isTaskRunning?.())`);
    if (isRunning) {
      started = true;
      console.log("  [DELEGATED] Background coding task started.");
      break;
    }
    await pause(400);
  }

  // Continuous loop: monitor approvals and handle hands-free
  let approvalCount = 0;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 85000) {
    const state = await cdp.eval(`(async () => {
      const { useApprovalStore } = await import("/src/store/approvalStore.ts");
      const isRunning = Boolean(window.__temiVoiceTest?.isTaskRunning?.());
      const pending = useApprovalStore.getState().pending;
      const hasApproval = Boolean(window.__temiVoiceTest?.hasPendingApproval?.());
      return {
        isRunning,
        hasApproval,
        action: pending?.action || "command"
      };
    })()`, true);

    if (state.hasApproval) {
      started = true;
      approvalCount++;
      console.log(`\n  [APPROVAL DETECTED #${approvalCount}] Action: ${state.action.substring(0, 60)}...`);
      await cdp.captureScreenshot(`${screenshotPrefix}_approval_${approvalCount}.png`);

      console.log(`  ASSISTANT (Speaking Aloud): "${goal.approval}"`);
      const speakPromise = speakAloud(goal.approval);
      await cdp.eval(`window.__temiVoiceTest?.approvePendingCommand?.()`);
      console.log(`  [APPROVAL GRANTED #${approvalCount}] Allowed.`);
      await speakPromise;
      await pause(1000);
    }

    if (started && !state.isRunning && !state.hasApproval) {
      console.log("  [TASK FINISHED] Coding run completed.");
      break;
    }

    if (!started && turnFinished && Date.now() - pollStart > 12000 && !state.isRunning && !state.hasApproval) {
      console.log("  [TURN COMPLETED] Direct turn settled.");
      break;
    }
    await pause(600);
  }

  // Detect and handle review dock
  await pause(1200);
  const reviewInfo = await cdp.eval(`(async () => {
    const { useChangeStore } = await import("/src/store/changeStore.ts");
    const changes = useChangeStore.getState().changes || [];
    const hasBtn = Boolean(window.__temiVoiceTest?.hasPendingChangesReview?.());
    return { count: changes.length, hasBtn };
  })()`, true);

  if (reviewInfo?.count > 0 || reviewInfo?.hasBtn) {
    console.log(`\n  [REVIEW DOCK DETECTED] ${reviewInfo.count} files changed. Staged diffs active.`);
    await cdp.captureScreenshot(`${screenshotPrefix}_review_dock.png`);
    await pause(1200);
    const accepted = await cdp.eval(`window.__temiVoiceTest?.acceptPendingChangesReview?.()`);
    console.log(`  [ACCEPT ALL CLICKED] Clicked compact Accept all button: ${accepted}`);
    await pause(800);
  }

  if (!turnResult) {
    try {
      turnResult = await turnPromise;
    } catch (err) {
      console.warn("  Turn result note:", err?.message || String(err));
    }
  }

  const transcript = (turnResult?.transcript || "").trim();
  console.log(`\n  TEMI SPOKE: "${transcript || '(reported)'}"`);
  console.log(`  Voiced: ${turnResult?.isVoiced ? "YES" : "NO"} | Duration: ${turnResult?.durationSeconds || 0}s`);

  if (transcript.toLowerCase().includes("cannot assist with that request")) {
    throw new Error(`Temi refused or failed the turn with: "${transcript}"`);
  }

  if (turnResult?.base64Wav) {
    fs.writeFileSync(path.join(TURNS_DIR, `turn_${turnIndex}.wav`), Buffer.from(turnResult.base64Wav, "base64"));
  }

  await pause(2000);
  await cdp.captureScreenshot(`${screenshotPrefix}_settled.png`);

  // Verify disk files
  const syntaxError = validateDiskSyntax(TARGET_DIR);
  if (syntaxError) {
    throw new Error(`Syntax validation failure after Turn ${turnIndex}: ${syntaxError}`);
  }

  // Check expected files exist
  if (goal.expectFiles) {
    for (const ef of goal.expectFiles) {
      const p = path.join(TARGET_DIR, ef);
      if (!fs.existsSync(p)) {
        throw new Error(`Expected file was not created or found: ${ef}`);
      }
      const stat = fs.statSync(p);
      if (stat.size === 0) {
        throw new Error(`File ${ef} was created with 0 bytes.`);
      }
    }
  }

  return {
    turnIndex,
    goal: goal.type,
    prompt: goal.prompt,
    transcript,
    voiced: Boolean(turnResult?.isVoiced),
    durationSeconds: turnResult?.durationSeconds || 0,
    approvals: approvalCount,
    filesChanged: reviewInfo?.count || 0,
  };
}

async function main() {
  console.log("\n==================================================================");
  console.log("   TEMINALI OS — AUTONOMOUS UN-SCRIPTED ENDURANCE EDIT TESTER");
  console.log("   Workspace: /Users/teminali/Documents/my_projects/test-website");
  console.log(`   Endurance Target: Run progressive edits until failure (Max ${MAX_TURNS} turns)`);
  console.log("==================================================================\n");

  if (CLEAN_SLATE) {
    console.log("[SETUP] Cleaning test-website directory for clean slate...");
    if (fs.existsSync(TARGET_DIR)) {
      for (const f of fs.readdirSync(TARGET_DIR)) {
        fs.rmSync(path.join(TARGET_DIR, f), { recursive: true, force: true });
      }
    }
  }

  console.log("[SETUP] Connecting to Teminali OS over CDP...");
  const cdp = await CDPClient.connect();
  console.log("[SETUP] CDP Connected successfully.\n");

  // Synchronize app state to test-website
  await cdp.eval(`(async () => {
    localStorage.setItem("temi.voice", "Sulafat");
    const { WorkspaceService } = await import("/src/services/workspaceService.ts");
    const { useStudioStore } = await import("/src/store/studioStore.ts");
    const { useProjectLibraryStore } = await import("/src/hooks/useProjectLibrary.ts");
    const { useAssistantActivityStore } = await import("/src/store/assistantActivityStore.ts");
    
    // Ensure test-website is open
    const resp = await WorkspaceService.openProject("${TARGET_DIR}");
    useStudioStore.getState().setWorkspacePath(resp.current.path);
    await useProjectLibraryStore.getState().fetchProjects();

    // Close stale editor tabs
    const studio = useStudioStore.getState();
    for (const tab of [...studio.tabs]) {
      studio.closeTab(tab.id);
    }

    // Ensure Frontier engine is active
    useAssistantActivityStore.getState().setActiveEngine("frontier");

    // Clear previous changes
    const { useChangeStore } = await import("/src/store/changeStore.ts");
    useChangeStore.getState().acceptAll();

    // Turn on listening
    if (window.__temiVoiceTest?.turnOnListening) {
      await window.__temiVoiceTest.turnOnListening();
    }
  })()`, true);

  await pause(1000);
  await cdp.captureScreenshot("00_endurance_start.png");

  const completedTurns = [];
  let brokenReason = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const goal = generateDynamicEditGoal(turn, TARGET_DIR);
    const prefix = `turn_${String(turn).padStart(2, "0")}_${goal.type}`;

    try {
      const summary = await runConversationalTurn(cdp, turn, goal, prefix);
      completedTurns.push(summary);
      console.log(`\n  >>> TURN ${turn} PASSED SUCCESSFULLY: ${goal.type} <<<`);

      // Log disk state
      const currentFiles = fs.readdirSync(TARGET_DIR);
      console.log(`      Current workspace files: ${currentFiles.join(", ")}`);
      for (const f of currentFiles) {
        const sz = fs.statSync(path.join(TARGET_DIR, f)).size;
        console.log(`        - ${f} (${sz} bytes)`);
      }

      await pause(2500);
    } catch (err) {
      brokenReason = {
        turn,
        goal: goal.type,
        error: err.message,
        timestamp: new Date().toISOString(),
      };
      console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
      console.error(`[ENDURANCE BREAKPOINT DETECTED] Failed on Turn ${turn} (${goal.type})!`);
      console.error(`Reason: ${err.message}`);
      console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
      await cdp.captureScreenshot(`failure_turn_${String(turn).padStart(2, "0")}.png`);
      break;
    }
  }

  // Final summary
  console.log("\n==================================================================");
  console.log("   ENDURANCE TEST RUN COMPLETED");
  console.log(`   Total Turns Completed: ${completedTurns.length} / ${MAX_TURNS}`);
  console.log(`   Status: ${brokenReason ? `BROKE ON TURN ${brokenReason.turn}` : "ALL TURNS PASSED UNBROKEN"}`);
  if (brokenReason) {
    console.log(`   Failure Diagnosis: ${brokenReason.error}`);
  }
  console.log("==================================================================\n");

  // Save to persistent ledger
  const ledgerData = {
    timestamp: new Date().toISOString(),
    completedCount: completedTurns.length,
    maxTurns: MAX_TURNS,
    status: brokenReason ? "broke" : "unbroken",
    breakpoint: brokenReason,
    turns: completedTurns,
  };
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledgerData, null, 2));

  // Open the primary file in editor for visual review
  const mainFile = fs.existsSync(path.join(TARGET_DIR, "app.js"))
    ? path.join(TARGET_DIR, "app.js")
    : path.join(TARGET_DIR, "index.html");
  await cdp.eval(`(async () => {
    const { useStudioStore } = await import("/src/store/studioStore.ts");
    useStudioStore.getState().showFile("${mainFile}");
  })()`, true);
  await pause(1500);
  await cdp.captureScreenshot("final_endurance_state.png");

  cdp.close();

  if (brokenReason) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Endurance test runner fatal error:", err);
  process.exit(1);
});
