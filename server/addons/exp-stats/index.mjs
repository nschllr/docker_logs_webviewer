import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..", "..");

const defaultRunsDir = path.resolve(projectRoot, "..", ".ai-exp-platform", "runs");
const runsDir = process.env.EXP_RUNS_DIR || defaultRunsDir;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/**
 * Read all result.json files, expanding batch results.
 */
export function collectRunResults(dir) {
  const results = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return results;
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const seenRunIds = new Set();

  // First pass: collect batch results and record their run_ids.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const resultPath = path.join(dir, entry.name, "result.json");
    if (!fs.existsSync(resultPath)) continue;

    let data;
    try {
      const raw = fs.readFileSync(resultPath, "utf8");
      if (!raw.trim()) continue;
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    if (Array.isArray(data.runs)) {
      for (const run of data.runs) {
        results.push(run);
        if (run.run_id) seenRunIds.add(run.run_id);
      }
    } else if (data.bug_id && data.verification) {
      if (!data.run_id || !seenRunIds.has(data.run_id)) {
        results.push(data);
        if (data.run_id) seenRunIds.add(data.run_id);
      }
    }
  }

  return results;
}

/**
 * Compute stats grouped by (bug_id, model_id), matching Python logic.
 */
export function computeStats(results, { bugId, modelId } = {}) {
  const groups = new Map();

  for (const r of results) {
    const bid = r.bug_id || "unknown";
    const mid = r.model_id || "unknown";
    if (bugId && bid !== bugId) continue;
    if (modelId && mid !== modelId) continue;
    const key = `${bid}\0${mid}`;
    if (!groups.has(key)) groups.set(key, { bid, mid, entries: [], fuzzTarget: null, latestRunId: null });
    const g = groups.get(key);
    g.entries.push(r);
    if (!g.fuzzTarget && r.fuzz_target) g.fuzzTarget = r.fuzz_target;
    // run_id contains a timestamp segment; later sorted ids = more recent runs
    if (!g.latestRunId || (r.run_id && r.run_id > g.latestRunId)) g.latestRunId = r.run_id;
  }

  const rows = [];
  const sortedKeys = Array.from(groups.keys()).sort();

  for (const key of sortedKeys) {
    const { bid, mid, entries, fuzzTarget, latestRunId } = groups.get(key);
    let solved = 0, partial = 0, failed = 0;
    let bestPrefix = 0, bestSuffix = 0;
    let prefixSum = 0, suffixSum = 0;

    for (const entry of entries) {
      const v = entry.verification || {};
      if (v.ok) {
        solved++;
        bestPrefix = 32;
        bestSuffix = 32;
        prefixSum += 32;
        suffixSum += 32;
      } else {
        const p = v.partial;
        if (p && ((p.prefix_bytes_matched || 0) >= 2 || (p.suffix_bytes_matched || 0) >= 2)) {
          partial++;
          const pb = p.prefix_bytes_matched || 0;
          const sb = p.suffix_bytes_matched || 0;
          bestPrefix = Math.max(bestPrefix, pb);
          bestSuffix = Math.max(bestSuffix, sb);
          prefixSum += pb;
          suffixSum += sb;
        } else {
          failed++;
        }
      }
    }

    rows.push({
      bug_id: bid,
      model_id: mid,
      fuzz_target: fuzzTarget || "-",
      latest_run_id: latestRunId || "",
      runs: entries.length,
      solved,
      partial,
      failed,
      best_prefix: bestPrefix,
      best_suffix: bestSuffix,
      avg_prefix: entries.length ? prefixSum / entries.length : 0,
      avg_suffix: entries.length ? suffixSum / entries.length : 0,
    });
  }

  return rows;
}

export async function handleRequest(_req, res, subpath, searchParams) {
  const cleanPath = (subpath || "/").replace(/\/+$/, "") || "/";

  if (cleanPath === "/" || cleanPath === "/stats") {
    const bugId = searchParams.get("bug_id") || "";
    const modelId = searchParams.get("model_id") || "";
    const results = collectRunResults(runsDir);
    const stats = computeStats(results, {
      bugId: bugId || undefined,
      modelId: modelId || undefined,
    });
    sendJson(res, 200, stats);
    return;
  }

  if (cleanPath === "/results") {
    const results = collectRunResults(runsDir);
    const bugId = searchParams.get("bug_id") || "";
    const modelId = searchParams.get("model_id") || "";
    const lightweight = results
      .filter((r) => {
        if (bugId && (r.bug_id || "unknown") !== bugId) return false;
        if (modelId && (r.model_id || "unknown") !== modelId) return false;
        return true;
      })
      .map((r) => {
        const { stdout, stderr, ...rest } = r;
        return rest;
      });
    sendJson(res, 200, lightweight);
    return;
  }

  const runMatch = cleanPath.match(/^\/run\/(.+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const resultPath = path.join(runsDir, runId, "result.json");
    if (!fs.existsSync(resultPath)) {
      sendJson(res, 404, { message: "Run not found" });
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      // For batch results, look for matching run inside
      if (Array.isArray(data.runs)) {
        const match = data.runs.find((r) => r.run_id === runId);
        sendJson(res, 200, match || data);
      } else {
        sendJson(res, 200, data);
      }
    } catch {
      sendJson(res, 500, { message: "Failed to read run data" });
    }
    return;
  }

  sendJson(res, 404, { message: "Unknown exp-stats endpoint" });
}
