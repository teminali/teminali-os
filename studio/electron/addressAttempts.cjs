/*
  How long Node gives each address of a host to connect before abandoning it
  for the next one.

  Electron 44 runs Node 24.19, whose default is 250 ms
  (net.getDefaultAutoSelectFamilyAttemptTimeout()). An abandoned attempt is not
  left racing the next, so the figure is a deadline for the whole TCP handshake.
  On the operator's network the IPv4 handshake took 296 to 381 ms over 80
  connects, and IPv6 had no route: every IPv6 attempt failed at once with
  EHOSTUNREACH. A host resolving to both families was then unreachable from any
  Electron process, because every IPv4 attempt was cut off and every IPv6
  attempt refused. Gemini's token mint threw "fetch failed" (AggregateError,
  ETIMEDOUT) after 2019 ms, while Node 26, whose default is 500 ms, had Google's
  403 back in 921 ms. api.github.com, which has no IPv6 record, connected from
  both, and that is what made this look like an IPv6 fault.

  dns.setDefaultResultOrder("ipv4first") was measured and does not help: the
  addresses already came back IPv4 first.

  The floor is 1000 ms rather than Node 26's 500 because a deadline shorter than
  the handshake does not slow a connection, it kills it, and 500 is only 1.3
  times the slowest handshake measured. The price, reasoned from Node's
  documented behaviour rather than measured, falls on a network whose first
  listed address drops packets without answering: each new connection waits
  the full deadline before trying the next address.
*/

const net = require("net");

const ATTEMPT_FLOOR_MS = 1000;

/** Raises this process's per-address deadline to the floor. Never lowers it. */
function raiseAddressAttemptBudget(netModule = net) {
  if (netModule.getDefaultAutoSelectFamilyAttemptTimeout() < ATTEMPT_FLOOR_MS) {
    netModule.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_FLOOR_MS);
  }
  return netModule.getDefaultAutoSelectFamilyAttemptTimeout();
}

/**
 * The same deadline for a child started from `process.execPath` with
 * ELECTRON_RUN_AS_NODE. That child is a fresh Node with the 250 ms default, and
 * the voice sidecar runs from extraResources, outside the asar, so it cannot
 * require this file itself.
 */
function addressAttemptArgs(netModule = net) {
  const deadline = Math.max(netModule.getDefaultAutoSelectFamilyAttemptTimeout(), ATTEMPT_FLOOR_MS);
  return [`--network-family-autoselection-attempt-timeout=${deadline}`];
}

module.exports = { ATTEMPT_FLOOR_MS, raiseAddressAttemptBudget, addressAttemptArgs };
