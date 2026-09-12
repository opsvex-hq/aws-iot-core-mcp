# ADR 0001 — TypeScript, not Go

**Status:** accepted · **Date:** 2026-09-12

## Context

Opsvex writes backend services in Go. This repository does not, and the reason is distribution rather than taste.

An MCP server is only useful if a user can attach it to a client in one line of JSON. The evidence we had when choosing:

- The one MCP server by a solo consultant that reached real adoption wraps a platform with a large pre-existing audience and ships on **npm**, so `npx -y <name>` is the whole install step.
- Dozens of branded MCP servers published by consultancies sit at 0–16 stars. The differentiator was never the language.
- A Go MCP server means the user picks a binary for their platform, or installs a toolchain. Every extra step is adoption lost, and the audience here is operators, not Go developers.

Our own market analysis had already flagged Go as a **distribution handicap** for artefacts meant to be picked up by strangers.

## Decision

TypeScript on Node 20.19+, published to npm, `npx`-runnable, using the official `@modelcontextprotocol/sdk`.

## Consequences

**Good.** One-line install in every MCP client. The official SDK tracks the spec, including the stateless HTTP transport, so we do not maintain a protocol implementation. Zod schemas give the client real JSON-schema validation for free.

**Bad.** Node is a heavier runtime than a Go binary (cold start around a second on Lambda, mostly the AWS SDK). It is not the stack the rest of our backend work uses, so context-switching cost is real. `npm` supply chain is wider than `go.mod`, which is why the dependency list is four runtime packages and CI pins exact versions.

**Rejected alternative.** Go with a released binary per platform: better runtime, materially worse adoption. If this server ever becomes infrastructure rather than a tool people try, revisit.
