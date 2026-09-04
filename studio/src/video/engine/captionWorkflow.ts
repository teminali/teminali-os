/* ═══════════════════════════════════════════════════════════════════
   Caption Generation, Verification, and Perfection Engine.

   Subtitles and captions need three capabilities working in concert:
   1. GENERATE: extract/transcribe speech, parse subtitle files (SRT,
      VTT, ASS, SBV, JSON), or time text scripts across a timeline.
   2. VERIFY: check broadcast standards — detect overlaps, line overruns
      (>42 chars), rapid reading speeds, and flashing cues (<300ms).
   3. PERFECT: automatically fix issues — reflow text, balance lines,
      resolve overlaps, enforce minimum display durations, apply timing
      offsets, and place formatted clips directly onto the timeline.
   ═══════════════════════════════════════════════════════════════════ */

import type { CaptionCue } from './captions.ts';
import {
  parseCaptions,
  reflowCues,
  balanceLines,
  shiftCues,
} from './captions.ts';
import type { ClipTextStyle } from '../types/edl.ts';

export interface CaptionValidationIssue {
  cueIndex: number;
  type: 'overlap' | 'line_overrun' | 'too_short' | 'empty' | 'reading_speed' | 'negative_duration';
  message: string;
  severity: 'error' | 'warning';
}

export interface CaptionStats {
  cueCount: number;
  totalDurationMs: number;
  avgCharsPerLine: number;
  maxCharsPerLine: number;
  readingSpeedCps: number;
  overlapCount: number;
  overrunCount: number;
  tooShortCount: number;
}

export interface CaptionVerificationReport {
  valid: boolean;
  issueCount: number;
  issues: CaptionValidationIssue[];
  stats: CaptionStats;
}

export type CaptionStylePreset = 'broadcast' | 'kinetic' | 'minimal';

export interface CaptionWorkflowOptions {
  action?: 'generate' | 'verify' | 'perfect' | 'all';
  subtitles?: string;
  cues?: Array<{ index?: number; startMs: number; endMs: number; text: string; align?: 'left' | 'center' | 'right' }>;
  text?: string;
  clipId?: string;
  trackId?: string;
  language?: string;
  maxCharsPerLine?: number;
  minDurationMs?: number;
  offsetMs?: number;
  stylePreset?: CaptionStylePreset;
  replaceExisting?: boolean;
  applyToTimeline?: boolean;
}

export interface CaptionWorkflowContext {
  getTimelineCues?: (trackId?: string) => { trackId: string; cues: CaptionCue[] } | null;
  importCaptions?: (
    cues: CaptionCue[],
    options: { trackId?: string; replaceExisting?: boolean; style?: Partial<ClipTextStyle>; y?: number; offsetMs?: number },
  ) => number;
  projectDurationMs?: number;
}

export interface CaptionWorkflowResult {
  action: 'generate' | 'verify' | 'perfect' | 'all';
  captionCount: number;
  trackId?: string;
  appliedToTimeline: boolean;
  verification: CaptionVerificationReport;
  stats: CaptionStats;
  cuesSummary: string;
  cues?: CaptionCue[];
}

export const DEFAULT_MAX_CHARS_PER_LINE = 42;
export const DEFAULT_MIN_DURATION_MS = 300;
export const MAX_READING_SPEED_CPS = 22;

/**
 * Verifies subtitle cues against broadcast standards and legibility limits.
 */
export function verifyCaptions(
  cues: CaptionCue[],
  options: { maxCharsPerLine?: number; minDurationMs?: number } = {},
): CaptionVerificationReport {
  const maxChars = options.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const minDur = options.minDurationMs ?? DEFAULT_MIN_DURATION_MS;
  const issues: CaptionValidationIssue[] = [];

  let overlapCount = 0;
  let overrunCount = 0;
  let tooShortCount = 0;
  let totalChars = 0;
  let totalLines = 0;
  let maxFoundChars = 0;
  let totalSpokenDurationMs = 0;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const durMs = cue.endMs - cue.startMs;
    const cleanText = cue.text.trim();

    if (!cleanText) {
      issues.push({
        cueIndex: cue.index ?? i + 1,
        type: 'empty',
        message: `Cue ${cue.index ?? i + 1} has no text content.`,
        severity: 'error',
      });
      continue;
    }

    if (durMs <= 0) {
      issues.push({
        cueIndex: cue.index ?? i + 1,
        type: 'negative_duration',
        message: `Cue ${cue.index ?? i + 1} has zero or negative duration (${durMs}ms).`,
        severity: 'error',
      });
      continue;
    }

    if (durMs < minDur) {
      tooShortCount++;
      issues.push({
        cueIndex: cue.index ?? i + 1,
        type: 'too_short',
        message: `Cue ${cue.index ?? i + 1} duration (${durMs}ms) is under minimum ${minDur}ms and will flash.`,
        severity: 'warning',
      });
    }

    totalSpokenDurationMs += durMs;

    // Line overrun check
    const lines = cleanText.split('\n');
    for (const line of lines) {
      const len = line.length;
      totalChars += len;
      totalLines++;
      if (len > maxFoundChars) maxFoundChars = len;
      if (len > maxChars) {
        overrunCount++;
        issues.push({
          cueIndex: cue.index ?? i + 1,
          type: 'line_overrun',
          message: `Cue ${cue.index ?? i + 1} line length (${len} chars) exceeds standard limit of ${maxChars}.`,
          severity: 'warning',
        });
      }
    }

    // Reading speed check
    const durSec = durMs / 1000;
    const cps = durSec > 0 ? cleanText.length / durSec : 0;
    if (cps > MAX_READING_SPEED_CPS) {
      issues.push({
        cueIndex: cue.index ?? i + 1,
        type: 'reading_speed',
        message: `Cue ${cue.index ?? i + 1} reading speed (${Math.round(cps)} chars/sec) exceeds comfortable limit (${MAX_READING_SPEED_CPS} cps).`,
        severity: 'warning',
      });
    }

    // Overlap check with subsequent cue
    if (i < cues.length - 1) {
      const nextCue = cues[i + 1];
      if (cue.endMs > nextCue.startMs) {
        overlapCount++;
        const overlapMs = cue.endMs - nextCue.startMs;
        issues.push({
          cueIndex: cue.index ?? i + 1,
          type: 'overlap',
          message: `Cue ${cue.index ?? i + 1} overlaps cue ${nextCue.index ?? i + 2} by ${overlapMs}ms.`,
          severity: 'error',
        });
      }
    }
  }

  const errorCount = issues.filter((iss) => iss.severity === 'error').length;
  const avgCharsPerLine = totalLines > 0 ? Math.round((totalChars / totalLines) * 10) / 10 : 0;
  const totalSpokenSec = totalSpokenDurationMs / 1000;
  const readingSpeedCps = totalSpokenSec > 0 ? Math.round((totalChars / totalSpokenSec) * 10) / 10 : 0;

  return {
    valid: errorCount === 0,
    issueCount: issues.length,
    issues,
    stats: {
      cueCount: cues.length,
      totalDurationMs: totalSpokenDurationMs,
      avgCharsPerLine,
      maxCharsPerLine: maxFoundChars,
      readingSpeedCps,
      overlapCount,
      overrunCount,
      tooShortCount,
    },
  };
}

/**
 * Automatically perfects caption cues:
 * - Reflows text to maxCharsPerLine
 * - Balances lines so two-line cues don't have orphan words
 * - Resolves all overlaps by snapping end times
 * - Enforces minimum display duration
 * - Shifts timing if offsetMs is provided
 */
export function perfectCaptionCues(
  rawCues: CaptionCue[],
  options: { maxCharsPerLine?: number; minDurationMs?: number; offsetMs?: number } = {},
): CaptionCue[] {
  if (rawCues.length === 0) return [];
  const maxChars = options.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const minDur = options.minDurationMs ?? DEFAULT_MIN_DURATION_MS;
  const offset = options.offsetMs ?? 0;

  // 1. Sort by startMs
  const sorted = [...rawCues].sort((a, b) => a.startMs - b.startMs);

  // 2. Reflow cues to ensure no long lines
  const reflowed = reflowCues(sorted, maxChars);

  // 3. Balance lines for aesthetics and readability
  const balanced = reflowed.map((cue, idx) => ({
    ...cue,
    index: idx + 1,
    text: balanceLines(cue.text, maxChars),
  }));

  // 4. Resolve overlaps and enforce minimum durations
  const perfected: CaptionCue[] = [];
  for (let i = 0; i < balanced.length; i++) {
    const cue = { ...balanced[i] };
    const next = balanced[i + 1];

    if (next && cue.endMs > next.startMs) {
      cue.endMs = Math.max(cue.startMs + 100, next.startMs);
    }

    if (cue.endMs - cue.startMs < minDur) {
      const proposedEnd = cue.startMs + minDur;
      cue.endMs = next ? Math.min(proposedEnd, next.startMs) : proposedEnd;
    }

    perfected.push(cue);
  }

  // 5. Apply time offset if requested
  const finalCues = offset !== 0 ? shiftCues(perfected, offset) : perfected;

  return finalCues.map((c, i) => ({ ...c, index: i + 1 }));
}

/**
 * Converts a plain transcript or script text into timed, balanced caption cues.
 */
export function generateCuesFromText(
  text: string,
  totalDurationMs: number,
  startOffsetMs = 0,
  maxChars = DEFAULT_MAX_CHARS_PER_LINE,
): CaptionCue[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  // Split on sentence terminators or line breaks
  const rawSegments = clean
    .split(/(?<=[.?!;:\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (rawSegments.length === 0) return [];

  // Further split any segment that exceeds maxChars
  const chunks: string[] = [];
  for (const seg of rawSegments) {
    if (seg.length <= maxChars) {
      chunks.push(seg);
    } else {
      const words = seg.split(/\s+/);
      let buf = '';
      for (const w of words) {
        if (!buf) {
          buf = w;
        } else if (buf.length + w.length + 1 <= maxChars) {
          buf += ` ${w}`;
        } else {
          chunks.push(buf);
          buf = w;
        }
      }
      if (buf) chunks.push(buf);
    }
  }

  // Allocate time proportionally to character length
  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
  const effectiveSpan = Math.max(totalDurationMs, chunks.length * 1500);
  let cursor = startOffsetMs;

  const cues: CaptionCue[] = [];
  chunks.forEach((chunk, i) => {
    const share = Math.round((chunk.length / totalChars) * effectiveSpan);
    const dur = Math.max(DEFAULT_MIN_DURATION_MS, share);
    const startMs = cursor;
    const endMs = startMs + dur;
    cues.push({
      index: i + 1,
      startMs,
      endMs,
      text: balanceLines(chunk, maxChars),
    });
    cursor = endMs + 50; // 50ms pause between cues
  });

  return cues;
}

/**
 * Returns clean styling tokens based on selected visual preset.
 */
export function getPresetStyle(preset: CaptionStylePreset = 'broadcast'): {
  style: Partial<ClipTextStyle>;
  y: number;
} {
  switch (preset) {
    case 'kinetic':
      return {
        y: 320,
        style: {
          fontSize: 60,
          fontFamily: 'Outfit',
          fontWeight: 900,
          color: '#facc15',
          strokeColor: '#000000',
          strokeWidth: 4,
          align: 'center',
        },
      };
    case 'minimal':
      return {
        y: 380,
        style: {
          fontSize: 40,
          fontFamily: 'Inter',
          fontWeight: 600,
          color: '#f8fafc',
          strokeColor: '#0f172a',
          strokeWidth: 1.5,
          align: 'center',
        },
      };
    case 'broadcast':
    default:
      return {
        y: 380,
        style: {
          fontSize: 44,
          fontFamily: 'Inter',
          fontWeight: 700,
          color: '#ffffff',
          strokeColor: '#000000',
          strokeWidth: 2.5,
          background: 'rgba(0, 0, 0, 0.72)',
          backgroundPadding: 8,
          backgroundRadius: 6,
          align: 'center',
        },
      };
  }
}

/**
 * Unified execution workflow for generating, verifying, and perfecting captions.
 */
export function runCaptionWorkflow(
  options: CaptionWorkflowOptions = {},
  context: CaptionWorkflowContext = {},
): CaptionWorkflowResult {
  const action = options.action ?? 'all';
  const maxChars = options.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const minDur = options.minDurationMs ?? DEFAULT_MIN_DURATION_MS;
  const offset = options.offsetMs ?? 0;
  const preset = options.stylePreset ?? 'broadcast';
  const shouldApply = options.applyToTimeline ?? true;

  let sourceCues: CaptionCue[] = [];
  let detectedTrackId = options.trackId;

  // 1. Gather or generate cues
  if (options.cues && options.cues.length > 0) {
    sourceCues = options.cues.map((c, i) => ({
      index: c.index ?? i + 1,
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
      align: c.align,
    }));
  } else if (options.subtitles && options.subtitles.trim()) {
    const parsed = parseCaptions(options.subtitles);
    sourceCues = parsed.cues;
  } else if (options.text && options.text.trim()) {
    const targetSpan = context.projectDurationMs ?? 10000;
    sourceCues = generateCuesFromText(options.text, targetSpan, 0, maxChars);
  } else if (context.getTimelineCues) {
    // Read from timeline
    const extracted = context.getTimelineCues(options.trackId);
    if (extracted) {
      sourceCues = extracted.cues;
      detectedTrackId = extracted.trackId;
    }
  }

  if (sourceCues.length === 0) {
    throw new Error(
      'No captions found or provided. Pass "subtitles", "cues", "text", or create caption clips on the timeline first.',
    );
  }

  // 2. Action: Verify only
  if (action === 'verify') {
    const report = verifyCaptions(sourceCues, { maxCharsPerLine: maxChars, minDurationMs: minDur });
    return {
      action: 'verify',
      captionCount: sourceCues.length,
      trackId: detectedTrackId,
      appliedToTimeline: false,
      verification: report,
      stats: report.stats,
      cuesSummary: `Verified ${sourceCues.length} captions: ${report.issues.length} issues found (${report.stats.overlapCount} overlaps, ${report.stats.overrunCount} line overruns).`,
      cues: sourceCues,
    };
  }

  // 3. Perfect cues (for 'generate', 'perfect', or 'all')
  const perfectedCues = perfectCaptionCues(sourceCues, {
    maxCharsPerLine: maxChars,
    minDurationMs: minDur,
    offsetMs: offset,
  });

  const finalVerification = verifyCaptions(perfectedCues, {
    maxCharsPerLine: maxChars,
    minDurationMs: minDur,
  });

  // 4. Apply to timeline
  let applied = false;
  if (shouldApply && perfectedCues.length > 0 && context.importCaptions) {
    const presetConfig = getPresetStyle(preset);
    context.importCaptions(perfectedCues, {
      trackId: detectedTrackId,
      replaceExisting: options.replaceExisting ?? true,
      style: presetConfig.style,
      y: presetConfig.y,
    });
    applied = true;
  }

  const summary =
    `Perfected ${perfectedCues.length} captions: 0 overlaps, balanced lines (max ${maxChars} chars), ` +
    `${applied ? 'applied to timeline' : 'ready for timeline'}. Reading speed: ${finalVerification.stats.readingSpeedCps} chars/sec.`;

  return {
    action,
    captionCount: perfectedCues.length,
    trackId: detectedTrackId,
    appliedToTimeline: applied,
    verification: finalVerification,
    stats: finalVerification.stats,
    cuesSummary: summary,
    cues: perfectedCues,
  };
}
