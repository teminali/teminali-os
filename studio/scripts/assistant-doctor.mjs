#!/usr/bin/env node
/**
 * Does the screen assistant actually work on this machine?
 *
 * Two of the four things it needs cannot be granted by any amount of code —
 * Screen Recording and Accessibility are System Settings switches that only a
 * person can flip — so the useful thing a diagnostic can do is say precisely
 * which one is missing, what is lost without it, and then prove the rest of the
 * path end to end on the screen as it is right now.
 *
 *   node scripts/assistant-doctor.mjs            check everything, describe nothing
 *   node scripts/assistant-doctor.mjs --describe also run the local vision pass
 *   node scripts/assistant-doctor.mjs --prompt   raise the Accessibility dialog
 */

import { createConfig } from "../server/config.js";
import { observe } from "../server/assistant.js";
import { pointerPermissions, pointerScreens } from "../server/pointer.js";
import { rankElements, describeElement } from "../src/services/assistant/elements.ts";
import { buildPointerHelper } from "./build-pointer-helper.mjs";

const describe = process.argv.includes("--describe");
const prompt = process.argv.includes("--prompt");

const tick = (ok) => (ok ? "  ok  " : " fail ");
const out = (line = "") => process.stdout.write(`${line}\n`);

out();
out("Teminali screen assistant — diagnostic");
out("─".repeat(72));

/* 1. The helper. */
const built = await buildPointerHelper();
out(`[${tick(built.built)}] pointer helper`);
if (!built.built) {
  out(`         ${built.reason}`);
  out();
  process.exit(1);
}

/* 2. The two permissions, named individually — they lose different things. */
const permissions = await pointerPermissions({ prompt });
out(`[${tick(permissions.screenRecordingGranted)}] Screen Recording`);
if (!permissions.screenRecordingGranted) {
  out("         Without it the assistant cannot see the screen at all.");
  out("         System Settings › Privacy & Security › Screen Recording");
}
out(`[${tick(permissions.accessibilityTrusted)}] Accessibility`);
if (!permissions.accessibilityTrusted) {
  out("         Without it the assistant can describe the screen but cannot");
  out("         point at or click anything on it — the element inventory is empty.");
  out("         System Settings › Privacy & Security › Accessibility");
  out("         Re-run with --prompt to raise the system dialog.");
}

/* 3. Displays. */
const screens = await pointerScreens();
out(`[${tick(screens.length > 0)}] displays: ${screens.map((s) => `${s.width}×${s.height} @${s.scale}×`).join(", ") || "none"}`);

/* 4. The whole look, on the screen as it is now. */
const startedAt = Date.now();
const observation = await observe(createConfig(), { describe });
const elapsed = Date.now() - startedAt;

out(`[${tick(Boolean(observation.frame))}] screen capture`);
out(`[${tick(observation.elements.length > 0)}] accessibility tree: ${observation.elements.length} elements from ${observation.application.name}`);
if (describe) {
  out(`[${tick(Boolean(observation.sceneDescription))}] local vision pass`);
}
out(`         one look took ${elapsed} ms${describe ? " including the description" : ""}`);
for (const limit of observation.limits) out(`         · ${limit}`);

if (observation.sceneDescription) {
  out();
  out("What the vision model saw (context only — never a source of positions):");
  out(`  ${observation.sceneDescription}`);
}

if (observation.elements.length > 0) {
  const ranked = rankElements(observation.elements, { windowFrame: observation.window?.frame, limit: 15 });
  out();
  out(`The inventory a model would be shown (top ${ranked.length} of ${observation.elements.length}, in reading order):`);
  for (const element of ranked) out(`  ${describeElement(element)}`);
  out();
  out("Every position above came from macOS, not from the picture. A plan names");
  out("one of these ids and the frame the OS reported is what gets clicked.");
}

out();
process.exit(observation.elements.length > 0 && observation.frame ? 0 : 1);
