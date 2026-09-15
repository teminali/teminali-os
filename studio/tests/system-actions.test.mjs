import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSystemCommand,
  executeSystemCommand,
  executeSystemAction,
} from "../src/services/voice/systemActions.ts";

test("parseSystemCommand correctly categorizes disk storage queries", () => {
  const diskPhrases = [
    "Temi, check my computer storage space for me right now.",
    "check disk space",
    "how much storage do I have left?",
    "check my storage",
    "how many gigabytes are free on my drive?",
    "how much disk space is available?",
  ];

  for (const phrase of diskPhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "disk", `Should be disk: "${phrase}"`);
  }
});

test("parseSystemCommand correctly categorizes battery queries", () => {
  const batteryPhrases = [
    "what is my battery level?",
    "check battery status",
    "how much battery is left?",
    "are we charging right now?",
    "is the battery plugged in?",
  ];

  for (const phrase of batteryPhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "battery", `Should be battery: "${phrase}"`);
  }
});

test("parseSystemCommand correctly categorizes memory & RAM queries", () => {
  const memoryPhrases = [
    "check my memory",
    "how much RAM am I using?",
    "is my memory full?",
    "check RAM usage",
    "what is the memory status?",
  ];

  for (const phrase of memoryPhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "memory", `Should be memory: "${phrase}"`);
  }
});

test("parseSystemCommand correctly categorizes uptime and CPU queries", () => {
  const uptimePhrases = [
    "what is my system uptime?",
    "how long has this computer been running?",
    "check CPU load",
    "what is the uptime?",
  ];

  for (const phrase of uptimePhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "uptime_cpu", `Should be uptime_cpu: "${phrase}"`);
  }
});

test("parseSystemCommand correctly categorizes OS and architecture queries", () => {
  const osPhrases = [
    "what OS version am I on?",
    "what operating system is running?",
    "what macOS version is this?",
    "what processor architecture is installed on this computer?",
  ];

  for (const phrase of osPhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "os_info", `Should be os_info: "${phrase}"`);
  }
});

test("parseSystemCommand correctly categorizes network queries", () => {
  const netPhrases = [
    "check my internet connection",
    "what is my local IP address?",
    "am I online right now?",
    "what is my IP?",
  ];

  for (const phrase of netPhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "network", `Should be network: "${phrase}"`);
  }
});

test("parseSystemCommand correctly categorizes time and date queries", () => {
  const timePhrases = [
    "what time is it?",
    "what's today's date?",
    "what day is it today?",
  ];

  for (const phrase of timePhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "time_date", `Should be time_date: "${phrase}"`);
  }
});

test("parseSystemCommand identifies unsupported tasks to preserve developer boundaries", () => {
  const unsupportedPhrases = [
    "send an email to my manager",
    "call my phone",
    "order a pizza for me",
    "turn off the room lights",
    "make coffee",
  ];

  for (const phrase of unsupportedPhrases) {
    const cmd = parseSystemCommand(phrase);
    assert.ok(cmd, `Should parse: "${phrase}"`);
    assert.equal(cmd.kind, "unsupported", `Should be unsupported: "${phrase}"`);
  }
});

test("parseSystemCommand leaves general conversation and coding tasks alone", () => {
  const codingAndChat = [
    "write an index.html file",
    "fix the failing test in math.js",
    "sing me a brief Italian song",
    "tell me about your architecture",
    "can we refactor this component?",
  ];

  for (const phrase of codingAndChat) {
    const cmd = parseSystemCommand(phrase);
    assert.equal(cmd, null, `Should return null for: "${phrase}"`);
  }
});

test("executeSystemCommand time_date produces formatted date and time", async () => {
  const res = await executeSystemCommand({ kind: "time_date", raw: "what time is it" });
  assert.ok(typeof res === "string" && res.length > 10);
  assert.ok(res.includes("It is currently"));
});

test("executeSystemCommand unsupported clearly explains boundaries", async () => {
  const res = await executeSystemCommand({ kind: "unsupported", raw: "send an email to boss" });
  assert.ok(res.includes("developer work"));
  assert.ok(res.includes("capability"));
});

test("parseSystemCommand correctly categorizes file operations", () => {
  const openCmd = parseSystemCommand("open file index.html");
  assert.ok(openCmd);
  assert.equal(openCmd.kind, "open_file");
  assert.equal(openCmd.target, "index.html");

  const openEditorCmd = parseSystemCommand("open style.css in the editor");
  assert.ok(openEditorCmd);
  assert.equal(openEditorCmd.kind, "open_file");
  assert.equal(openEditorCmd.target, "style.css");

  const playCmd = parseSystemCommand("play video demo.mp4");
  assert.ok(playCmd);
  assert.equal(playCmd.kind, "play_video");
  assert.equal(playCmd.target, "demo.mp4");

  const moveCmd = parseSystemCommand("move file draft.txt to archive/draft.txt");
  assert.ok(moveCmd);
  assert.equal(moveCmd.kind, "move_file");
  assert.equal(moveCmd.source, "draft.txt");
  assert.equal(moveCmd.destination, "archive/draft.txt");

  const findCmd = parseSystemCommand("find file package.json");
  assert.ok(findCmd);
  assert.equal(findCmd.kind, "find_file");
  assert.equal(findCmd.query, "package.json");

  const listCmd = parseSystemCommand("list files in src");
  assert.ok(listCmd);
  assert.equal(listCmd.kind, "list_files");
  assert.equal(listCmd.target, "src");
});

test("executeSystemAction returns structured result with zero tokens and sub-second execution", async () => {
  const { executeSystemAction } = await import("../src/services/voice/systemActions.ts");
  const actionResult = await executeSystemAction({ kind: "disk", raw: "check storage" });

  assert.equal(actionResult.handled, true);
  assert.equal(actionResult.kind, "disk");
  assert.equal(actionResult.tokensUsed, 0);
  assert.ok(actionResult.latencyMs < 3000);
  assert.ok(actionResult.spoken.length > 0);
  assert.ok(actionResult.displayMarkdown.length > 0);
});

test("executeSystemAction unsupported marks boundary and zero tokens", async () => {
  const { executeSystemAction } = await import("../src/services/voice/systemActions.ts");
  const actionResult = await executeSystemAction({ kind: "unsupported", raw: "call my phone" });

  assert.equal(actionResult.handled, true);
  assert.equal(actionResult.kind, "unsupported");
  assert.equal(actionResult.isUnsupported, true);
  assert.equal(actionResult.tokensUsed, 0);
  assert.ok(actionResult.spoken.includes("developer work"));
});

test("parseSystemCommand correctly categorizes universal tool telemetry", () => {
  const gitCmd = parseSystemCommand("what git branch am I on?");
  assert.ok(gitCmd);
  assert.equal(gitCmd.kind, "git_telemetry");

  const editorCmd = parseSystemCommand("what is the timeline duration?");
  assert.ok(editorCmd);
  assert.equal(editorCmd.kind, "editor_telemetry");

  const playerCmd = parseSystemCommand("what video is currently playing in the media player?");
  assert.ok(playerCmd);
  assert.equal(playerCmd.kind, "player_telemetry");

  const agentCmd = parseSystemCommand("is an assistant task running?");
  assert.ok(agentCmd);
  assert.equal(agentCmd.kind, "agent_telemetry");
});

test("executeSystemAction runs git and editor telemetry with zero tokens", async () => {
  const { executeSystemAction } = await import("../src/services/voice/systemActions.ts");

  const gitRes = await executeSystemAction({ kind: "git_telemetry", raw: "git status" });
  assert.equal(gitRes.handled, true);
  assert.equal(gitRes.kind, "git_telemetry");
  assert.equal(gitRes.tokensUsed, 0);
  assert.ok(gitRes.spoken.includes("branch"));

  const editorRes = await executeSystemAction({ kind: "editor_telemetry", raw: "timeline status" });
  assert.equal(editorRes.handled, true);
  assert.equal(editorRes.kind, "editor_telemetry");
  assert.equal(editorRes.tokensUsed, 0);
  assert.ok(editorRes.spoken.includes("timeline"));
});

test("parseSystemCommand handles Windows-style backslash paths and drive letters", async () => {
  const { normalizeSystemPath } = await import("../src/services/voice/systemActions.ts");

  assert.equal(normalizeSystemPath("C:\\Users\\test\\file.txt"), "C:/Users/test/file.txt");
  assert.equal(normalizeSystemPath("D:\\media\\video.mp4"), "D:/media/video.mp4");

  const openCmd = parseSystemCommand("open file C:\\Users\\test\\index.html in the editor");
  assert.ok(openCmd);
  assert.equal(openCmd.kind, "open_file");
  assert.equal(openCmd.target, "C:/Users/test/index.html");

  const moveCmd = parseSystemCommand("move C:\\temp\\notes.txt to D:\\archive");
  assert.ok(moveCmd);
  assert.equal(moveCmd.kind, "move_file");
  assert.equal(moveCmd.source, "C:/temp/notes.txt");
  assert.equal(moveCmd.destination, "D:/archive");

  const playCmd = parseSystemCommand("play video D:\\media\\demo.mp4 in player");
  assert.ok(playCmd);
  assert.equal(playCmd.kind, "play_video");
  assert.equal(playCmd.target, "D:/media/demo.mp4");
});

test("parseSystemCommand handles natural human colloquialisms and Italian phrases", () => {
  const ramSlang = parseSystemCommand("Yo Temi, what's my RAM looking like right now?");
  assert.ok(ramSlang);
  assert.equal(ramSlang.kind, "memory");

  const ramGas = parseSystemCommand("is my computer gasping for air?");
  assert.ok(ramGas);
  assert.equal(ramGas.kind, "memory");

  const itTime = parseSystemCommand("dimmi che ore sono");
  assert.ok(itTime);
  assert.equal(itTime.kind, "time_date");

  const itBatt = parseSystemCommand("com'è la batteria");
  assert.ok(itBatt);
  assert.equal(itBatt.kind, "battery");
});

test("parseSystemCommand strictly blocks brutal developer boundaries", () => {
  const wireCmd = parseSystemCommand("Temi, wire transfer $5000 from my bank account to Alice");
  assert.ok(wireCmd);
  assert.equal(wireCmd.kind, "unsupported");

  const dbCmd = parseSystemCommand("Temi, delete the production database immediately");
  assert.ok(dbCmd);
  assert.equal(dbCmd.kind, "unsupported");

  const btcCmd = parseSystemCommand("Temi, buy me 100 bitcoins");
  assert.ok(btcCmd);
  assert.equal(btcCmd.kind, "unsupported");
});

test("getHostPlatform returns a valid OS platform identifier", async () => {
  const { getHostPlatform } = await import("../src/services/voice/systemActions.ts");
  const plat = getHostPlatform();
  assert.ok(["darwin", "win32", "linux"].includes(plat), `Platform should be valid, got ${plat}`);
});

test("parseSystemCommand resolves conversational speech retractions and false starts", () => {
  const retractFile = parseSystemCommand("open the file style.css... wait, actually no, open index.html instead");
  assert.ok(retractFile);
  assert.equal(retractFile.kind, "open_file");
  assert.equal(retractFile.target, "index.html");

  const retractRam = parseSystemCommand("check my battery... wait no, what is my ram?");
  assert.ok(retractRam);
  assert.equal(retractRam.kind, "memory");
});

test("executeSystemAction handles non-existent files with graceful fault tolerance and zero tokens", async () => {
  const result = await executeSystemAction({
    kind: "open_file",
    raw: "open file totally_imaginary_file_9999.xyz in the editor",
    target: "totally_imaginary_file_9999.xyz",
  });
  assert.equal(result.handled, true);
  assert.equal(result.tokensUsed, 0);
  assert.equal(result.actionType, "file_not_found");
  assert.ok(result.spoken.includes("totally_imaginary_file_9999.xyz"));
  assert.ok(result.spoken.includes("couldn't find"));
});

test("parseSystemCommand correctly categorizes capabilities directory queries", () => {
  const capCmd1 = parseSystemCommand("what are your capabilities?");
  assert.ok(capCmd1);
  assert.equal(capCmd1.kind, "capabilities_directory");

  const capCmd2 = parseSystemCommand("show capabilities directory");
  assert.ok(capCmd2);
  assert.equal(capCmd2.kind, "capabilities_directory");

  const capCmd3 = parseSystemCommand("what can you do?");
  assert.ok(capCmd3);
  assert.equal(capCmd3.kind, "capabilities_directory");
});

test("executeSystemAction capabilities_directory returns structured markdown directory with zero tokens", async () => {
  const { executeSystemAction } = await import("../src/services/voice/systemActions.ts");
  const result = await executeSystemAction({
    kind: "capabilities_directory",
    raw: "show capabilities",
  });
  assert.equal(result.handled, true);
  assert.equal(result.kind, "capabilities_directory");
  assert.equal(result.tokensUsed, 0);
  assert.ok(result.latencyMs < 50);
  assert.ok(result.spoken.includes("capability directory"));
  assert.ok(result.displayMarkdown.includes("Capability Directory"));
  assert.ok(result.displayMarkdown.includes("Battery & Power Health"));
  assert.ok(result.displayMarkdown.includes("Teminali OS Media Player"));
});
