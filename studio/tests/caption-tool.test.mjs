import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  verifyCaptions,
  perfectCaptionCues,
  generateCuesFromText,
  runCaptionWorkflow,
} from '../src/video/engine/captionWorkflow.ts';

const registryPath = new URL('../src/video/mcp/toolRegistry.ts', import.meta.url);

test('verifyCaptions identifies overlaps, line overruns, and short durations', () => {
  const dirtyCues = [
    {
      index: 1,
      startMs: 0,
      endMs: 1500,
      text: 'This is a single line that is deliberately crafted to be far longer than forty two characters in length and therefore it should trigger an overrun warning.',
    },
    {
      index: 2,
      startMs: 1200, // Overlaps cue 1 by 300ms
      endMs: 1350,   // Duration is only 150ms (< 300ms minimum)
      text: 'Short flash',
    },
  ];

  const report = verifyCaptions(dirtyCues, { maxCharsPerLine: 42, minDurationMs: 300 });
  assert.equal(report.valid, false, 'Should be invalid due to overlap');
  assert.equal(report.stats.overlapCount, 1, 'Should detect 1 overlap');
  assert.equal(report.stats.overrunCount, 1, 'Should detect 1 line overrun');
  assert.equal(report.stats.tooShortCount, 1, 'Should detect 1 too-short cue');

  const overlapIssue = report.issues.find((i) => i.type === 'overlap');
  assert.ok(overlapIssue, 'Must contain overlap issue');
  assert.equal(overlapIssue.cueIndex, 1);
});

test('perfectCaptionCues resolves overlaps, reflows long lines, and balances text', () => {
  const rawCues = [
    {
      index: 1,
      startMs: 0,
      endMs: 3000,
      text: 'Super long line that exceeds standard forty two characters and needs immediate automatic reflow into balanced broadcast lines',
    },
    {
      index: 2,
      startMs: 2500, // Overlaps cue 1
      endMs: 4000,
      text: 'Second cue follows smoothly',
    },
  ];

  const perfected = perfectCaptionCues(rawCues, { maxCharsPerLine: 42, minDurationMs: 300 });
  assert.ok(perfected.length >= 2, 'Should have at least 2 cues after reflow');

  // Verify that the overlap is resolved
  for (let i = 0; i < perfected.length - 1; i++) {
    assert.ok(
      perfected[i].endMs <= perfected[i + 1].startMs,
      `Cue ${i + 1} endMs (${perfected[i].endMs}) must not exceed next startMs (${perfected[i + 1].startMs})`,
    );
  }

  // Verify that no line in any cue exceeds 42 characters
  for (const cue of perfected) {
    const lines = cue.text.split('\n');
    for (const line of lines) {
      assert.ok(line.length <= 42, `Line "${line}" (${line.length} chars) exceeds 42 chars`);
    }
  }
});

test('perfectCaptionCues applies offsetMs accurately', () => {
  const cues = [
    { index: 1, startMs: 1000, endMs: 2500, text: 'Hello' },
    { index: 2, startMs: 2600, endMs: 4000, text: 'World' },
  ];

  const shifted = perfectCaptionCues(cues, { offsetMs: 500 });
  assert.equal(shifted[0].startMs, 1500);
  assert.equal(shifted[0].endMs, 3000);
  assert.equal(shifted[1].startMs, 3100);
  assert.equal(shifted[1].endMs, 4500);
});

test('generateCuesFromText creates timed balanced cues from plain script', () => {
  const script =
    'Teminali OS is an autonomous AI studio. It builds websites, web applications, and edits videos live on the canvas. Everything is verified with automated tests.';
  const cues = generateCuesFromText(script, 15000, 0, 42);

  assert.ok(cues.length >= 3, 'Should produce at least 3 cues for the 3 sentences');
  for (let i = 0; i < cues.length - 1; i++) {
    assert.ok(cues[i].endMs <= cues[i + 1].startMs, 'Cues must not overlap');
    assert.ok(cues[i].endMs - cues[i].startMs >= 300, 'Each cue must satisfy min duration');
  }
});

test('runCaptionWorkflow parses subtitles and verifies them without mutating timeline when applyToTimeline is false', () => {
  const srt = `1
00:00:01,000 --> 00:00:03,500
First broadcast subtitle line

2
00:00:03,600 --> 00:00:06,000
Second subtitle line cleanly aligned
`;

  const result = runCaptionWorkflow({
    subtitles: srt,
    action: 'all',
    applyToTimeline: false,
  });

  assert.equal(result.captionCount, 2);
  assert.equal(result.appliedToTimeline, false);
  assert.equal(result.verification.valid, true);
  assert.equal(result.stats.overlapCount, 0);
  assert.ok(result.cuesSummary.includes('Perfected 2 captions'));
});

test('runCaptionWorkflow applies to timeline when importCaptions is supplied in context', () => {
  let importedCues = null;
  let importedOptions = null;

  const mockContext = {
    importCaptions: (cues, options) => {
      importedCues = cues;
      importedOptions = options;
      return cues.length;
    },
    projectDurationMs: 12000,
  };

  const result = runCaptionWorkflow(
    {
      text: 'First short sentence. Second short sentence.',
      action: 'perfect',
      stylePreset: 'kinetic',
    },
    mockContext,
  );

  assert.equal(result.appliedToTimeline, true);
  assert.ok(importedCues && importedCues.length >= 2);
  assert.equal(importedOptions.style.fontFamily, 'Outfit');
  assert.equal(importedOptions.style.color, '#facc15');
});

test('perfect_captions and generate_captions are declared, defined, and exposed in toolRegistry', async () => {
  const registry = await readFile(registryPath, 'utf8');

  // Verify tool definitions exist
  assert.match(registry, /name:\s*'perfect_captions'/);
  assert.match(registry, /name:\s*'generate_captions'/);

  // Verify exposed tools allowlist includes both
  const exposed = registry.match(/export const EXPOSED_TOOLS[\s\S]*?\];/)[0];
  assert.match(exposed, /'perfect_captions'/);
  assert.match(exposed, /'generate_captions'/);

  // Verify alias mapping
  assert.match(registry, /if \(name === 'verify_captions'\) return tools\.find\(\(t\) => t\.name === 'perfect_captions'\);/);

  // Verify handler wires runCaptionWorkflow and captionContext
  assert.match(registry, /runCaptionWorkflow\(args, captionContext\(\)\)/);
});
