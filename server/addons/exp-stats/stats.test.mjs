import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectRunResults, computeStats } from "./index.mjs";

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-stats-test-"));
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeResult(runId, data) {
  const dir = path.join(tmpDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(data));
}

function test(name, fn) {
  setup();
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  } finally {
    teardown();
  }
}

console.log("exp-stats unit tests\n");

test("collectRunResults reads single results", () => {
  writeResult("run-1", {
    bug_id: "123",
    model_id: "claude",
    verification: { ok: true },
  });
  writeResult("run-2", {
    bug_id: "123",
    model_id: "claude",
    verification: { ok: false, reason: "not found" },
  });

  const results = collectRunResults(tmpDir);
  assert.equal(results.length, 2);
  assert.equal(results[0].bug_id, "123");
});

test("collectRunResults expands batch results", () => {
  writeResult("batch-1", {
    runs: [
      { bug_id: "456", model_id: "gemini", run_id: "b1-r1", verification: { ok: true } },
      { bug_id: "456", model_id: "gemini", run_id: "b1-r2", verification: { ok: false } },
    ],
  });

  const results = collectRunResults(tmpDir);
  assert.equal(results.length, 2);
  assert.equal(results[0].run_id, "b1-r1");
});

test("collectRunResults deduplicates batch and individual entries", () => {
  // Batch contains run_id "batch-r1" and "batch-r2"
  writeResult("batch-1", {
    runs: [
      { bug_id: "X", model_id: "m1", run_id: "batch-1-r1", verification: { ok: true } },
      { bug_id: "X", model_id: "m2", run_id: "batch-1-r2", verification: { ok: false } },
    ],
  });
  // Individual run directory duplicates one of the batch entries
  writeResult("batch-1-r1", {
    bug_id: "X", model_id: "m1", run_id: "batch-1-r1", verification: { ok: true },
  });
  writeResult("batch-1-r2", {
    bug_id: "X", model_id: "m2", run_id: "batch-1-r2", verification: { ok: false },
  });

  const results = collectRunResults(tmpDir);
  assert.equal(results.length, 2);
  const ids = results.map((r) => r.run_id).sort();
  assert.deepEqual(ids, ["batch-1-r1", "batch-1-r2"]);
});

test("collectRunResults skips empty and malformed files", () => {
  const dir1 = path.join(tmpDir, "empty");
  fs.mkdirSync(dir1);
  fs.writeFileSync(path.join(dir1, "result.json"), "");

  const dir2 = path.join(tmpDir, "bad-json");
  fs.mkdirSync(dir2);
  fs.writeFileSync(path.join(dir2, "result.json"), "{not json");

  const dir3 = path.join(tmpDir, "no-bug");
  fs.mkdirSync(dir3);
  fs.writeFileSync(path.join(dir3, "result.json"), JSON.stringify({ random: true }));

  const results = collectRunResults(tmpDir);
  assert.equal(results.length, 0);
});

test("collectRunResults returns empty for missing directory", () => {
  const results = collectRunResults("/nonexistent/path");
  assert.equal(results.length, 0);
});

test("computeStats groups and classifies correctly", () => {
  const results = [
    { bug_id: "A", model_id: "m1", verification: { ok: true } },
    { bug_id: "A", model_id: "m1", verification: { ok: false, partial: { prefix_bytes_matched: 5, suffix_bytes_matched: 0 } } },
    { bug_id: "A", model_id: "m1", verification: { ok: false, reason: "not found" } },
    { bug_id: "B", model_id: "m1", verification: { ok: false, partial: { prefix_bytes_matched: 0, suffix_bytes_matched: 3 } } },
  ];

  const stats = computeStats(results);
  assert.equal(stats.length, 2);

  const rowA = stats.find((r) => r.bug_id === "A");
  assert.equal(rowA.runs, 3);
  assert.equal(rowA.solved, 1);
  assert.equal(rowA.partial, 1);
  assert.equal(rowA.failed, 1);
  assert.equal(rowA.best_prefix, 32); // solved sets to 32
  assert.equal(rowA.best_suffix, 32);

  const rowB = stats.find((r) => r.bug_id === "B");
  assert.equal(rowB.runs, 1);
  assert.equal(rowB.solved, 0);
  assert.equal(rowB.partial, 1);
  assert.equal(rowB.failed, 0);
  assert.equal(rowB.best_suffix, 3);
});

test("computeStats filters by bug_id", () => {
  const results = [
    { bug_id: "A", model_id: "m1", verification: { ok: true } },
    { bug_id: "B", model_id: "m1", verification: { ok: false } },
  ];

  const stats = computeStats(results, { bugId: "A" });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].bug_id, "A");
});

test("computeStats filters by model_id", () => {
  const results = [
    { bug_id: "A", model_id: "m1", verification: { ok: true } },
    { bug_id: "A", model_id: "m2", verification: { ok: false } },
  ];

  const stats = computeStats(results, { modelId: "m2" });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].model_id, "m2");
});

test("computeStats partial threshold requires >= 2 bytes", () => {
  const results = [
    { bug_id: "X", model_id: "m1", verification: { ok: false, partial: { prefix_bytes_matched: 1, suffix_bytes_matched: 1 } } },
    { bug_id: "X", model_id: "m1", verification: { ok: false, partial: { prefix_bytes_matched: 2, suffix_bytes_matched: 0 } } },
  ];

  const stats = computeStats(results);
  assert.equal(stats[0].partial, 1); // only second qualifies
  assert.equal(stats[0].failed, 1);  // first is below threshold
});

test("computeStats averages are correct", () => {
  const results = [
    { bug_id: "A", model_id: "m1", verification: { ok: true } },
    { bug_id: "A", model_id: "m1", verification: { ok: false, reason: "not found" } },
  ];

  const stats = computeStats(results);
  assert.equal(stats[0].avg_prefix, 16); // (32 + 0) / 2
  assert.equal(stats[0].avg_suffix, 16);
});

console.log("\nDone.");
