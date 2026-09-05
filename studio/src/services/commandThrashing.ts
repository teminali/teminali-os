/**
 * Catching a run that is retrying its way around a wall.
 *
 * The failure this exists for: asked for the weather with no key configured,
 * the model called Weatherbit, got a 401, called Weatherstack, got a 401, then
 * called Weatherbit again — six turns of alternating between two vendors that
 * were both refusing for the same reason, because a 401 reads locally like
 * "this vendor is down" and the turn budget was the only thing that ever
 * stopped it.
 *
 * A 401 is not an outage. It is a statement about the request, and repeating
 * the request cannot change it.
 *
 * Deliberately free of runtime imports so it stays a pure, directly testable
 * unit: the only thing it borrows from `agentCommands` is a type, which is
 * erased before Node ever sees it.
 */

import type { CommandExecution } from "./agentCommands";

/** How many times a run may be told it is thrashing before it is left alone. */
export const MAX_THRASH_NOTICES = 2;

/**
 * A key that is not a key. A model that cannot find a credential will happily
 * invent one, and the endpoint answers 401 to `dummy` exactly as fast as it
 * would to a typo, so the run reads the refusal as "try the other vendor".
 */
const DUMMY_KEY = /(?:api[_-]?key|appid|app[_-]?id|access[_-]?key|token|secret|key)=(?:dummy|demo|test|sample|none|null|your[_-]?\w*|my[_-]?\w*|<[^>]*>|replace[^&\s]*|placeholder|example|changeme|xxx+|abc123|1234\d*)\b/i;

/** The shape of "your credential is the problem", across the vendors that say it differently. */
const AUTH_FAILURE = /\b(?:401|403|invalid[ _-]?(?:api[ _-]?)?key|unauthori[sz]ed|forbidden|missing[ _-]?(?:api[ _-]?)?key|api[ _-]?key[ _-]?(?:not|is|was)[ _-]?(?:valid|found|provided|supplied)|authentication[ _-]?failed|access[ _-]?denied|subscription[ _-]?(?:plan|key))\b/i;

/** Public data that answers without a credential, so a stuck run has somewhere to go. */
const KEYLESS_ROUTES: { subject: RegExp; advice: string }[] = [
  {
    subject: /weather|forecast|temperature|humidity|rain|hali ya hewa/i,
    advice: "`curl -s 'wttr.in/<place>?format=j1'` or `curl -s 'https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current_weather=true'` — both keyless.",
  },
  {
    subject: /price|crypto|bitcoin|ethereum|stock|ticker|exchange[ _-]?rate|forex/i,
    advice: "`https://api.coingecko.com/api/v3/simple/price?...`, `https://api.binance.com/api/v3/ticker/price?symbol=...` or `https://api.frankfurter.app/latest?from=...` — all keyless.",
  },
  {
    subject: /\bip\b|geolocat|timezone|country/i,
    advice: "`https://ipapi.co/json/`, `http://ip-api.com/json/` or `https://worldtimeapi.org/api/timezone/...` — all keyless.",
  },
];

/** The host a command talks to, or null when it does not talk to one. */
function commandHost(command: string): string | null {
  const match = command.match(/https?:\/\/([^\s/'"`$?]+)/i);
  return match ? match[1].toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "") : null;
}

/** A command that ran and did not work — a bad exit, or a body that says "not authorised". */
function executionFailed(execution: CommandExecution): boolean {
  if (!execution.executed) return false;
  if (execution.code !== null && execution.code !== 0) return true;
  return AUTH_FAILURE.test(execution.output);
}

export interface ThrashingVerdict {
  /** Why the next turn was held back, in the words the model is shown. */
  notice: string;
  /** Hosts already known to have failed this exchange. */
  failedHosts: string[];
}

/**
 * Catch a run that is retrying its way around a wall.
 *
 * The failure this exists for: asked for the weather with no key configured,
 * the model called Weatherbit, got a 401, called Weatherstack, got a 401,
 * called Weatherbit again — six turns of alternating between two vendors that
 * were both refusing for the same reason, because a 401 reads locally like
 * "this vendor is down" and the loop counter was the only thing that ever
 * stopped it.
 *
 * A 401 is not an outage. It is a statement about the request, and repeating
 * the request cannot change it. So the next turn is intercepted before it runs
 * whenever it goes back to a host that already refused, or carries a key that
 * is obviously a placeholder, and the model is told the root cause and where
 * to get the same data without a credential.
 *
 * `executions` is everything run so far this exchange; `nextTurnText` is the
 * model's newest message, whose fences have not run yet.
 */
export function detectCommandThrashing(
  executions: CommandExecution[],
  nextTurnText: string,
): ThrashingVerdict | null {
  const nextHosts = new Set<string>();
  for (const match of nextTurnText.matchAll(/https?:\/\/([^\s/'"`$?]+)/gi)) {
    nextHosts.add(match[1].toLowerCase().replace(/^www\./, "").replace(/:\d+$/, ""));
  }
  const nextUsesDummyKey = DUMMY_KEY.test(nextTurnText);
  if (nextHosts.size === 0 && !nextUsesDummyKey) return null;

  const failedHosts = new Set<string>();
  let authRefusals = 0;
  for (const execution of executions) {
    if (!executionFailed(execution)) continue;
    const host = commandHost(execution.command);
    if (host) failedHosts.add(host);
    if (AUTH_FAILURE.test(execution.output) || DUMMY_KEY.test(execution.command)) authRefusals += 1;
  }

  const repeated = [...nextHosts].filter((host) => failedHosts.has(host));
  // Alternating vendors is the same mistake wearing a different hostname: two
  // hosts have already refused and the next turn is reaching for a third.
  const pingPong = failedHosts.size >= 2 && authRefusals >= 2 && nextHosts.size > 0;

  if (repeated.length === 0 && !pingPong && !nextUsesDummyKey) return null;

  const cause = nextUsesDummyKey
    ? "the request carries a placeholder API key, which every provider will refuse"
    : repeated.length > 0
      ? `${repeated.join(", ")} already failed this exchange and the request has not changed`
      : `${[...failedHosts].join(", ")} have all refused for the same reason, so the next vendor will too`;

  const route = KEYLESS_ROUTES.find((entry) => entry.subject.test(nextTurnText));
  const pivot = route
    ? route.advice
    : "a public endpoint that needs no credential, or a local `python3`/`node` script computing it from data already on this machine.";

  return {
    failedHosts: [...failedHosts],
    notice: [
      "[ROOT-CAUSE DIAGNOSTIC NOTICE — this turn's commands were NOT run]",
      `Diagnosis: ${cause}.`,
      "An authentication refusal is a statement about the request, not an outage: retrying it, or swapping to another key-gated vendor, cannot change the answer.",
      "Do NOT invent, guess, or placeholder an API key, and do NOT try another commercial provider that needs one.",
      `Instead, get the same data from ${pivot}`,
      "State the root cause to the user in one sentence, then run the keyless alternative.",
    ].join("\n"),
  };
}
