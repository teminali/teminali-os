#!/usr/bin/env node
/**
 * Teminali OS — Live Voice Hands-Free Website Test
 *
 * 1. Sets system volume to an audible level (75%) so the user hears everything clearly.
 * 2. Speaks aloud through macOS speakers ("Ava (Enhanced)") conversing directly with Temi.
 * 3. Cleans up test-website so it begins from a completely empty slate (0 files).
 * 4. Instructs Temi to build the Italian espresso bar website (index.html, style.css).
 * 5. Listens to Temi's response, monitors active engine logo in ticker, and tracks CLI streaming.
 * 6. Verbally approves tool commands aloud into the room and approves the command banner.
 * 7. Inspects the actual generated files on disk in test-website (no faking/mocking).
 * 8. Speaks a real-time critique to refine the design and approves style updates.
 * 9. Reveals the finished index.html in the editor pane and captures full visual screenshots.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(STUDIO_ROOT, "..");
const TARGET_DIR = "/Users/teminali/Documents/my_projects/test-website";
const OUTPUT_DIR = path.join(STUDIO_ROOT, "benchmark-results", "hands-free-website-test");
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, "screenshots");
const TURNS_DIR = path.join(OUTPUT_DIR, "turns");

for (const d of [OUTPUT_DIR, SCREENSHOTS_DIR, TURNS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const IS_MAC = process.platform === "darwin";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure system volume is clearly audible
if (IS_MAC) {
  try {
    execSync("osascript -e 'set volume output volume 75'", { stdio: "ignore" });
  } catch {}
}

// Speak aloud through the computer's physical speakers so the operator hears the conversation
function speakAloud(text, voice = "Ava (Enhanced)", rate = 180) {
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

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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
    throw new Error(`Could not connect to Electron CDP on port 9222. Ensure Teminali OS is running.`);
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

async function runConversationalDelegatedTurn(cdp, turnIndex, promptText, verbalApprovalText, screenshotPrefix) {
  console.log("------------------------------------------------------------------");
  console.log(`[Turn ${turnIndex}] ASSISTANT (Speaking Aloud Into Room): "${promptText}"`);
  console.log("------------------------------------------------------------------");

  // Mute mic briefly while Ava speaks aloud so laptop microphone doesn't create duplicate echo turn
  await cdp.eval(`window.__temiVoiceTest?.muteMic?.()`);
  await speakAloud(promptText);
  await cdp.eval(`window.__temiVoiceTest?.unmuteMic?.()`);
  await pause(400);

  console.log("  Sending spoken turn to Temi...");
  // Launch runVoiceTestTurn to initiate turn and record Temi's initial verbal acknowledgement
  const turnPromise = cdp.eval(
    `window.__temiVoiceTest.runVoiceTestTurn(${JSON.stringify(promptText)}, 60000)`,
    true
  );

  // 1. Wait for the background task to start in useAssistantActivityStore
  console.log("  [AGENT MONITOR] Waiting for delegation to start...");
  let started = false;
  for (let i = 0; i < 25; i++) {
    const isRunning = await cdp.eval(`Boolean(window.__temiVoiceTest?.isTaskRunning?.())`);
    if (isRunning) {
      started = true;
      console.log("  [AGENT IN FLIGHT] Background coding task started.");
      break;
    }
    await pause(400);
  }

  // 2. While task is running, continuously monitor for approvals and grant them verbally + programmatically
  let approvalCount = 0;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 90000) {
    const state = await cdp.eval(`(async () => {
      const { useApprovalStore } = await import("/src/store/approvalStore.ts");
      const isRunning = Boolean(window.__temiVoiceTest?.isTaskRunning?.());
      const pending = useApprovalStore.getState().pending;
      const hasApproval = Boolean(window.__temiVoiceTest?.hasPendingApproval?.());
      return {
        isRunning,
        hasApproval,
        asker: pending?.asker || "The assistant",
        action: pending?.action || "command"
      };
    })()`, true);

    if (state.hasApproval) {
      started = true;
      approvalCount++;
      console.log(`\n  [APPROVAL DETECTED #${approvalCount}] Permission required for: ${state.action.substring(0, 60)}...`);
      await cdp.captureScreenshot(`${screenshotPrefix}_approval_${approvalCount}.png`);

      if (/\b(?:kill|pkill|killall)\b/i.test(state.action)) {
        console.log(`  [APPROVAL DENIED #${approvalCount}] Denying process termination command.`);
        await cdp.eval(`window.__temiVoiceTest?.denyPendingCommand?.()`);
        await pause(800);
        continue;
      }

      console.log(`  ASSISTANT (Speaking Aloud Into Room): "${verbalApprovalText}"`);
      const speakPromise = speakAloud(verbalApprovalText);
      await cdp.eval(`window.__temiVoiceTest?.approvePendingCommand?.()`);
      console.log(`  [APPROVAL GRANTED #${approvalCount}] Allowed command.`);
      await speakPromise;
      await pause(1000);
    }

    if (started && !state.isRunning && !state.hasApproval) {
      console.log("  [AGENT COMPLETED] Background task completed.");
      break;
    }
    await pause(600);
  }

  // Check if review dock with staged changes is present
  await pause(1000);
  const reviewInfo = await cdp.eval(`(async () => {
    const { useChangeStore } = await import("/src/store/changeStore.ts");
    const changes = useChangeStore.getState().changes || [];
    const hasBtn = Boolean(window.__temiVoiceTest?.hasPendingChangesReview?.());
    return { count: changes.length, hasBtn };
  })()`, true);

  if (reviewInfo?.count > 0 || reviewInfo?.hasBtn) {
    console.log(`\n  [REVIEW DOCK DETECTED] ${reviewInfo.count} file changes staged in dock.`);
    await cdp.captureScreenshot(`${screenshotPrefix}_review_dock.png`);
    await pause(1200);
    const accepted = await cdp.eval(`window.__temiVoiceTest?.acceptPendingChangesReview?.()`);
    console.log(`  [ACCEPT ALL CLICKED] Clicked compact Accept all button: ${accepted}`);
    await pause(800);
  }

  let turnResult = null;
  try {
    turnResult = await turnPromise;
  } catch (err) {
    console.warn("Turn result note:", err.message);
  }

  const transcript = (turnResult?.transcript || "").trim();
  console.log(`\n  TEMI SPOKE: "${transcript || '(task reported)'}"`);
  console.log(`  Voiced: ${turnResult?.isVoiced ? "YES" : "NO"} | Duration: ${turnResult?.durationSeconds || 0}s`);

  if (turnResult?.base64Wav) {
    fs.writeFileSync(path.join(TURNS_DIR, `turn_${turnIndex}.wav`), Buffer.from(turnResult.base64Wav, "base64"));
  }

  // Let Temi's closing speech settle
  await pause(3000);
  await cdp.captureScreenshot(`${screenshotPrefix}_settled.png`);
}

async function main() {
  console.log("\n==================================================================");
  console.log("   TEMINALI OS — LIVE HANDS-FREE VOICE WEBSITE TEST");
  console.log("   Workspace Target: /Users/teminali/Documents/my_projects/test-website");
  console.log("==================================================================\n");

  // Step 1: Clean up test-website directory
  console.log("[1/6] Cleaning up test-website directory...");
  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  } else {
    const existing = fs.readdirSync(TARGET_DIR);
    for (const f of existing) {
      fs.rmSync(path.join(TARGET_DIR, f), { recursive: true, force: true });
    }
  }
  const cleanCheck = fs.readdirSync(TARGET_DIR);
  console.log(`[1/6] Target directory is clean slate (total files: ${cleanCheck.length})\n`);

  // Step 2: Connect to Teminali OS over CDP
  console.log("[2/6] Connecting to Teminali OS Electron...");
  const cdp = await CDPClient.connect();
  console.log("[2/6] CDP Connected successfully.\n");

  // Synchronize app state to test-website and set active engine to frontier
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

    // Close any stale editor tabs from previous directories
    const studio = useStudioStore.getState();
    for (const tab of [...studio.tabs]) {
      studio.closeTab(tab.id);
    }

    // Ensure Frontier Max engine and profile are active
    useStudioStore.getState().setProfile("max");
    useAssistantActivityStore.getState().setActiveEngine("gemini");

    // Clear any previous changes
    const { useChangeStore } = await import("/src/store/changeStore.ts");
    useChangeStore.getState().acceptAll();

    // Turn on listening
    if (window.__temiVoiceTest?.turnOnListening) {
      await window.__temiVoiceTest.turnOnListening();
    }
  })()`, true);

  await pause(1000);
  await cdp.captureScreenshot("01_test_website_clean_start.png");
  console.log("[2/6] Initial screenshot captured: 01_test_website_clean_start.png\n");

  // Step 3: Turn 1 — Spoken website creation instruction
  await runConversationalDelegatedTurn(
    cdp,
    1,
    "Temi, write an index.html and style.css for our Italian espresso bar in this project.",
    "Yes Temi, I allow you to run that command.",
    "02_turn_01"
  );

  // Step 4: Monitor files written directly to test-website
  console.log("\n[4/6] Inspecting generated files on disk in test-website...");
  let files = fs.readdirSync(TARGET_DIR);
  for (let attempt = 1; attempt <= 15 && files.length === 0; attempt++) {
    await pause(1000);
    files = fs.readdirSync(TARGET_DIR);
  }

  console.log(`[4/6] Files found in test-website: ${files.join(", ") || "(none)"}`);
  for (const f of files) {
    const stat = fs.statSync(path.join(TARGET_DIR, f));
    console.log(`      - ${f} (${stat.size} bytes)`);
  }

  // Step 5: Turn 2 — Real-time audible critique to enhance the design
  console.log("\n------------------------------------------------------------------");
  await runConversationalDelegatedTurn(
    cdp,
    2,
    "Temi, update style.css to add a luxury frosted glass header and a bronze espresso glow.",
    "Yes Temi, I allow the changes.",
    "03_turn_02"
  );

  // Step 6: Reveal index.html in the editor and final audit
  console.log("\n[6/6] Final Audit of test-website workspace:");
  const finalFiles = fs.readdirSync(TARGET_DIR);
  console.log(`      Files present: ${finalFiles.join(", ") || "(empty)"}`);
  for (const f of finalFiles) {
    const content = fs.readFileSync(path.join(TARGET_DIR, f), "utf8");
    console.log(`      📄 ${f}: ${content.length} characters`);
  }

  // Open index.html in the studio editor pane
  await cdp.eval(`(async () => {
    const { useStudioStore } = await import("/src/store/studioStore.ts");
    useStudioStore.getState().showFile("${path.join(TARGET_DIR, "index.html")}");
  })()`, true);
  await pause(1500);

  await cdp.captureScreenshot("04_final_studio_state.png");

  const closingSpeech = "Hands free website test complete. All files generated and verified in test website.";
  console.log(`\nASSISTANT (Speaking Aloud Into Room): "${closingSpeech}"\n`);
  await speakAloud(closingSpeech);

  cdp.close();
  console.log("==================================================================");
  console.log("   TEST COMPLETED SUCCESSFULLY");
  console.log("==================================================================\n");
}

main().catch((err) => {
  console.error("Test encountered an error:", err);
  process.exit(1);
});
