import test from "node:test";
import assert from "node:assert/strict";
import { detectCommandThrashing } from "../src/services/commandThrashing.ts";

/** A command that ran and came back refusing the credential. */
const refused = (command, output = '{"error":"Invalid API key"}') => ({
  command,
  risk: "auto",
  executed: true,
  code: 0,
  output,
  truncated: false,
});

const succeeded = (command, output = '{"temp":24}') => ({
  command,
  risk: "auto",
  executed: true,
  code: 0,
  output,
  truncated: false,
});

test("a first call to a host that has never failed is left alone", () => {
  assert.equal(detectCommandThrashing([], "```frontier-run\ncurl -s https://api.weatherbit.io/v2.0/current\n```"), null);
});

test("a turn with no network call and no fake key is left alone", () => {
  const history = [refused("curl -s https://api.weatherbit.io/v2.0/current?key=abc")];
  assert.equal(detectCommandThrashing(history, "```frontier-run\nnpm test\n```"), null);
});

test("going back to a host that already refused is intercepted", () => {
  const history = [refused("curl -s 'https://api.weatherbit.io/v2.0/current?key=abc'")];
  const verdict = detectCommandThrashing(history, "```frontier-run\ncurl -s 'https://api.weatherbit.io/v2.0/current?key=abc'\n```");
  assert.ok(verdict, "the repeat must be caught");
  assert.match(verdict.notice, /were NOT run/);
  assert.match(verdict.notice, /api\.weatherbit\.io already failed/);
  assert.deepEqual(verdict.failedHosts, ["api.weatherbit.io"]);
});

test("alternating between two key-gated vendors is intercepted before the third", () => {
  const history = [
    refused("curl -s 'https://api.weatherbit.io/v2.0/current?key=abc'"),
    refused("curl -s 'http://api.weatherstack.com/current?access_key=abc'", "HTTP 401 Unauthorized"),
  ];
  const verdict = detectCommandThrashing(history, "```frontier-run\ncurl -s 'https://api.openweathermap.org/data/2.5/weather'\n```");
  assert.ok(verdict, "the ping-pong must be caught");
  assert.match(verdict.notice, /refused for the same reason/);
});

test("a placeholder credential is intercepted on its first use", () => {
  const verdict = detectCommandThrashing([], "```frontier-run\ncurl -s 'https://api.weatherbit.io/v2.0/current?key=dummy'\n```");
  assert.ok(verdict, "a fake key must be caught with no history at all");
  assert.match(verdict.notice, /placeholder API key/);
});

test("YOUR_KEY and appid=xxx are placeholders too", () => {
  assert.ok(detectCommandThrashing([], "curl 'https://x.test/a?api_key=YOUR_KEY'"));
  assert.ok(detectCommandThrashing([], "curl 'https://x.test/a?appid=xxxx'"));
});

test("the pivot named is the keyless route for the subject asked about", () => {
  const history = [refused("curl -s 'https://api.weatherbit.io/v2.0/current?key=abc'")];
  const weather = detectCommandThrashing(history, "let me get the weather again\n```frontier-run\ncurl -s 'https://api.weatherbit.io/v2.0/current?key=abc'\n```");
  assert.match(weather.notice, /wttr\.in/);
  assert.match(weather.notice, /open-meteo/);

  const priceHistory = [refused("curl -s 'https://pro-api.coinmarketcap.com/v1/quotes?CMC_PRO_API_KEY=abc'")];
  const price = detectCommandThrashing(priceHistory, "checking the bitcoin price\n```frontier-run\ncurl -s 'https://pro-api.coinmarketcap.com/v1/quotes?CMC_PRO_API_KEY=abc'\n```");
  assert.match(price.notice, /coingecko/);
});

test("a host that answered successfully may be called again", () => {
  const history = [succeeded("curl -s 'https://wttr.in/Dar+es+Salaam?format=j1'")];
  assert.equal(detectCommandThrashing(history, "```frontier-run\ncurl -s 'https://wttr.in/Nairobi?format=j1'\n```"), null);
});

test("a non-zero exit counts as a failure even when the body says nothing", () => {
  const history = [{ command: "curl -s https://api.down.test/v1", risk: "auto", executed: true, code: 7, output: "", truncated: false }];
  assert.ok(detectCommandThrashing(history, "```frontier-run\ncurl -s https://api.down.test/v1\n```"));
});

test("a command that never ran is not evidence of failure", () => {
  const history = [{ command: "curl -s https://api.weatherbit.io/v2.0/current", risk: "confirm", executed: false, code: null, output: "", truncated: false }];
  assert.equal(detectCommandThrashing(history, "```frontier-run\ncurl -s https://api.weatherbit.io/v2.0/current\n```"), null);
});
