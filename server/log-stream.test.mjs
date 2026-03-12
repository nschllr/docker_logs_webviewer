import test from "node:test";
import assert from "node:assert/strict";

import { createDockerLogDecoder, createLineEmitter } from "./log-stream.mjs";

function createFrame(streamCode, payload) {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamCode;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test("createDockerLogDecoder decodes multiplexed stdout and stderr frames", () => {
  const entries = [];
  const decoder = createDockerLogDecoder({
    tty: false,
    onFrame(stream, payload) {
      entries.push({ stream, payload });
    }
  });

  const frameA = createFrame(1, "2026-03-12T18:00:00Z hello\n");
  const frameB = createFrame(2, "2026-03-12T18:00:01Z warning\n");
  const combined = Buffer.concat([frameA, frameB]);

  decoder.write(combined.subarray(0, 15));
  decoder.write(combined.subarray(15));

  assert.deepEqual(entries, [
    { stream: "stdout", payload: "2026-03-12T18:00:00Z hello\n" },
    { stream: "stderr", payload: "2026-03-12T18:00:01Z warning\n" }
  ]);
});

test("createLineEmitter preserves per-stream partial lines and timestamps", () => {
  const entries = [];
  const emitter = createLineEmitter((entry) => {
    entries.push(entry);
  });

  emitter.push("stdout", "2026-03-12T18:00:00Z first");
  emitter.push("stdout", " line\n2026-03-12T18:00:01Z second\n");
  emitter.push("stderr", "2026-03-12T18:00:02Z error");
  emitter.flush();

  assert.deepEqual(entries, [
    {
      stream: "stdout",
      timestamp: "2026-03-12T18:00:00Z",
      message: "first line"
    },
    {
      stream: "stdout",
      timestamp: "2026-03-12T18:00:01Z",
      message: "second"
    },
    {
      stream: "stderr",
      timestamp: "2026-03-12T18:00:02Z",
      message: "error"
    }
  ]);
});
