import { useEffect, useRef, useState } from "react";
import "./styles.css";

const REFRESH_INTERVAL_MS = 30000;

function Panel() {
  const [stats, setStats] = useState(null);
  const [results, setResults] = useState(null);
  const [bugFilter, setBugFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [sortCol, setSortCol] = useState(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);
  const [viewingRun, setViewingRun] = useState(null);
  const [runData, setRunData] = useState(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef(null);

  function fetchStats() {
    const params = new URLSearchParams();
    if (bugFilter.trim()) params.set("bug_id", bugFilter.trim());
    if (modelFilter.trim()) params.set("model_id", modelFilter.trim());
    const qs = params.toString();

    Promise.all([
      fetch(`/api/addons/exp-stats/stats${qs ? `?${qs}` : ""}`).then((r) => r.json()),
      fetch(`/api/addons/exp-stats/results${qs ? `?${qs}` : ""}`).then((r) => r.json()),
    ])
      .then(([s, r]) => {
        setStats(s);
        setResults(r);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    fetchStats();
    intervalRef.current = setInterval(fetchStats, REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [bugFilter, modelFilter]);

  function handleSort(col) {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  }

  function sortedStats() {
    if (!stats) return [];
    if (!sortCol) return stats;
    return [...stats].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      if (typeof av === "number" && typeof bv === "number") {
        return sortAsc ? av - bv : bv - av;
      }
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  }

  function handleViewRun(runId) {
    setViewingRun(runId);
    setRunData(null);
    fetch(`/api/addons/exp-stats/run/${encodeURIComponent(runId)}`)
      .then((r) => r.json())
      .then(setRunData)
      .catch(() => setRunData({ error: "Failed to load run data" }));
  }

  function rowClass(row) {
    if (row.solved > 0) return "es-row-solved";
    if (row.partial > 0) return "es-row-partial";
    return "";
  }

  function expandedRunsForRow(row) {
    if (!results) return [];
    return results.filter((r) => (r.bug_id || "unknown") === row.bug_id && (r.model_id || "unknown") === row.model_id);
  }

  // --- Run detail / conversation viewer ---
  if (viewingRun) {
    return <RunDetail runId={viewingRun} data={runData} onBack={() => setViewingRun(null)} />;
  }

  // --- Stats overview ---
  const rows = sortedStats();
  const totals =
    rows.length > 0
      ? {
          runs: rows.reduce((s, r) => s + r.runs, 0),
          solved: rows.reduce((s, r) => s + r.solved, 0),
          partial: rows.reduce((s, r) => s + r.partial, 0),
          failed: rows.reduce((s, r) => s + r.failed, 0),
          best_prefix: Math.max(...rows.map((r) => r.best_prefix)),
          best_suffix: Math.max(...rows.map((r) => r.best_suffix)),
        }
      : null;

  const columns = [
    { key: "bug_id", label: "Bug ID" },
    { key: "model_id", label: "Model" },
    { key: "runs", label: "Runs" },
    { key: "solved", label: "Solved" },
    { key: "partial", label: "Partial" },
    { key: "failed", label: "Failed" },
    { key: "best_prefix", label: "Best Prefix" },
    { key: "best_suffix", label: "Best Suffix" },
  ];

  return (
    <div className="es-panel">
      <header className="es-header">
        <div>
          <p className="eyebrow">Addon</p>
          <h2>Exploit Stats</h2>
        </div>
        <button type="button" className="es-refresh-btn" onClick={fetchStats}>
          Refresh
        </button>
      </header>

      <div className="es-filters">
        <label>
          Bug ID
          <input type="text" value={bugFilter} onChange={(e) => setBugFilter(e.target.value)} placeholder="Filter by bug ID" />
        </label>
        <label>
          Model
          <input type="text" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="Filter by model" />
        </label>
      </div>

      {loading ? (
        <div className="es-loading">Loading stats...</div>
      ) : !stats || stats.length === 0 ? (
        <div className="es-empty">No runs found.</div>
      ) : (
        <>
          <div className="es-cards">
            <div className="es-card">
              <span className="es-card-value">{totals.runs}</span>
              <span className="es-card-label">Total Runs</span>
            </div>
            <div className="es-card es-card-solved">
              <span className="es-card-value">{totals.solved}</span>
              <span className="es-card-label">Solved</span>
            </div>
            <div className="es-card es-card-partial">
              <span className="es-card-value">{totals.partial}</span>
              <span className="es-card-label">Partial</span>
            </div>
            <div className="es-card es-card-failed">
              <span className="es-card-value">{totals.failed}</span>
              <span className="es-card-label">Failed</span>
            </div>
          </div>

          <div className="es-table-wrap">
            <table className="es-table">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col.key} onClick={() => handleSort(col.key)} className={sortCol === col.key ? "es-sorted" : ""}>
                      {col.label}
                      {sortCol === col.key ? (sortAsc ? " \u25B2" : " \u25BC") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const key = `${row.bug_id}-${row.model_id}`;
                  const isExpanded = expandedRow === key;
                  return [
                    <tr
                      key={key}
                      className={`${rowClass(row)}${isExpanded ? " es-row-expanded" : ""}`}
                      onClick={() => setExpandedRow(isExpanded ? null : key)}
                    >
                      <td>{row.bug_id}</td>
                      <td>{row.model_id}</td>
                      <td>{row.runs}</td>
                      <td>{row.solved}</td>
                      <td>{row.partial}</td>
                      <td>{row.failed}</td>
                      <td>{row.best_prefix}/32</td>
                      <td>{row.best_suffix}/32</td>
                    </tr>,
                    isExpanded && (
                      <tr key={`${key}-detail`} className="es-detail-row">
                        <td colSpan={columns.length}>
                          <div className="es-detail-runs">
                            {expandedRunsForRow(row).map((run) => (
                              <div key={run.run_id} className="es-detail-run">
                                <span className="es-detail-run-id">{run.run_id}</span>
                                <span className={`es-detail-status ${run.verification?.ok ? "solved" : run.verification?.partial ? "partial" : "failed"}`}>
                                  {run.verification?.ok ? "solved" : run.verification?.partial ? "partial" : "failed"}
                                </span>
                                <span>exit: {run.exit_code ?? "?"}</span>
                                <span className="es-detail-match">
                                  prefix: {run.verification?.ok ? 32 : run.verification?.partial?.prefix_bytes_matched ?? 0}/32
                                  {" "}suffix: {run.verification?.ok ? 32 : run.verification?.partial?.suffix_bytes_matched ?? 0}/32
                                </span>
                                <span className="es-detail-mitigations">
                                  <MitigationBadges run={run} />
                                </span>
                                <button type="button" className="es-conv-link" onClick={(e) => { e.stopPropagation(); handleViewRun(run.run_id); }}>
                                  View conversation
                                </button>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="es-total-row">
                    <td>TOTAL</td>
                    <td></td>
                    <td>{totals.runs}</td>
                    <td>{totals.solved}</td>
                    <td>{totals.partial}</td>
                    <td>{totals.failed}</td>
                    <td>{totals.best_prefix}/32</td>
                    <td>{totals.best_suffix}/32</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// --- Conversation viewer ---

function MitigationBadges({ run }) {
  const bp = run.build_profile;
  const rp = run.runtime_profile;
  if (!bp && !rp) return null;
  const items = [];
  if (rp?.aslr) items.push({ label: "ASLR", on: true });
  else items.push({ label: "ASLR", on: false });
  if (bp?.pie) items.push({ label: "PIE", on: true });
  else items.push({ label: "PIE", on: false });
  if (bp?.relro === "full") items.push({ label: "RELRO full", on: true });
  else if (bp?.relro === "partial") items.push({ label: "RELRO partial", on: true });
  else items.push({ label: "RELRO", on: false });
  if (bp?.stack_canaries) items.push({ label: "Canaries", on: true });
  else items.push({ label: "Canaries", on: false });
  if (bp?.sanitizer === "address") items.push({ label: "ASAN", on: true });
  return (
    <>
      {items.map((item) => (
        <span key={item.label} className={`es-mitigation-badge ${item.on ? "on" : "off"}`}>
          {item.label}
        </span>
      ))}
    </>
  );
}

function classifyLine(line) {
  if (/^\[thinking\]/.test(line)) return "thinking";
  if (/^\[tool:[^\]]+\]/.test(line)) return "tool-call";
  if (/^\[tool-result\]/.test(line)) return "tool-result";
  if (/^\[rate-limit\]/.test(line)) return "meta";
  if (/^\[init\]/.test(line)) return "meta";
  return "text";
}

function RunDetail({ runId, data, onBack }) {
  const [collapsedBlocks, setCollapsedBlocks] = useState(new Set());

  function toggleBlock(index) {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  if (!data) {
    return (
      <div className="es-panel">
        <header className="es-header">
          <button type="button" className="es-back-btn" onClick={onBack}>&larr; Back</button>
          <h2>Loading run {runId}...</h2>
        </header>
        <div className="es-loading">Loading...</div>
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="es-panel">
        <header className="es-header">
          <button type="button" className="es-back-btn" onClick={onBack}>&larr; Back</button>
          <h2>Run {runId}</h2>
        </header>
        <div className="es-empty">{data.error}</div>
      </div>
    );
  }

  const isCodex = (data.model_id || "").toLowerCase().includes("codex") || (data.agent_profile?.agent_id === "codex");
  const rawText = isCodex ? [data.stderr, data.stdout].filter(Boolean).join("\n") : (data.stdout || "");
  const lines = rawText.split("\n");

  // Group consecutive lines of the same type into blocks for collapsibility
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const type = classifyLine(line);
    if (blocks.length > 0 && blocks[blocks.length - 1].type === type) {
      blocks[blocks.length - 1].lines.push(line);
    } else {
      blocks.push({ type, lines: [line], startIndex: i });
    }
  }

  const solved = data.verification?.ok;
  const statusLabel = solved ? "solved" : data.verification?.partial ? "partial" : "failed";

  return (
    <div className="es-panel">
      <header className="es-header">
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button type="button" className="es-back-btn" onClick={onBack}>&larr; Back</button>
          <div>
            <p className="eyebrow">Run Conversation</p>
            <h2>{runId}</h2>
          </div>
        </div>
      </header>

      <div className="es-run-meta">
        <span>Bug: <strong>{data.bug_id || "?"}</strong></span>
        <span>Model: <strong>{data.model_id || "?"}</strong></span>
        <span>Exit: <strong>{data.exit_code ?? "?"}</strong></span>
        <span className={`es-detail-status ${statusLabel}`}>{statusLabel}</span>
      </div>

      <section className="es-conversation log-panel">
        {blocks.map((block, idx) => {
          const isCollapsible = block.type === "tool-result" && block.lines.length > 5;
          const isCollapsed = collapsedBlocks.has(idx);
          const displayLines = isCollapsible && isCollapsed ? block.lines.slice(0, 3) : block.lines;

          return (
            <div key={idx} className={`es-block es-block-${block.type}`}>
              {isCollapsible && (
                <button type="button" className="es-collapse-btn" onClick={() => toggleBlock(idx)}>
                  {isCollapsed ? `\u25B6 Show ${block.lines.length} lines` : "\u25BC Collapse"}
                </button>
              )}
              {displayLines.map((line, li) => (
                <div key={li} className="es-conv-line">
                  <code>{line}</code>
                </div>
              ))}
              {isCollapsible && isCollapsed && (
                <div className="es-conv-line es-truncated">... {block.lines.length - 3} more lines</div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

export default Panel;
