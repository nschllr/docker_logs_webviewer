# Docker Webview

Local web UI for inspecting running Docker containers and tailing logs from the selected container.

## Features

- Lists currently running containers
- Filters the running list by image name substring
- Streams a recent log backlog plus live updates for the selected container
- Preserves the last viewed logs when the selected container stops
- Keeps the log pane scroll position unless you are already near the bottom

## Requirements

- Node.js 24+
- Docker running on the same machine
- Access to the local Docker socket at `/var/run/docker.sock`

If `docker ps` fails with a permission error, fix Docker socket access for the user running the app before starting this project.

## Install

```bash
npm install
```

## Development

Run both the backend and the Vite frontend:

```bash
npm run dev
```

This starts:

- UI: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3001`

The Vite dev server proxies `/api` requests to the backend.

### Remote browser access during development

If you want to open the UI from another machine, bind both processes to all interfaces:

```bash
HOST=0.0.0.0 npm run dev:server
npm run dev:ui -- --host 0.0.0.0
```

Then open:

```text
http://YOUR_SERVER_IP:5173
```

Port `3001` is the backend API, not the UI.

## Single-port run

To serve the built frontend from the Node backend on one port:

```bash
npm run build
HOST=0.0.0.0 npm start
```

Then open:

```text
http://YOUR_SERVER_IP:3001
```

## Scripts

- `npm run dev` - start backend and frontend for local development
- `npm run dev:server` - start only the Node backend
- `npm run dev:ui` - start only the Vite frontend
- `npm run build` - build the frontend into `dist/`
- `npm start` - run the backend and serve the built frontend if present
- `npm test` - run backend unit tests

## Notes

- The backend currently talks to Docker through the hard-coded default socket path `/var/run/docker.sock`.
- The backend default bind host is `127.0.0.1`, unless overridden with `HOST`.
- The frontend filter matches image names, not container names.
- Removing a stopped container from the sidebar only clears it from the UI; it does not delete anything in Docker.
