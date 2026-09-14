import assert from "node:assert/strict";
import test from "node:test";

import {
  decomposeCompoundUtterance,
  executeActionChain,
  parseSingleAction,
} from "../src/services/voice/compoundActionRunner.ts";

test("parseSingleAction recognizes atomic system and editor actions", () => {
  const disk = parseSingleAction("check my computer storage space");
  assert.ok(disk);
  assert.equal(disk.type, "system");
  assert.equal(disk.command.kind, "disk");

  const battery = parseSingleAction("what is my battery level");
  assert.ok(battery);
  assert.equal(battery.type, "system");
  assert.equal(battery.command.kind, "battery");

  const git = parseSingleAction("what git branch am I on");
  assert.ok(git);
  assert.equal(git.type, "system");
  assert.equal(git.command.kind, "git_telemetry");

  const edit = parseSingleAction("cut at 5 seconds");
  assert.ok(edit);
  assert.equal(edit.type, "editor");
  assert.equal(edit.command.tool, "timeline_command");
  assert.equal(edit.command.args.command, "split");

  const nonAction = parseSingleAction("let's discuss the design of the universe");
  assert.equal(nonAction, null);
});

test("decomposeCompoundUtterance preserves protected phrases with 'and'", () => {
  const uptimeRam = decomposeCompoundUtterance("what is my system uptime and how much RAM am I using?");
  assert.ok(uptimeRam);
  assert.equal(uptimeRam.length, 1);
  assert.equal(uptimeRam[0].type, "system");
  assert.ok(
    uptimeRam[0].command.kind === "memory" || uptimeRam[0].command.kind === "uptime_cpu",
  );

  const osArch = decomposeCompoundUtterance("What operating system and processor architecture is this computer running?");
  assert.ok(osArch);
  assert.equal(osArch.length, 1);
  assert.equal(osArch[0].type, "system");
  assert.equal(osArch[0].command.kind, "os_info");

  const timeDate = decomposeCompoundUtterance("tell me the time and date");
  assert.ok(timeDate);
  assert.equal(timeDate.length, 1);
  assert.equal(timeDate[0].type, "system");
  assert.equal(timeDate[0].command.kind, "time_date");
});

test("decomposeCompoundUtterance decomposes multi-clause compound utterances", () => {
  const compound1 = decomposeCompoundUtterance("check my storage space and tell me battery status");
  assert.ok(compound1);
  assert.equal(compound1.length, 2);
  assert.equal(compound1[0].command.kind, "disk");
  assert.equal(compound1[1].command.kind, "battery");

  const compound2 = decomposeCompoundUtterance("check disk space then open index.html in the editor");
  assert.ok(compound2);
  assert.equal(compound2.length, 2);
  assert.equal(compound2[0].command.kind, "disk");
  assert.equal(compound2[1].command.kind, "open_file");

  const compound3 = decomposeCompoundUtterance("what git branch am I on and check system memory and also check battery");
  assert.ok(compound3);
  assert.equal(compound3.length, 3);
  assert.equal(compound3[0].command.kind, "git_telemetry");
  assert.equal(compound3[1].command.kind, "memory");
  assert.equal(compound3[2].command.kind, "battery");
});

test("executeActionChain runs compound actions with sub-100ms latency and 0 tokens", async () => {
  const chainResult = await executeActionChain("check storage space and check battery status");
  assert.ok(chainResult);
  assert.equal(chainResult.handled, true);
  assert.equal(chainResult.isCompound, true);
  assert.equal(chainResult.steps.length, 2);
  assert.equal(chainResult.tokensUsed, 0);
  assert.ok(chainResult.latencyMs < 3000);
  assert.ok(chainResult.spoken.toLowerCase().includes("storage") || chainResult.spoken.toLowerCase().includes("space"));
  assert.ok(chainResult.spoken.toLowerCase().includes("battery") || chainResult.spoken.toLowerCase().includes("power"));
  assert.ok(chainResult.displayMarkdown.includes("Disk Storage") || chainResult.displayMarkdown.includes("Storage Status"));
});

test("executeActionChain integrates with custom editor tool runner", async () => {
  let executedEditorTool = null;
  let executedEditorArgs = null;

  const chainResult = await executeActionChain("check my storage and cut at 5 seconds", {
    executeEditorTool: async (tool, args) => {
      executedEditorTool = tool;
      executedEditorArgs = args;
      return { success: true };
    },
  });

  assert.ok(chainResult);
  assert.equal(chainResult.handled, true);
  assert.equal(chainResult.isCompound, true);
  assert.equal(chainResult.steps.length, 2);
  assert.equal(executedEditorTool, "timeline_command");
  assert.equal(executedEditorArgs?.command, "split");
  assert.equal(executedEditorArgs?.ms, 5000);
  assert.equal(chainResult.tokensUsed, 0);
});

test("decomposeCompoundUtterance decomposes comma-separated triple compound utterances", () => {
  const triple = decomposeCompoundUtterance("check battery, check storage space, and tell me what operating system I'm running");
  assert.ok(triple);
  assert.equal(triple.length, 3);
  assert.equal(triple[0].command.kind, "battery");
  assert.equal(triple[1].command.kind, "disk");
  assert.equal(triple[2].command.kind, "os_info");
});

test("decomposeCompoundUtterance handles Italian vocatives and clause mixing", () => {
  const itCompound = decomposeCompoundUtterance("Temi bella, dimmi che ore sono and tell me if my battery is full");
  assert.ok(itCompound);
  assert.equal(itCompound.length, 2);
  assert.equal(itCompound[0].command.kind, "time_date");
  assert.equal(itCompound[1].command.kind, "battery");
});

test("executeActionChain resolves speech retractions and false starts with zero tokens", async () => {
  const result = await executeActionChain("Temi, open the file style.css... wait, actually no, open index.html instead");
  assert.ok(result);
  assert.equal(result.handled, true);
  assert.equal(result.tokensUsed, 0);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].kind, "open_file");
  assert.ok(result.spoken.includes("index.html"));
});

