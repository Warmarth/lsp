const { spawn, execSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const fs = require("node:fs");

const isWin = process.platform === "win32";

// Every user gets their own folder: workspaces/<userId>/<language folder>
const WORKSPACES = path.resolve(
  process.env.WORKSPACE_DIR || path.join(__dirname, "workspaces"),
);

// Prefer binaries installed inside this project; fall back to PATH.
//   gopls                       -> ./bin           (go install, GOBIN=./bin)
//   pyright / ts-language-server -> ./node_modules/.bin (npm)
function localBin(name, dir) {
  const ext = dir === "bin" ? (isWin ? ".exe" : "") : isWin ? ".cmd" : "";
  const full = path.join(__dirname, dir, name + ext);
  return fs.existsSync(full) ? full : name;
}

function ensureFile(file, text) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, text);
}

// gopls needs a valid module to resolve imports like "fmt".
function ensureGoMod(root) {
  const goModPath = path.join(root, "go.mod");
  const valid =
    fs.existsSync(goModPath) &&
    /^module\s+\S+/m.test(fs.readFileSync(goModPath, "utf8"));
  if (valid) return;

  let version = "1.21";
  try {
    version = execSync("go env GOVERSION")
      .toString()
      .trim()
      .replace(/^go/, "")
      .split(".")
      .slice(0, 2)
      .join(".");
  } catch (e) {
    console.error("`go` was not found on PATH:", e.message);
  }
  fs.writeFileSync(goModPath, `module playground\n\ngo ${version}\n`);
  console.log("Created go.mod");
}

const tsconfig = (name) => (root) =>
  ensureFile(
    path.join(root, name),
    JSON.stringify(
      {
        compilerOptions: {
          checkJs: true,
          strict: true,
          target: "ES2022",
          module: "commonjs",
        },
      },
      null,
      2,
    ),
  );

// typescript-language-server wraps tsserver, which ships in the `typescript` package.
// Point it at the copy installed in this project (run `npm i typescript` here).
function tsInit() {
  try {
    return {
      tsserver: { path: require.resolve("typescript/lib/tsserver.js") },
    };
  } catch (e) {
    console.error(
      "typescript/lib/tsserver.js not found. Install a TypeScript version that ships it: npm i typescript@5",
    );
    return undefined;
  }
}

const LANGUAGES = {
  go: {
    folder: "test-go",
    file: "main.go",
    command: localBin("gopls", "bin"),
    args: [],
    stub: "package main\n\nfunc main() {}\n",
    prepare: ensureGoMod,
  },
  python: {
    folder: "test-py",
    file: "main.py",
    command: localBin("pyright-langserver", "node_modules/.bin"),
    args: ["--stdio"],
    stub: "",
  },
  javascript: {
    folder: "test-js",
    file: "main.js",
    command: localBin("typescript-language-server", "node_modules/.bin"),
    args: ["--stdio"],
    stub: "",
    prepare: tsconfig("jsconfig.json"),
    initOptions: tsInit,
  },
  typescript: {
    folder: "test-ts",
    file: "main.ts",
    command: localBin("typescript-language-server", "node_modules/.bin"),
    args: ["--stdio"],
    stub: "",
    prepare: tsconfig("tsconfig.json"),
    initOptions: tsInit,
  },
};

// With shell:true on Windows, child.kill() only kills cmd.exe, so kill the whole tree.
function killTree(child) {
  if (!child || child.killed) return;
  if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill();
}

function createLspSession(lang, ws, userId) {
  const cfg = LANGUAGES[lang];
  if (!cfg) return null;

  const tag = `[${lang}]`;
  const rootPath = path.join(WORKSPACES, userId, cfg.folder);
  const filePath = path.join(rootPath, cfg.file);
  fs.mkdirSync(rootPath, { recursive: true });
  ensureFile(filePath, cfg.stub);
  cfg.prepare?.(rootPath);

  const rootUri = pathToFileURL(rootPath).href;
  const fileUri = pathToFileURL(filePath).href;
  console.log(tag, "file URI:", fileUri);
  // The browser must use this exact URI for the document it opens.
  if (ws.readyState === 1)
    ws.send(JSON.stringify({ type: "workspace", uri: fileUri }));

  const INIT_ID = "server-init";
  const command = isWin ? `"${cfg.command}"` : cfg.command;
  console.log(tag, "starting:", cfg.command);
  const proc = spawn(command, cfg.args, { cwd: rootPath, shell: isWin });

  let buffer = Buffer.alloc(0);
  let ready = false;
  let initResult = null;
  let pendingInitId = null;
  let docVersion = 1;
  let docOpen = false;
  const queue = [];

  proc.on("error", (err) =>
    console.error(tag, `failed to start ${cfg.command}:`, err.message),
  );
  proc.on("exit", (code) =>
    console.log(tag, "language server exited with code", code),
  );
  proc.stderr.on("data", (d) =>
    console.log(tag, "stderr:", d.toString().trim()),
  );

  function sendToLsp(message) {
    const json = JSON.stringify(message);
    proc.stdin.write(
      `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
    );
  }

  function sendToBrowser(message) {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  // ---- Handshake (owned by the server) ----
  sendToLsp({
    jsonrpc: "2.0",
    id: INIT_ID,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri,
      initializationOptions: cfg.initOptions?.(),
      workspaceFolders: [{ uri: rootUri, name: cfg.folder }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          definition: {},
          publishDiagnostics: { relatedInformation: true },
        },
      },
    },
  });

  function onInitialized(result) {
    initResult = result;
    sendToLsp({ jsonrpc: "2.0", method: "initialized", params: {} });
    ready = true;
    console.log(tag, "initialized");

    if (pendingInitId !== null) {
      sendToBrowser({ jsonrpc: "2.0", id: pendingInitId, result: initResult });
      pendingInitId = null;
    }
    while (queue.length) sendToLsp(queue.shift());
  }

  // Requests the language server makes to the client that we answer ourselves.
  function handleServerRequest(msg) {
    switch (msg.method) {
      case "workspace/configuration":
        sendToLsp({
          jsonrpc: "2.0",
          id: msg.id,
          result: (msg.params.items || []).map(() => ({})),
        });
        return true;
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
        sendToLsp({ jsonrpc: "2.0", id: msg.id, result: null });
        return true;
      default:
        return false;
    }
  }

  function handleLspMessage(msg) {
    if (msg.id === INIT_ID && !msg.method) {
      if (msg.error) return console.error(tag, "initialize failed:", msg.error);
      return onInitialized(msg.result);
    }
    if (msg.method) {
      const text =
        msg.params && msg.params.message
          ? ` ${String(msg.params.message).trim()}`
          : "";
      console.log(tag, "->", msg.method + text);
    }
    if (msg.method && msg.id !== undefined && handleServerRequest(msg)) return;
    if (msg.method === "textDocument/publishDiagnostics") {
      console.log(
        tag,
        "DIAGNOSTICS:",
        msg.params.uri,
        JSON.stringify(msg.params.diagnostics),
      );
    }
    sendToBrowser(msg);
  }

  proc.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);

    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator === -1) return;

      const header = buffer.subarray(0, separator).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        console.error(tag, "missing Content-Length header, dropping buffer");
        buffer = Buffer.alloc(0);
        return;
      }

      const bodyStart = separator + 4;
      const messageEnd = bodyStart + Number(match[1]);
      if (buffer.length < messageEnd) return;

      const body = buffer.subarray(bodyStart, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);

      try {
        handleLspMessage(JSON.parse(body));
      } catch (err) {
        console.error(tag, "error handling message:", err);
      }
    }
  });

  // ---- Browser -> language server ----
  function handle(msg) {
    switch (msg.method) {
      case "initialize":
        if (ready)
          sendToBrowser({ jsonrpc: "2.0", id: msg.id, result: initResult });
        else pendingInitId = msg.id;
        return;

      case "initialized":
      case "shutdown":
      case "exit":
        return; // the server owns the lifecycle

      case "textDocument/didOpen":
        if (msg.params.textDocument.uri === fileUri) {
          if (!docOpen) {
            docOpen = true; // first open: forward as-is, browser text is the source of truth
            docVersion = msg.params.textDocument.version;
            break;
          }
          msg = {
            jsonrpc: "2.0",
            method: "textDocument/didChange",
            params: {
              textDocument: { uri: fileUri, version: ++docVersion },
              contentChanges: [{ text: msg.params.textDocument.text }],
            },
          };
        }
        break;

      case "textDocument/didChange":
        if (msg.params.textDocument.uri === fileUri) {
          docVersion = Math.max(
            docVersion + 1,
            msg.params.textDocument.version,
          );
          msg.params.textDocument.version = docVersion;
        }
        break;
    }

    if (ready) sendToLsp(msg);
    else queue.push(msg);
  }

  return { fileUri, handle, dispose: () => killTree(proc) };
}

module.exports = { createLspSession, LANGUAGES };
