import fs from 'node:fs';
import path from 'node:path';
import { ROOT, LIMIT_NS, readJson, requireContestant, workspaceIntegrity } from './lib.mjs';

export function eligibility(contestant) {
  requireContestant(contestant);
  const configFile = path.join(ROOT, 'state', 'run-config.json');
  const clockFile = path.join(ROOT, 'state', 'clocks', `${contestant}.json`);
  const config = fs.existsSync(configFile) ? readJson(configFile) : null;
  const side = contestant === 'frontier-auto-1' ? config?.frontier : config?.codex;
  const required = contestant === 'frontier-auto-1'
    ? ['shippedRevision', 'permissions', 'tools']
    : ['visibleModelBuild', 'reasoningEffort', 'serviceTier', 'permissions', 'tools'];
  const identityComplete = Boolean(side) && required.every((key) => side[key] !== null && side[key] !== '' && (!Array.isArray(side[key]) || side[key].length > 0));
  const clock = fs.existsSync(clockFile) ? readJson(clockFile) : null;
  const clockClosed = Boolean(clock?.startMonotonicNs && clock?.stopMonotonicNs && clock?.elapsedNs);
  const withinLimit = clockClosed && BigInt(clock.elapsedNs) <= LIMIT_NS;
  const nodeMatches = Boolean(config?.runtime?.node) && config.runtime.node === process.version;
  const integrity = workspaceIntegrity(contestant);
  const gates = { identityComplete, clockClosed, withinLimit, nodeMatches, workspaceIntegrity: integrity.ok };
  return { eligible: Object.values(gates).every(Boolean), gates, integrity, clock, contestant };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const contestant = requireContestant(process.argv[2]);
  const result = eligibility(contestant);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.eligible ? 0 : 2;
}
