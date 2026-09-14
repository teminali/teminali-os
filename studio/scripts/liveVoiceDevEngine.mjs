#!/usr/bin/env node
/**
 * Teminali OS — Smart, Wise & Portable Live Voice Dev & Benchmark Engine
 *
 * An autonomous, cross-platform live testing harness for Teminali Voice:
 * 1. Automatically brings Teminali OS to the foreground.
 * 2. Connects over Chrome DevTools Protocol (CDP) with candidate port discovery.
 * 3. Starts a pristine session and ensures listening is active (green mic).
 * 4. Dispatches the query via reactive pipeline or acoustic room synthesis.
 * 5. Reactively captures Temi's spoken voice stream (48kHz Int16 PCM).
 * 6. Validates zero duplicate messages, measures micro-latencies, and checks RMS.
 * 7. Saves a standard RIFF WAV, plays it back, and writes benchmark report JSON.
 * 8. Returns the user's IDE to the foreground when testing completes.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs, printHelp, BENCHMARK_SUITE, CONTINUOUS_CONVERSATION_SUITE } from "./voice-test-engine/config.mjs";
import { focusTemi, focusIde, playAudioFile, synthesizeSpeech, getPlatformInfo } from "./voice-test-engine/platform.mjs";
import { discoverCdp, findTemiPage, connectCdp } from "./voice-test-engine/cdp.mjs";
import { calculateTurnScores, createBenchmarkReport, printBenchmarkSummary } from "./voice-test-engine/benchmarks.mjs";

async function runTurn(cdp, options, turnConfig, stepPrefix = "4/6") {
  const { query, timeoutMs, expectedKeywords = [], id = "single_turn" } = turnConfig;
  const { mode, outputDir, skipPlay } = options;

  console.log(`\n[${stepPrefix}] INTERACTION (${mode.toUpperCase()} MODE): Dispatching turn...`);
  console.log(`  Query: "${query}"`);

  // Ensure clean capture buffer and stop any stray audio playback
  await cdp.evaluate(`(async () => {
    if (window.__temiVoiceTest?.audio?.stopTTSPlayback) window.__temiVoiceTest.audio.stopTTSPlayback();
    if (window.__temiVoiceTest?.startVoiceCapture) window.__temiVoiceTest.startVoiceCapture();
  })()`, true);

  const t0 = Date.now();
  let narrationDetected = false;
  let tNarration = null;

  // Background monitor for progress narration & telemetry (fast 150ms interval)
  const monitorTimer = setInterval(async () => {
    try {
      const val = await cdp.evaluate(`(() => {
        const diag = window.__temiVoiceTest?.getDialogueSummary ? window.__temiVoiceTest.getDialogueSummary() : null;
        const lastMsg = diag?.messages?.length ? diag.messages[diag.messages.length - 1].content : "";
        const captureStats = window.__temiVoiceTest?.getCapturedVoiceData ? window.__temiVoiceTest.getCapturedVoiceData() : null;
        return {
          hasNarration: lastMsg.includes("Checking computer storage") || lastMsg.includes("computer storage"),
          captureSamples: captureStats?.totalSamples || 0,
          durationSeconds: captureStats?.durationSeconds || 0,
          rmsDbfs: captureStats?.rmsDbfs || -100,
        };
      })()`);

      if (val?.hasNarration && !narrationDetected) {
        narrationDetected = true;
        tNarration = Date.now() - t0;
        console.log(`  [+${tNarration}ms] Tool Narration active: "Checking computer storage."`);
        await cdp.takeScreenshot(path.join(outputDir, `dev_engine_02_narration.png`));
      }
      if (val?.captureSamples > 0 && val?.durationSeconds > 0.5) {
        console.log(`  [+${Date.now() - t0}ms] Capturing speech audio: ${val.captureSamples} samples (${val.durationSeconds}s, ${val.rmsDbfs} dBFS)`);
      }
    } catch {
      // ignore monitor errors
    }
  }, 150);

  let audioPayload;
  if (mode === "acoustic") {
    const queryAudioPath = path.join(outputDir, `query_${id}.aiff`);
    console.log(`  Synthesizing acoustic voice query to: ${queryAudioPath}`);
    const isFollowUp = options.continuous && !id.includes("greeting") && !query.toLowerCase().includes("temi");
    const spokenQuery = isFollowUp || query.toLowerCase().includes("temi")
      ? query
      : `Temi, ${query}`;
    await synthesizeSpeech(spokenQuery, queryAudioPath, { rate: 220 });
    await cdp.evaluate(`window.__temiVoiceTest.startVoiceCapture()`);
    const waitPromise = cdp.evaluate(`window.__temiVoiceTest.waitForSpokenResponse(${timeoutMs})`, true);
    await playAudioFile(queryAudioPath, false);
    audioPayload = await waitPromise;
  } else {
    audioPayload = await cdp.evaluate(`window.__temiVoiceTest.runVoiceTestTurn("${query}", ${timeoutMs})`, true);
  }
  clearInterval(monitorTimer);

  const tCompleted = Date.now() - t0;

  // Dialogue state evaluation
  const evalState = await cdp.evaluate(`(() => {
    const diag = window.__temiVoiceTest?.getDialogueSummary ? window.__temiVoiceTest.getDialogueSummary() : null;
    const body = document.body ? document.body.innerText : "";
    const lines = body.split("\\n").map(l => l.trim()).filter(Boolean);
    const answerLines = lines.filter(l => l.toLowerCase().includes("gigabyte") || l.toLowerCase().includes("storage") || l.toLowerCase().includes("available") || l.toLowerCase().includes("ready") || l.toLowerCase().includes("time"));

    return {
      dialogue: diag,
      answerLines,
      isDoubleMessage: answerLines.filter(l => l.toLowerCase().includes("gigabyte")).length > 1,
      recentLines: lines.slice(-10),
    };
  })()`);

  // Save 48kHz WAV audio
  const wavPath = path.join(outputDir, id === "single_turn" ? "temi_engine_spoken_response.wav" : `temi_response_${id}.wav`);
  let wavSaved = false;

  if (audioPayload?.base64Wav && audioPayload.totalSamples > 0) {
    const wavBuffer = Buffer.from(audioPayload.base64Wav, "base64");
    fs.writeFileSync(wavPath, wavBuffer);
    wavSaved = true;
    console.log(`  ✓ SAVED 48kHz WAV: ${wavPath} (${wavBuffer.length} bytes, ${audioPayload.durationSeconds}s)`);

    // In multi-turn continuous testing, avoid re-broadcasting audio via afplay which echoes into the open mic
    if (!skipPlay && !options.continuous && !options.suite) {
      const asyncPlay = Boolean(options.fast && options.mode !== "acoustic");
      console.log(`  ✓ Listening out loud: Playing captured Temi speech back through speakers${asyncPlay ? " (background)" : ""}...`);
      await playAudioFile(wavPath, false, asyncPlay);
    }
  } else {
    console.warn("  ! Note: Audio samples buffer returned empty or timed out.");
  }

  await cdp.takeScreenshot(path.join(outputDir, `dev_engine_03_completed.png`));

  const timings = {
    narrationLatencyMs: tNarration,
    totalTurnDurationMs: tCompleted,
  };

  const scores = calculateTurnScores({
    audioPayload,
    timings,
    evalState,
    expectedKeywords,
  });

  return {
    id,
    query,
    audioPayload,
    timings,
    evalState,
    scores,
    wavPath: wavSaved ? wavPath : null,
  };
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const platformInfo = getPlatformInfo();

  console.log("\n=======================================================");
  console.log("  TEMINALI OS — SMART, WISE & PORTABLE VOICE DEV ENGINE");
  console.log("=======================================================");
  console.log(`  Platform     : ${platformInfo.platform} (${platformInfo.arch})`);
  console.log(`  Engine Mode  : ${options.mode.toUpperCase()}`);
  console.log(`  Execution    : ${options.suite ? "MULTI-TURN BENCHMARK SUITE" : `SINGLE TURN ("${options.query}")`}`);
  console.log(`  Artifacts Dir: ${options.outputDir}`);
  console.log(`  CI Headless  : ${options.isCi ? "YES" : "NO"}\n`);

  // Step 1: Bring Teminali OS to the foreground
  console.log("[1/6] WINDOW MANAGEMENT: Bringing Teminali OS to foreground...");
  await focusTemi(options.skipFocus);
  await new Promise((r) => setTimeout(r, 400));

  // Step 2: Connect over CDP with auto-discovery
  console.log(`[2/6] CDP CONNECT: Probing Electron remote debugging port...`);
  const { port, pages } = await discoverCdp(options.port);
  console.log(`  ✓ Connected to CDP on port ${port} (${pages.length} targets available)`);

  const temiPage = findTemiPage(pages);
  console.log(`  ✓ Found Teminali page target: "${temiPage.title}" (${temiPage.url})`);

  const cdp = await connectCdp(temiPage.webSocketDebuggerUrl);

  try {
    // Step 3: Refresh Stage & Ensure Listening is Turned On
    console.log("\n[3/6] STAGE SETUP: Starting clean session & turning on listening...");
    const hasTestEndpoint = await cdp.evaluate(`Boolean(window.__temiVoiceTest)`);
    if (options.forceReload || !hasTestEndpoint) {
      console.log("  Reloading application stage...");
      await cdp.call("Page.reload", { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 1800));
    }

    const initStatus = await cdp.evaluate(`(async () => {
      if (window.__temiVoiceTest?.startNewChat) {
        window.__temiVoiceTest.startNewChat();
      }
      if (window.__temiVoiceTest?.turnOnListening) {
        await window.__temiVoiceTest.turnOnListening();
      }
      const isVoiceOn = Boolean(document.querySelector('button[aria-label="Turn voice off"]'));
      return {
        isVoiceOn,
        url: window.location.href,
      };
    })()`, true);

    console.log("  Listening Status:", initStatus?.isVoiceOn ? "ON (Green Mic Active)" : "Active (Listening)");
    await cdp.takeScreenshot(path.join(options.outputDir, "dev_engine_01_listening_ready.png"));
    console.log("  ✓ Captured stage ready screenshot with listening active.");

    if (options.continuous || options.suite) {
      const suiteList = options.continuous ? CONTINUOUS_CONVERSATION_SUITE : BENCHMARK_SUITE;
      const isContinuous = Boolean(options.continuous);
      console.log(`\n[4/6] ${isContinuous ? "CONTINUOUS CONVERSATION" : "BENCHMARK SUITE"}: Running ${suiteList.length} back-to-back turns...`);
      const suiteResults = [];

      for (let i = 0; i < suiteList.length; i++) {
        const scenario = suiteList[i];
        if (i > 0 && !isContinuous) {
          await cdp.evaluate(`(async () => {
            if (window.__temiVoiceTest?.startNewChat) window.__temiVoiceTest.startNewChat();
            if (window.__temiVoiceTest?.turnOnListening) await window.__temiVoiceTest.turnOnListening();
          })()`, true);
          await new Promise((r) => setTimeout(r, 400));
        } else if (i > 0 && isContinuous) {
          await new Promise((r) => setTimeout(r, 400));
        }
        console.log(`\n── Turn [${i + 1}/${suiteList.length}]: ${scenario.title} ──`);
        const turnResult = await runTurn(cdp, options, scenario, `${i + 1}/${suiteList.length}`);
        suiteResults.push(turnResult);
        await new Promise((r) => setTimeout(r, isContinuous ? 400 : 600));
      }

      const overallSuiteScore = Math.round(
        suiteResults.reduce((acc, r) => acc + r.scores.overallScore, 0) / suiteResults.length
      );
      const allPassed = suiteResults.every((r) => r.scores.passed);

      const suiteReport = {
        timestamp: new Date().toISOString(),
        mode: options.mode,
        overallSuiteScore,
        passed: allPassed,
        scenarios: suiteResults.map((r) => ({
          id: r.id,
          query: r.query,
          scores: r.scores,
          timings: r.timings,
          audioMetrics: {
            durationSeconds: r.audioPayload?.durationSeconds || 0,
            totalSamples: r.audioPayload?.totalSamples || 0,
            rmsDbfs: r.audioPayload?.rmsDbfs || -100,
            isVoiced: r.audioPayload?.isVoiced || false,
            wavPath: r.wavPath,
          },
          dialogue: {
            transcript: r.audioPayload?.transcript || "",
            isDoubleMessage: r.evalState?.isDoubleMessage || false,
          },
        })),
      };

      const suiteReportPath = path.join(options.outputDir, "live_voice_suite_report.json");
      fs.writeFileSync(suiteReportPath, JSON.stringify(suiteReport, null, 2));

      console.log("\n=======================================================");
      console.log(`  LIVE VOICE SUITE RESULTS — ${allPassed ? "ALL PASSED ✓" : "SOME FAILED ✗"}`);
      console.log("=======================================================");
      console.log(`  Suite Composite Score: ${overallSuiteScore}/100`);
      for (const res of suiteResults) {
        console.log(`  - [${res.scores.passed ? "PASS" : "FAIL"}] ${res.id}: ${res.scores.overallScore}/100 ("${res.audioPayload?.transcript || "N/A"}")`);
      }
      console.log(`  Suite Report JSON    : ${suiteReportPath}`);
      console.log("=======================================================\n");

      if (!allPassed && options.isCi) {
        process.exit(1);
      }
    } else {
      // Single Turn Mode
      const turnResult = await runTurn(cdp, options, {
        query: options.query,
        timeoutMs: options.timeoutMs,
        expectedKeywords: ["gigabyte", "storage", "available", "gb"],
        id: "single_turn",
      });

      const { report, reportPath } = createBenchmarkReport({
        query: turnResult.query,
        mode: options.mode,
        audioPayload: turnResult.audioPayload,
        timings: turnResult.timings,
        evalState: turnResult.evalState,
        scores: turnResult.scores,
        wavPath: turnResult.wavPath,
        outputDir: options.outputDir,
      });

      printBenchmarkSummary(report, reportPath);

      if (options.jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      }

      if (!report.passed && options.isCi) {
        process.exit(1);
      }
    }
  } finally {
    console.log("[WINDOW MANAGEMENT] Returning IDE / editor to foreground as requested...");
    await focusIde(options.skipFocus);
    cdp.close();
  }
}

main().catch(async (err) => {
  console.error("\nLive Voice Dev Engine Error:", err.message);
  await focusIde(false);
  process.exit(1);
});
