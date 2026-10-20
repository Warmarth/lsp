# --- Stage 1: build gopls ---
FROM golang:bookworm AS gobuild
ENV GOBIN=/out
RUN go install golang.org/x/tools/gopls@latest

# --- Stage 2: the service ---
FROM node:24-bookworm-slim

# gopls needs the `go` command at runtime, so ship the toolchain too
COPY --from=gobuild /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /app

# Install npm packages first so this layer is cached between code changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js lsp.js ./
COPY --from=gobuild /out/gopls ./bin/gopls

# Run as the non-root "node" user; it needs to write the per-user workspaces
RUN mkdir -p /app/workspaces && chown -R node:node /app
USER node

ENV HOST=0.0.0.0
EXPOSE 4000
CMD ["node", "server.js"]