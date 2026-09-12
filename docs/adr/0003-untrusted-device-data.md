# ADR 0003 — Device data is untrusted input, and stateless HTTP

**Status:** accepted · **Date:** 2026-09-12

Two decisions that fell out of the same question: what is the attack surface of a read-only server?

## Part 1 — The untrusted fence

### Context

A device shadow is not a data source, it is user input. Anyone with `iot:Publish` on `$aws/things/<name>/shadow/update` chooses the bytes an assistant reads: a compromised device, a contractor's laptop, a misconfigured integration. The same is true of thing attributes (anyone with `iot:UpdateThing`) and of topic-rule SQL and descriptions (anyone with `iot:ReplaceTopicRule`).

Published MCP attack research reports very high success rates for tool-response injection against very low detection. The market analysis behind this repository reached a specific conclusion about that: **building MCP security tooling is a saturated space; applying the existing hardening and documenting it is the differentiator.** This is that application.

The tempting design is a filter: detect malicious payloads and drop them. That fails twice — the heuristics are evadable, and hiding a payload from the operator destroys the diagnostic value of a diagnostic tool. A device reporting an injection attempt is _exactly_ what the operator needs to see.

### Decision

A single boundary module, `src/domain/untrusted.ts`, through which every device- or customer-authored value passes. It canonicalises, strips hostile characters, screens for signals, caps size, neutralises the fence delimiter if it appears inside the payload, and wraps the result in a delimited block with a provenance header.

Signals are **reported, never acted on**: in the fence header, in the tool text, in the audit log, and — in the health sweep — as a finding whose message tells the operator to go check who can publish to that device.

The server's initialise-time instructions tell the model the block is data, not instructions. That is prompt-level mitigation with no security guarantee, and the docs say so.

### Consequences

**Good.** One place to audit, one place to improve, and the behaviour is testable: the conformance suite asserts the fence cannot be closed from inside, that control and bidi characters never reach the client, that oversized payloads are truncated with the original size stated, and that signals reach the audit log.

**Bad.** Fenced output is more verbose, which costs tokens on every shadow read. Signal detection has false positives — a firmware release note legitimately containing "ignore previous settings" will trip `instruction_override`. We accept the noise: a false positive costs a sentence of explanation, a false negative costs the premise of the tool.

## Part 2 — Stateless HTTP

### Context

The streamable HTTP transport can run stateful (server-generated session ids, in-memory connection state) or stateless. Stateful is the richer option: resumable streams, server-initiated notifications.

We have no use for either. Every tool here is a request/response read.

### Decision

`sessionIdGenerator: undefined`. A fresh server and transport per request, closed when the response ends. No shared state of any kind.

### Consequences

**Good.** Deployable on Lambda or behind any load balancer with no sticky routing and no shared cache. Security-wise there is no session to hijack, replay or exhaust, and a hostile request cannot affect the next one. DNS-rebinding protection is on, with `allowedHosts` derived from the configured bind address.

**Bad.** No resumable streams and no server-initiated notifications. Per-request setup costs a few milliseconds, irrelevant next to an AWS round trip. And the entry point does **not** authenticate — it binds to localhost and expects an authenticating proxy in front. Writing our own auth would be worse than composing with API Gateway or an OIDC-terminating ALB, but it does mean a misdeployment exposes fleet reads to a network. `docs/DEPLOY.md` says that in those words rather than burying it.
