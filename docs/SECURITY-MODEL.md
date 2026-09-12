# Security model

This document states what the server guarantees, how each guarantee is enforced, and — as importantly — where it stops. Every claim below has a corresponding test in [`tests/conformance/hardening.test.ts`](../tests/conformance/hardening.test.ts). If one of those tests fails, this document has become a lie, and that is the one kind of failure that must never be fixed by editing the test.

## Threat model

An MCP server sits between a language model and a production AWS account. Three things can go wrong, in descending order of how much damage they do:

1. **The assistant changes something.** A confused or manipulated model calls a tool that mutates state — publishes a command to a vehicle, overwrites a shadow, detaches a certificate.
2. **A device manipulates the assistant.** Shadow contents are written by devices. Anyone with `iot:Publish` on `$aws/things/<name>/shadow/update` — a compromised device, a contractor, a misconfigured integration — chooses the bytes the model reads. This is tool-response injection, and it is the documented MCP attack with the highest reported success rate against the weakest detection.
3. **The blast radius is wider than intended.** The server reads more than the operator meant to expose, or one device's payload drains the whole context window.

## The five claims

### 1. No write path exists

Not "writes are disabled". There is no code that could write.

- `src/aws/iot.ts` is the only file importing the AWS SDK, and it imports only read commands. A conformance test greps that file for any `Create*`/`Update*`/`Delete*`/`Publish*`/`Attach*`… `Command` and fails if one appears.
- The port interfaces in `src/aws/ports.ts` declare no mutating method, so there is nothing for a tool to call. A test asserts that too.
- Every tool is registered through `assertReadOnlyTool`, which throws at **startup** if the tool does not declare `readOnlyHint: true`, or declares `destructiveHint: true`. Adding a write tool means deleting that guard, and deleting it fails the suite.

What this does not cover: the IAM identity you give the server. If you attach `AWSIoTFullAccess`, this server still will not write — but anything else using those credentials could. Use the minimal policy in [`iam-policy.json`](iam-policy.json).

### 2. Untrusted data cannot escape its fence

Every value that a device or a customer authored — shadow state, thing attributes, rule SQL, rule descriptions — crosses `src/domain/untrusted.ts` before it reaches a result. There it is:

1. **canonicalised** — object keys sorted, so the same payload always serialises to the same bytes (deterministic diffs, cache-friendly prefixes);
2. **stripped** of C0/C1 control characters, ANSI CSI/OSC escape sequences, and zero-width and bidirectional-override characters — the last of these being how a payload renders one way for a human reviewer and parses another way for a model;
3. **screened** for injection signals (see below);
4. **capped** in size;
5. **de-fenced** — the literal string `UNTRUSTED_DEVICE_DATA` inside a payload is escaped, so a device cannot close the fence from the inside and have the rest of its text read as operator input;
6. **wrapped** in a delimited block with a provenance header stating the source, the trust level, and any signals raised.

The server's own instructions, sent to the client at initialise, tell the model that the block is data and never instructions.

**Where this stops:** signal detection is a heuristic. The rules exist because each pattern appears in published attack write-ups, and a determined attacker will evade all of them. Signals are _reported_, never used to silently edit a payload, because hiding the attack from the operator is worse than showing it. The load-bearing guarantee is claim 1, not this one.

#### Signals

| Id                      | Pattern it looks for                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `instruction_override`  | "ignore/disregard/forget … previous/above … instructions"                |
| `role_injection`        | Conversation-role markup, or a leading `System:` / `Assistant:`          |
| `tool_directive`        | Text telling the assistant to call or invoke a tool, or tool-call markup |
| `credential_bait`       | AWS access-key shapes, `secret_access_key`, PEM private-key headers      |
| `markdown_exfiltration` | A remote image embed — the classic chat-UI exfiltration channel          |
| `shell_directive`       | `curl`/`wget`/`Invoke-WebRequest` pointed at a URL                       |
| `encoded_blob`          | A long opaque encoded run that hides its content from review             |

Signals appear in the fence header, in the tool text, and in the audit log. In `assess_fleet_health` they also become an `injection_signal` finding whose message says what an operator should actually do: review who can publish to that device's shadow.

### 3. One device cannot exhaust the context

- Untrusted text per result is capped (`AWS_IOT_MCP_MAX_UNTRUSTED_BYTES`, default 24 kB) and truncation is announced in the fence header with the original byte count. Truncation never splits a UTF-8 code point.
- Freshness tables render at most 25 rows, diffs at most 60, no matter how many fields a shadow has.
- List and search pages are clamped to `AWS_IOT_MCP_MAX_ITEMS`; fleet-health samples to `AWS_IOT_MCP_MAX_FLEET_SAMPLE`.
- The HTTP entry point caps request bodies at 4 MB.

### 4. Scope and allowlist deny by default

- When `AWS_IOT_MCP_THING_ALLOW` is set, any thing name outside those globs is refused **before** any AWS call. Globs are anchored, so `gw-*` does not match `other-gw-001`. A comparison is refused if either side is out of scope, and list and search results are filtered with a count of what was hidden — names outside the scope never appear in output.
- When `AWS_IOT_MCP_TOOLS` is set, unlisted tools are not registered at all: they are absent from `tools/list`, not merely refused.
- With neither set, the server reads whatever the IAM role can reach. That is a deliberate default for a read-only server, and it means **IAM remains the outer boundary** — this layer narrows, it does not replace.

### 5. Misconfiguration fails at startup, not per call

- A tool allowlist naming an unknown tool aborts startup and prints the known names, so a typo cannot silently produce a server with no tools.
- Incoherent thresholds are rejected: a critical staleness below the warning one, or a critical certificate window wider than the warning one. Otherwise a typo would quietly mean "nothing is ever stale", which is worse than a crash.
- A missing region aborts with an explanation, because IoT Core is regional and the wrong region looks exactly like an empty account.
- Any invalid value aborts rather than falling back to a default.

## Credentials

Credentials come only from the standard AWS chain: environment, shared profile, container or instance role. **No tool argument, request header or configuration field accepts a credential**, so no prompt can talk the server into using different ones.

The audit log never records credential-shaped argument values, and never records device payloads — only the signals those payloads raised.

## The minimal IAM policy

Twelve read actions. See [`iam-policy.json`](iam-policy.json).

```
iot:ListThings            iot:DescribeThing         iot:ListThingGroupsForThing
iot:SearchIndex           iot:GetIndexingConfiguration
iot:ListTopicRules        iot:GetTopicRule          iot:DescribeEndpoint
iot:ListThingPrincipals   iot:DescribeCertificate   iot:GetThingShadow
iot:ListNamedShadowsForThing
```

Scope them with resource ARNs if your fleet is partitioned. `iot:GetThingShadow` and `iot:ListNamedShadowsForThing` are data-plane actions; `iot:DescribeEndpoint` is needed once to discover the data endpoint.

## The HTTP transport does not authenticate

The stateless HTTP entry point binds to `127.0.0.1` by default and has no authentication of its own. It expects to sit behind API Gateway, an ALB with OIDC, or a service mesh. DNS-rebinding protection is enabled and each request gets a fresh server and transport with nothing shared between them — but **exposing it directly to a network is exposing read access to your fleet to that network**. [`DEPLOY.md`](DEPLOY.md) covers the options.

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md). Please do not open a public issue for a vulnerability report.
