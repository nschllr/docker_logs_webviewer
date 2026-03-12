import { useEffect, useLayoutEffect, useRef, useState } from "react";

const REFRESH_INTERVAL_MS = 5000;
const DEFAULT_TAIL = 200;
const AUTO_SCROLL_THRESHOLD_PX = 40;

function formatDateTime(value) {
  if (!value) {
    return "Unknown time";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function App() {
  const [containers, setContainers] = useState([]);
  const [containersLoading, setContainersLoading] = useState(true);
  const [containersError, setContainersError] = useState("");
  const [filterText, setFilterText] = useState("");
  const [pinnedStoppedContainer, setPinnedStoppedContainer] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [logs, setLogs] = useState([]);
  const [streamState, setStreamState] = useState("idle");
  const [streamError, setStreamError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const logViewportRef = useRef(null);
  const selectedIdRef = useRef("");
  const lastSelectedRunningContainerRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);

  const normalizedFilter = filterText.trim().toLowerCase();
  const visibleContainers = containers.filter((container) =>
    container.image.toLowerCase().includes(normalizedFilter)
  );
  const selectedRunningContainer = containers.find((container) => container.id === selectedId) || null;
  const selectedPinnedContainer =
    pinnedStoppedContainer?.id === selectedId ? pinnedStoppedContainer : null;
  const selectedContainer = selectedRunningContainer || selectedPinnedContainer || null;
  const isSelectedRunning = Boolean(selectedRunningContainer);
  const isSelectedPinned = Boolean(selectedPinnedContainer);

  function isNearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= AUTO_SCROLL_THRESHOLD_PX;
  }

  function preserveSelectedContainerAsStopped() {
    const currentSelectedId = selectedIdRef.current;
    const lastRunningContainer = lastSelectedRunningContainerRef.current;

    if (!currentSelectedId || !lastRunningContainer || lastRunningContainer.id !== currentSelectedId) {
      return;
    }

    setPinnedStoppedContainer({
      ...lastRunningContainer,
      status: "Stopped",
      state: "exited"
    });
    setStreamState("stopped");
    setStreamError("");
  }

  function handleSelectContainer(containerId) {
    if (containerId === selectedId) {
      return;
    }

    shouldAutoScrollRef.current = true;
    setPinnedStoppedContainer(null);
    setSelectedId(containerId);
  }

  function handleRemovePinnedContainer() {
    if (!pinnedStoppedContainer) {
      return;
    }

    shouldAutoScrollRef.current = true;
    setPinnedStoppedContainer(null);
    setLogs([]);
    setStreamError("");
    setSelectedId(containers[0]?.id ?? "");

    if (lastSelectedRunningContainerRef.current?.id === pinnedStoppedContainer.id) {
      lastSelectedRunningContainerRef.current = null;
    }
  }

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (selectedRunningContainer) {
      lastSelectedRunningContainerRef.current = selectedRunningContainer;
    }
  }, [selectedRunningContainer]);

  useEffect(() => {
    let disposed = false;

    async function loadContainers({ initial = false } = {}) {
      if (initial) {
        setContainersLoading(true);
      }

      try {
        const response = await fetch("/api/containers");
        if (!response.ok) {
          throw new Error(`Failed to load containers (${response.status})`);
        }

        const nextContainers = await response.json();
        if (disposed) {
          return;
        }

        setContainers(nextContainers);
        setContainersError("");
        setLastUpdated(new Date().toISOString());
        setPinnedStoppedContainer((currentPinned) => {
          const currentSelectedId = selectedIdRef.current;
          if (!currentSelectedId) {
            return currentPinned;
          }

          if (nextContainers.some((container) => container.id === currentSelectedId)) {
            return currentPinned?.id === currentSelectedId ? null : currentPinned;
          }

          const lastRunningContainer = lastSelectedRunningContainerRef.current;
          if (lastRunningContainer && lastRunningContainer.id === currentSelectedId) {
            return {
              ...lastRunningContainer,
              status: "Stopped",
              state: "exited"
            };
          }

          return currentPinned;
        });

        setSelectedId((current) => {
          if (current && nextContainers.some((container) => container.id === current)) {
            return current;
          }

          if (current && lastSelectedRunningContainerRef.current?.id === current) {
            return current;
          }

          if (nextContainers.length === 0) {
            return "";
          }

          return nextContainers[0].id;
        });
      } catch (error) {
        if (!disposed) {
          setContainersError(error.message);
        }
      } finally {
        if (!disposed && initial) {
          setContainersLoading(false);
        }
      }
    }

    loadContainers({ initial: true });
    const intervalId = window.setInterval(() => {
      loadContainers();
    }, REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setLogs([]);
      setStreamState("idle");
      setStreamError(containers.length === 0 ? "No running containers found." : "");
      return;
    }

    if (isSelectedPinned) {
      setStreamState("stopped");
      setStreamError("");
      return;
    }

    if (!isSelectedRunning) {
      return;
    }

    const source = new EventSource(`/api/containers/${selectedId}/logs?tail=${DEFAULT_TAIL}`);
    let isClosing = false;
    shouldAutoScrollRef.current = true;
    setLogs([]);
    setStreamState("connecting");
    setStreamError("");

    source.addEventListener("ready", () => {
      setStreamState("streaming");
    });

    source.addEventListener("log", (event) => {
      const payload = JSON.parse(event.data);
      setLogs((current) => {
        const nextLogs = current.concat(payload);
        if (nextLogs.length > 1000) {
          return nextLogs.slice(nextLogs.length - 1000);
        }

        return nextLogs;
      });
    });

    source.addEventListener("error-message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.message === "The selected container is not currently running.") {
        preserveSelectedContainerAsStopped();
        isClosing = true;
        source.close();
        return;
      }

      setStreamState("error");
      setStreamError(payload.message);
      isClosing = true;
      source.close();
    });

    source.addEventListener("stream-ended", () => {
      preserveSelectedContainerAsStopped();
      isClosing = true;
      source.close();
    });

    source.onerror = () => {
      if (isClosing) {
        return;
      }

      setStreamState((current) => (current === "streaming" ? "error" : current));
      setStreamError((current) => current || "Log stream disconnected.");
    };

    return () => {
      isClosing = true;
      source.close();
    };
  }, [containers.length === 0, isSelectedPinned, isSelectedRunning, selectedId]);

  useLayoutEffect(() => {
    const node = logViewportRef.current;
    if (!node) {
      return;
    }

    if (shouldAutoScrollRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logs, selectedId, streamState]);

  function handleLogScroll(event) {
    shouldAutoScrollRef.current = isNearBottom(event.currentTarget);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Docker Webview</p>
            <h1>Running containers</h1>
          </div>
          <p className="meta">
            {lastUpdated ? `Updated ${formatDateTime(lastUpdated)}` : "Waiting for first refresh"}
          </p>
        </div>

        {containersLoading ? <p className="status-card">Loading running containers...</p> : null}
        {containersError ? <p className="status-card error">{containersError}</p> : null}
        <label className="filter-field">
          <span>Filter images</span>
          <input
            type="text"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="Type part of an image name"
          />
        </label>
        {!containersLoading && !containersError && containers.length === 0 ? (
          <p className="status-card">No running containers found.</p>
        ) : null}
        {!containersLoading && !containersError && containers.length > 0 && visibleContainers.length === 0 ? (
          <p className="status-card">No running containers match the current image filter.</p>
        ) : null}

        {pinnedStoppedContainer ? (
          <div className="container-card selected stopped pinned-session">
            <div className="pinned-session-header">
              <div className="pinned-session-badges">
                <span className="status-badge stopped">stopped</span>
                <span className="pill">{pinnedStoppedContainer.shortId}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={handleRemovePinnedContainer}
                aria-label="Remove stopped container"
                title="Remove stopped container"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM7 10h2v8H7v-8Zm1 10h8a2 2 0 0 0 2-2V8H6v10a2 2 0 0 0 2 2Z" />
                </svg>
              </button>
            </div>
            <div className="container-card-top">
              <strong>{pinnedStoppedContainer.name}</strong>
            </div>
            <p>{pinnedStoppedContainer.image}</p>
            <small>Preserved logs from the last viewed stopped container.</small>
          </div>
        ) : null}

        <div className="container-list">
          {visibleContainers.map((container) => {
            const isSelected = container.id === selectedId;
            return (
              <button
                type="button"
                key={container.id}
                className={`container-card${isSelected ? " selected" : ""}`}
                onClick={() => handleSelectContainer(container.id)}
              >
                <div className="container-card-top">
                  <strong>{container.name}</strong>
                  <span className="pill">{container.shortId}</span>
                </div>
                <p>{container.image}</p>
                <small>{container.status}</small>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="main-panel">
        <header className="main-header">
          <div>
            <p className="eyebrow">Live logs</p>
            <h2>{selectedContainer ? selectedContainer.name : "Select a container"}</h2>
          </div>
          {selectedContainer ? (
            <div className="selection-meta">
              <span>{selectedContainer.image}</span>
              <span>{`Created ${formatDateTime(selectedContainer.createdAt)}`}</span>
            </div>
          ) : null}
        </header>

        <div className="stream-status">
          <span className={`status-dot ${streamState}`} />
          <span>
            {streamState === "connecting" && "Connecting to container logs..."}
            {streamState === "streaming" && "Streaming recent backlog and live logs"}
            {streamState === "stopped" && "Container stopped. Preserving the last received logs"}
            {streamState === "error" && (streamError || "Unable to open log stream")}
            {streamState === "idle" && "Select a running container to view logs"}
          </span>
        </div>

        <section className="log-panel" ref={logViewportRef} onScroll={handleLogScroll}>
          {logs.length === 0 ? (
            <div className="log-empty">
              <p>{streamError || "Waiting for logs..."}</p>
            </div>
          ) : (
            logs.map((entry, index) => (
              <div
                key={`${entry.timestamp || "no-ts"}-${index}`}
                className={`log-line ${entry.stream}`}
                title={[entry.timestamp, entry.stream].filter(Boolean).join(" ")}
              >
                <code>{entry.message}</code>
              </div>
            ))
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
