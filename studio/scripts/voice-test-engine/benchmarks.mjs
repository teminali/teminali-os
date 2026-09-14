/**
 * Teminali OS Voice Test Engine — Acoustic Analysis & Benchmark Scoring
 *
 * Computes acoustic metrics, latency scores, and dialogue integrity ratings.
 * Generates standardized JSON benchmark reports.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Calculates benchmark scores for a single live voice test turn.
 * @param {object} params
 */
export function calculateTurnScores({ audioPayload, timings, evalState, expectedKeywords = [] }) {
  const duration = audioPayload?.durationSeconds || 0;
  const isVoiced = audioPayload?.isVoiced || false;
  const rmsDbfs = audioPayload?.rmsDbfs ?? -100;
  const totalTurnMs = timings?.totalTurnDurationMs || 0;
  const isDoubleMessage = evalState?.isDoubleMessage || false;
  const transcript = (audioPayload?.transcript || evalState?.answerLines?.join(" ") || "").toLowerCase();

  // 1. Acoustic Quality Score (0 - 100)
  let acousticScore = 0;
  if (isVoiced) acousticScore += 40;
  if (duration >= 1.0) acousticScore += 30;
  else if (duration >= 0.4) acousticScore += 15;
  if (rmsDbfs > -45 && rmsDbfs < -6) acousticScore += 30;
  else if (rmsDbfs > -60) acousticScore += 15;

  // 2. Latency Score (0 - 100)
  const isDelegation = Boolean(timings?.narrationLatencyMs) || transcript.includes("look") || transcript.includes("check");
  let latencyScore = 100;
  if (isDelegation) {
    // Tool delegation turns involve background tool execution; optimal is < 30s
    if (totalTurnMs > 35000) {
      latencyScore = 0;
    } else if (totalTurnMs > 12000) {
      latencyScore = Math.max(60, Math.round(100 - (totalTurnMs - 12000) / 400));
    }
  } else {
    // Direct conversational turns should answer within 4-6s
    if (totalTurnMs > 5000) {
      latencyScore = Math.max(20, Math.min(100, Math.round(100 - (totalTurnMs - 5000) / 100)));
    }
  }

  // 3. Dialogue Integrity Score (0 - 100)
  let integrityScore = 100;
  if (isDoubleMessage) {
    integrityScore = 0; // Absolute zero tolerance for double messages
  } else {
    // Check keyword relevance if expected keywords provided
    if (expectedKeywords.length > 0) {
      const matchCount = expectedKeywords.filter((kw) => transcript.includes(kw.toLowerCase())).length;
      if (matchCount === 0 && transcript.length > 0 && !isDelegation) {
        integrityScore = Math.max(40, integrityScore - 30);
      }
    }
  }

  // Composite Overall Score (Weighted: 40% Integrity, 30% Acoustic, 30% Latency)
  const overallScore = Math.round(integrityScore * 0.4 + acousticScore * 0.3 + latencyScore * 0.3);
  const passed = overallScore >= 70 && !isDoubleMessage && (audioPayload?.totalSamples || 0) > 0;

  return {
    overallScore,
    acousticScore,
    latencyScore,
    integrityScore,
    passed,
  };
}

/**
 * Generates a full benchmark report object and saves it to disk.
 */
export function createBenchmarkReport({
  query,
  mode,
  audioPayload,
  timings,
  evalState,
  scores,
  wavPath,
  outputDir,
}) {
  const report = {
    timestamp: new Date().toISOString(),
    query,
    mode,
    overallScore: scores.overallScore,
    passed: scores.passed,
    scores: {
      acousticScore: scores.acousticScore,
      latencyScore: scores.latencyScore,
      integrityScore: scores.integrityScore,
    },
    audioMetrics: {
      sampleRate: audioPayload?.sampleRate || 48000,
      totalSamples: audioPayload?.totalSamples || 0,
      durationSeconds: audioPayload?.durationSeconds || 0,
      chunkCount: audioPayload?.chunkCount || 0,
      peakAmplitude: audioPayload?.peakAmplitude || 0,
      avgRms: audioPayload?.avgRms || 0,
      rmsDbfs: audioPayload?.rmsDbfs || -100,
      isVoiced: audioPayload?.isVoiced || false,
      latencyToFirstAudioMs: audioPayload?.latencyToFirstAudioMs || null,
      wavSaved: Boolean(wavPath && fs.existsSync(wavPath)),
      wavPath: wavPath || null,
    },
    timings: {
      narrationLatencyMs: timings?.narrationLatencyMs || null,
      totalTurnDurationMs: timings?.totalTurnDurationMs || 0,
    },
    dialogue: {
      transcript: audioPayload?.transcript || evalState?.answerLines?.join(" | ") || "",
      isDoubleMessage: evalState?.isDoubleMessage || false,
      recentLines: evalState?.recentLines || [],
    },
  };

  const reportPath = path.join(outputDir, "live_voice_benchmark_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return { report, reportPath };
}

/**
 * Prints a clean terminal summary of the benchmark results.
 */
export function printBenchmarkSummary(report, reportPath) {
  const { overallScore, passed, scores, audioMetrics, timings, dialogue } = report;

  console.log("\n=======================================================");
  console.log(`  LIVE VOICE BENCHMARK ENGINE RESULTS — ${passed ? "PASSED ✓" : "FAILED ✗"}`);
  console.log("=======================================================");
  console.log(`  Overall Engine Score    : ${overallScore}/100`);
  console.log(`  Acoustic Quality Score  : ${scores.acousticScore}/100 (RMS: ${audioMetrics.rmsDbfs} dBFS, Voiced: ${audioMetrics.isVoiced ? "YES" : "NO"})`);
  console.log(`  Dialogue Integrity Score: ${scores.integrityScore}/100 (Double message: ${dialogue.isDoubleMessage ? "DETECTED" : "NONE"})`);
  console.log(`  Turn Latency Score      : ${scores.latencyScore}/100 (Total Turn Time: ${timings.totalTurnDurationMs}ms)`);
  if (timings.narrationLatencyMs) {
    console.log(`  Progress Narration      : +${timings.narrationLatencyMs}ms ("Checking computer storage...")`);
  }
  console.log(`  Captured Voice Audio    : ${audioMetrics.durationSeconds}s (${audioMetrics.totalSamples} samples at ${audioMetrics.sampleRate}Hz)`);
  if (audioMetrics.wavSaved && audioMetrics.wavPath) {
    console.log(`  Saved 48kHz RIFF WAV    : ${audioMetrics.wavPath}`);
  }
  console.log(`  Spoken Response         : "${dialogue.transcript}"`);
  console.log(`  Benchmark Report JSON   : ${reportPath}`);
  console.log("=======================================================\n");
}
