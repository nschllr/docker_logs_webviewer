import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectContainer, listContainers, openContainerLogs } from "./docker-api.mjs";
import { createDockerLogDecoder, createLineEmitter } from "./log-stream.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const publicRoot = path.join(projectRoot, "public");
const serverHost = process.env.HOST || "127.0.0.1";
const serverPort = Number(process.env.PORT || 3001);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function writeSse(response, { event, data }) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleContainers(_request, response) {
  try {
    const containers = await listContainers();
    sendJson(response, 200, containers);
  } catch (error) {
    sendJson(response, 500, {
      message: "Failed to query Docker for containers.",
      detail: error.message
    });
  }
}

async function handleContainerLogs(request, response, containerId) {
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8"
  });

  const controller = new AbortController();
  request.on("close", () => {
    controller.abort();
  });

  try {
    const inspection = await inspectContainer(containerId);
    const isRunning = inspection.State?.Running === true;

    const requestedTail = Number(new URL(request.url, "http://localhost").searchParams.get("tail")) || 200;
    const logResponse = await openContainerLogs(containerId, {
      tail: isRunning ? requestedTail : "all",
      follow: isRunning,
      signal: controller.signal
    });

    writeSse(response, {
      event: "ready",
      data: { containerId, running: isRunning }
    });

    const lineEmitter = createLineEmitter((line) => {
      writeSse(response, { event: "log", data: line });
    });

    const decoder = createDockerLogDecoder({
      tty: Boolean(inspection.Config?.Tty),
      onFrame(stream, payload) {
        lineEmitter.push(stream, payload);
      }
    });

    for await (const chunk of logResponse) {
      decoder.write(chunk);
    }

    decoder.flush();
    lineEmitter.flush();

    if (!controller.signal.aborted) {
      writeSse(response, {
        event: "stream-ended",
        data: { containerId }
      });
    }

    response.end();
  } catch (error) {
    if (error.name === "AbortError") {
      response.end();
      return;
    }

    if (!response.writableEnded) {
      writeSse(response, {
        event: "error-message",
        data: {
          message: error.message
        }
      });
      response.end();
    }
  }
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath);
  const contentType = MIME_TYPES[extension] || "application/octet-stream";
  const stream = fs.createReadStream(filePath);
  response.writeHead(200, { "content-type": contentType });
  stream.pipe(response);
  stream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(404);
    }
    response.end();
  });
}

function tryServeStatic(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const targetPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, "");
  const distPath = path.join(distRoot, safePath);
  const publicPath = path.join(publicRoot, safePath);

  if (fs.existsSync(distPath) && fs.statSync(distPath).isFile()) {
    sendFile(response, distPath);
    return true;
  }

  if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
    sendFile(response, publicPath);
    return true;
  }

  const distIndex = path.join(distRoot, "index.html");
  if (fs.existsSync(distIndex)) {
    sendFile(response, distIndex);
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  if (!request.url || !request.method) {
    response.writeHead(400);
    response.end();
    return;
  }

  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/containers") {
    await handleContainers(request, response);
    return;
  }

  const logMatch = url.pathname.match(/^\/api\/containers\/([^/]+)\/logs$/);
  if (request.method === "GET" && logMatch) {
    await handleContainerLogs(request, response, decodeURIComponent(logMatch[1]));
    return;
  }

  if (request.method === "GET" && tryServeStatic(request, response)) {
    return;
  }

  sendJson(response, 404, { message: "Not found" });
});

server.on("error", (error) => {
  console.error(`Failed to start Docker webview server on ${serverHost}:${serverPort}`);
  console.error(error);
  process.exitCode = 1;
});

server.listen(serverPort, serverHost, () => {
  console.log(`Docker webview server listening on http://${serverHost}:${serverPort}`);
});
