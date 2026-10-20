# LSP WebSocket Service

A Node.js service that connects browser clients to language servers using the Language Server Protocol (LSP) over WebSockets. Each authenticated connection gets its own language-server process and per-user workspace.

## Features

- LSP proxy for Go, Python, JavaScript, and TypeScript.
- JWT authentication compatible with the Flask backend's HS256 access tokens.
- Per-user workspaces under `workspaces/<user-id>/`.
- Session limits, message-size and message-rate limits, optional origin allowlist, and idle connection timeout.
- Language-server processes are stopped when their WebSocket connection closes.

Code execution is not implemented. A client `run` message receives a message saying execution is unavailable and a nonzero exit code.

## Requirements

- Node.js 24 (Node 20.6+ is needed for built-in `.env` loading).
- npm.
- Go toolchain and `gopls` on `PATH` for Go sessions. The Docker image includes both.

Python, JavaScript, and TypeScript language-server packages are installed from npm dependencies. The Python language server is Pyright; JavaScript and TypeScript use `typescript-language-server` with the bundled TypeScript compiler.

## Setup

```sh
npm ci
```

Create a `.env` file in the project root. Use the same `JWT_SECRET_KEY` as the Flask backend:

```dotenv
HOST=127.0.0.1
PORT=3000
JWT_SECRET_KEY=replace-with-the-flask-backend-secret
# Optional: comma-separated browser origins, for example http://localhost:5173
ALLOWED_ORIGIN=http://localhost:5173
```

Start the service:

```sh
npm start
```

The HTTP endpoint responds with `Hello World`. WebSocket clients connect to that same host and port.

## WebSocket connection

Open one WebSocket per language using this URL shape:

```text
ws://<host>:<port>/?lang=<language>&token=<jwt>
```

Supported `lang` values are `go`, `python`, `javascript`, and `typescript`. If omitted, the language defaults to `go`.

The token must be an HS256 JWT signed with `JWT_SECRET_KEY`. Its `sub` claim must be a 1–64 character user ID containing only letters, digits, `_`, or `-`. If the `type` claim is present, it must equal `access`. For local development, the included helper can issue a temporary token:

```sh
node make-token.js 1 1h
```

`make-token.js` prints a token for user `1` that expires in one hour. Use only for local development; production tokens should be issued by the Flask backend. Do not commit `.env` or share tokens.

After connection, the server sends a `workspace` message containing the exact file URI the client should open. Use that URI in LSP document messages. LSP messages are JSON encoded inside WebSocket frames; the server owns the language-server initialization and lifecycle. It responds to `run` with `run-output` and `run-done` messages, but does not execute the submitted code.

## Configuration

All settings are read from `.env` (which is loaded at startup) or the process environment.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address for the HTTP and WebSocket server to bind to. |
| `PORT` | `3000` | HTTP and WebSocket listening port. |
| `JWT_SECRET_KEY` | Required | Shared HS256 signing secret used to verify Flask access tokens. The service exits at startup if missing. |
| `ALLOWED_ORIGIN` | Empty | Optional comma-separated list of allowed browser `Origin` values. When empty, no origin allowlist is applied. |
| `WORKSPACE_DIR` | `./workspaces` | Root directory for per-user language workspaces. |
| `MAX_SESSIONS` | `20` | Maximum concurrent language-server sessions across all users. |
| `MAX_SESSIONS_PER_USER` | `4` | Maximum concurrent sessions for one user. |
| `MAX_MESSAGE_BYTES` | `1000000` | Maximum WebSocket message size in bytes. |
| `MAX_MESSAGES_PER_SEC` | `100` | Maximum incoming WebSocket messages per second per connection. |
| `IDLE_MINUTES` | `30` | Close a connection after this many minutes without client messages. |

The Dockerfile exposes port `4000`, while the application defaults to `3000`; set `PORT=4000` when running the image with the default port mapping.

## Docker

Build the image from the project root:

```sh
docker build -t lsp-websocket .
```

Run it with a JWT secret and a host port mapped to the container's port 4000:

```sh
docker run --rm -p 4000:4000 \
  -e PORT=4000 \
  -e JWT_SECRET_KEY=replace-with-the-flask-backend-secret \
  -e ALLOWED_ORIGIN=http://localhost:5173 \
  lsp-websocket
```

The image runs as the non-root `node` user. Persist `/app/workspaces` with a volume if workspace files should survive container replacement.

## Development notes

- Go workspaces are initialized with a `go.mod` if needed. The service creates `main.go` for Go and `main.py`, `main.js`, or `main.ts` for the other languages when their workspace file does not exist.
- JavaScript and TypeScript workspaces receive a minimal `jsconfig.json` or `tsconfig.json` if one is absent.
- The HTTP server has no application routes beyond its plain-text health response.
- `npm test` is a placeholder and currently exits with an error because no test suite is configured.
