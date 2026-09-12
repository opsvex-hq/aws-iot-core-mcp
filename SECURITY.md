# Security policy

## Reporting a vulnerability

Email **hola@opsvex.com** with `aws-iot-core-mcp` in the subject. Please do not open a public issue.

Include what you need to make the report actionable: the version, what you observed, and the smallest reproduction you have. If it is easier to show than to describe, a private repository or a patch is fine.

**What to expect.** An acknowledgement within **5 business days**. We are a two-person firm with a declared maintenance budget of 2–4 hours a month on this repository, so we will be honest about timing rather than promising an SLA we cannot hold. If a fix is going to take longer than that, we will say so and agree a disclosure date with you.

We will credit you in the changelog unless you prefer otherwise.

## Scope

In scope:

- A way to make this server **write to AWS** — the central claim of the project. See [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).
- A payload that **escapes the untrusted fence**, so device-authored text reaches a model as if it came from the operator.
- A way to read a thing **outside a configured `AWS_IOT_MCP_THING_ALLOW` scope**.
- Credential leakage: credentials reaching the audit log, tool output, or anywhere but the AWS SDK.
- Device payloads or personal data reaching the audit log.
- Resource exhaustion that the documented budgets should have prevented.

Out of scope, and documented as such:

- **The HTTP transport has no authentication.** It binds to localhost and expects an authenticating proxy. Reaching an intentionally exposed endpoint is not a vulnerability — see [`docs/DEPLOY.md`](docs/DEPLOY.md).
- **Injection-signal evasion.** The signals are heuristics, stated as such. A payload that carries an injection the heuristics miss is expected: the guarantee is that there is no write path, not that the filter is complete. A payload that _escapes the fence_ is a different matter and is in scope.
- Over-broad IAM you granted the server. IAM is the outer boundary; this server narrows it, it does not replace it.
- Vulnerabilities in AWS itself or in the MCP specification. Report those upstream.

## Supported versions

Pre-1.0: only the latest released version. There are no backports.

## Hardening checklist for operators

1. Use the [minimal IAM policy](docs/iam-policy.json), scoped to resource ARNs if your fleet is partitioned.
2. Set `AWS_IOT_MCP_THING_ALLOW` when the server is shared.
3. Set `AWS_IOT_MCP_TOOLS` to the tools that team actually needs.
4. Keep the audit log and ship it somewhere you read. Grep for `"signals"` — that is a device trying something.
5. Set `AWS_IOT_MCP_AUDIT_ARGS=off` if your retention policy is strict about argument values.
6. Do not expose the HTTP transport without an authenticating layer in front.
7. Run `--check` after any credential or region change.
