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
  const [activeTab, setActiveTab] = useState("running");
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
  const activeLogContainerRef = useRef("");

  const normalizedFilter = filterText.trim().toLowerCase();
  const visibleContainers = containers.filter((container) =>
    container.image.toLowerCase().includes(normalizedFilter)
  );
  const runningContainers = visibleContainers.filter((container) => container.state === "running");
  const stoppedContainers = visibleContainers.filter((container) => container.state !== "running");
  const selectedListedContainer = containers.find((container) => container.id === selectedId) || null;
  const selectedPinnedContainer =
    !selectedListedContainer && pinnedStoppedContainer?.id === selectedId ? pinnedStoppedContainer : null;
  const selectedContainer = selectedListedContainer || selectedPinnedContainer || null;
  const isSelectedRunning = selectedContainer?.state === "running";
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
    const container = containers.find((entry) => entry.id === containerId);
    const nextTab = container?.state === "running" ? "running" : "stopped";

    if (containerId === selectedId) {
      setActiveTab(nextTab);
      return;
    }

    shouldAutoScrollRef.current = true;
    setPinnedStoppedContainer(null);
    setActiveTab(nextTab);
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
    setSelectedId(containers.find((container) => container.state === "running")?.id ?? containers[0]?.id ?? "");
    setActiveTab("running");

    if (lastSelectedRunningContainerRef.current?.id === pinnedStoppedContainer.id) {
      lastSelectedRunningContainerRef.current = null;
    }
  }

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (selectedListedContainer?.state === "running") {
      lastSelectedRunningContainerRef.current = selectedListedContainer;
    }
  }, [selectedListedContainer]);

  useEffect(() => {
    if (selectedListedContainer) {
      setActiveTab(selectedListedContainer.state === "running" ? "running" : "stopped");
      return;
    }

    if (selectedPinnedContainer) {
      setActiveTab("stopped");
    }
  }, [selectedListedContainer, selectedPinnedContainer]);

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
          if (currentPinned?.id && nextContainers.some((container) => container.id === currentPinned.id)) {
            return null;
          }

          if (!currentSelectedId) {
            return currentPinned;
          }

          if (nextContainers.some((container) => container.id === currentSelectedId)) {
            return currentPinned;
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
            return current || "";
          }

          return nextContainers.find((container) => container.state === "running")?.id ?? nextContainers[0].id;
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
      activeLogContainerRef.current = "";
      setLogs([]);
      setStreamState("idle");
      setStreamError(containers.length === 0 ? "No containers found." : "");
      return;
    }

    if (!selectedContainer && isSelectedPinned) {
      setStreamState("stopped");
      setStreamError("");
      return;
    }

    if (!selectedContainer) {
      return;
    }

    const source = new EventSource(`/api/containers/${selectedId}/logs?tail=${DEFAULT_TAIL}`);
    let isClosing = false;
    const isNewSelection = activeLogContainerRef.current !== selectedId;

    activeLogContainerRef.current = selectedId;

    if (isNewSelection) {
      shouldAutoScrollRef.current = true;
      setLogs([]);
    }

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
      if (isSelectedRunning) {
        preserveSelectedContainerAsStopped();
      } else {
        setStreamState("stopped");
        setStreamError("");
      }
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
  }, [containers.length === 0, isSelectedPinned, isSelectedRunning, selectedContainer?.state, selectedId]);

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
            <h1>Containers</h1>
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
          <p className="status-card">No containers found.</p>
        ) : null}
        <div className="tab-strip" role="tablist" aria-label="Container state tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "running"}
            className={`tab-button${activeTab === "running" ? " active" : ""}`}
            onClick={() => setActiveTab("running")}
          >
            Running
            <span className="tab-count">{runningContainers.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "stopped"}
            className={`tab-button${activeTab === "stopped" ? " active" : ""}`}
            onClick={() => setActiveTab("stopped")}
          >
            Stopped
            <span className="tab-count">{stoppedContainers.length + (pinnedStoppedContainer ? 1 : 0)}</span>
          </button>
        </div>

        {!containersLoading &&
        !containersError &&
        containers.length > 0 &&
        visibleContainers.length === 0 ? (
          <p className="status-card">No containers match the current image filter.</p>
        ) : null}
        {!containersLoading &&
        !containersError &&
        visibleContainers.length > 0 &&
        activeTab === "running" &&
        runningContainers.length === 0 ? (
          <p className="status-card">No running containers match the current image filter.</p>
        ) : null}
        {!containersLoading &&
        !containersError &&
        activeTab === "stopped" &&
        stoppedContainers.length === 0 &&
        !pinnedStoppedContainer ? (
          <p className="status-card">No stopped containers match the current image filter.</p>
        ) : null}

        {activeTab === "stopped" && pinnedStoppedContainer ? (
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
          {(activeTab === "running" ? runningContainers : stoppedContainers).map((container) => {
            const isSelected = container.id === selectedId;
            const isStopped = container.state !== "running";
            return (
              <button
                type="button"
                key={container.id}
                className={`container-card${isSelected ? " selected" : ""}${isStopped ? " stopped" : ""}`}
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
            {streamState === "stopped" && "Container is stopped. Showing saved logs"}
            {streamState === "error" && (streamError || "Unable to open log stream")}
            {streamState === "idle" && "Select a container to view logs"}
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
