import http from "node:http";

const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const API_VERSION = "v1.47";

function dockerRequest(pathname, { method = "GET", signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path: `/${API_VERSION}${pathname}`,
        method,
        signal
      },
      (response) => {
        resolve(response);
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function dockerJson(pathname, options) {
  const response = await dockerRequest(pathname, options);
  const chunks = [];

  for await (const chunk of response) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(body || `Docker API request failed with status ${response.statusCode}`);
  }

  return body ? JSON.parse(body) : null;
}

export function normalizeContainerSummary(container) {
  return {
    id: container.Id,
    shortId: container.Id.slice(0, 12),
    name: (container.Names?.[0] || container.Id).replace(/^\//, ""),
    image: container.Image,
    status: container.Status,
    state: container.State,
    createdAt: container.Created ? new Date(container.Created * 1000).toISOString() : ""
  };
}

function computeRuntime(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt);
  const end = new Date(finishedAt);
  if (isNaN(start) || isNaN(end)) return null;
  const ms = end - start;
  if (ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export async function listContainers() {
  const containers = await dockerJson("/containers/json?all=1");
  const summaries = containers.map(normalizeContainerSummary);

  const stoppedSummaries = summaries.filter((c) => c.state !== "running");
  const inspections = await Promise.all(
    stoppedSummaries.map((c) =>
      inspectContainer(c.id).catch(() => null)
    )
  );

  const runtimeById = new Map();
  for (let i = 0; i < stoppedSummaries.length; i++) {
    const inspection = inspections[i];
    if (inspection?.State) {
      runtimeById.set(
        stoppedSummaries[i].id,
        computeRuntime(inspection.State.StartedAt, inspection.State.FinishedAt)
      );
    }
  }

  return summaries
    .map((c) => ({ ...c, runtime: runtimeById.get(c.id) || null }))
    .sort((left, right) => {
      if (left.state === right.state) {
        return right.createdAt.localeCompare(left.createdAt);
      }

      if (left.state === "running") {
        return -1;
      }

      if (right.state === "running") {
        return 1;
      }

      return right.createdAt.localeCompare(left.createdAt);
    });
}

export async function inspectContainer(containerId) {
  return dockerJson(`/containers/${encodeURIComponent(containerId)}/json`);
}

export async function removeContainer(containerId) {
  return dockerJson(`/containers/${encodeURIComponent(containerId)}`, { method: "DELETE" });
}

export async function openContainerLogs(containerId, { tail = 200, follow = true, signal } = {}) {
  const tailValue =
    tail === "all" ? "all" : Number.isFinite(tail) ? Math.max(1, Math.min(5000, tail)) : 200;
  const path =
    `/containers/${encodeURIComponent(containerId)}/logs?stdout=1&stderr=1&follow=${follow ? 1 : 0}&tail=${tailValue}&timestamps=1`;
  const response = await dockerRequest(path, { signal });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const chunks = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks).toString("utf8");
    throw new Error(body || `Docker log request failed with status ${response.statusCode}`);
  }

  return response;
}
