/*
  The gateway's `/speak` relay against a fake sidecar: a streamed reply must
  reach the caller while the sidecar is still rendering, and a whole-file reply
  must keep its length.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { SPEECH_STREAM_TYPE, forgetVoiceStatus, speak } from "../server/voice.js";

function encodeFrame(header, body = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(json.length, 0);
  lengths.writeUInt32BE(body.length, 4);
  return Buffer.concat([lengths.subarray(0, 4), json, lengths.subarray(4), body]);
}

async function sidecar(handleSpeak) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tts: { model: "fake", voices: ["a"], streaming: true } }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    await handleSpeak(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = { voiceUrl: new URL(`http://127.0.0.1:${server.address().port}`), voiceTimeoutMs: 5000 };
  forgetVoiceStatus();
  return { server, config, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a streamed reply is relayed as it arrives, not buffered until the end", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = encodeFrame({ clause: "Hi,", start: 0, end: 3, sampleRate: 24_000, samples: 1 }, Buffer.from([0, 0]));
  const fake = await sidecar(async (response) => {
    response.writeHead(200, { "content-type": SPEECH_STREAM_TYPE });
    response.write(first);
    await held;
    response.end(encodeFrame({ done: true }));
  });
  try {
    const audio = await speak(fake.config, { text: "Hi, there", stream: true });
    assert.equal(audio.contentType, SPEECH_STREAM_TYPE);
    assert.ok(audio.stream, "a stream is handed back, not a buffer");
    assert.equal(audio.body, undefined);
    assert.equal(fake.requests[0].stream, true, "the flag reaches the sidecar");

    // The first clause is readable while the sidecar is still holding the rest.
    const received = [];
    audio.stream.on("data", (chunk) => received.push(chunk));
    await once(audio.stream, "data");
    assert.ok(Buffer.concat(received).length >= first.length);
    release();
    await once(audio.stream, "end");
    const all = Buffer.concat(received);
    // The last frame: a 13-byte header and a 4-byte zero body length.
    assert.equal(all.subarray(all.length - 17, all.length - 4).toString(), '{"done":true}');
  } finally {
    await fake.close();
  }
});

test("a whole-file reply is still buffered with its length", async () => {
  const wav = Buffer.from("RIFF....WAVE");
  const fake = await sidecar(async (response) => {
    response.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
    response.end(wav);
  });
  try {
    const audio = await speak(fake.config, { text: "Hi", stream: false });
    assert.equal(audio.contentType, "audio/wav");
    assert.equal(audio.stream, undefined);
    assert.deepEqual(audio.body, wav);
  } finally {
    await fake.close();
    forgetVoiceStatus();
  }
});
