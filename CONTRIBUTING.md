# Contributing

Thanks for looking. Two things to know before you spend time on a change.

## What this project will and will not take

**Welcome:**

- Bug reports from a **real AWS account** — the single most valuable contribution, since every AWS interaction in the test suite is a fake.
- New read-only tools that answer an operational question.
- Better error translation: an AWS error whose message left you guessing is a bug.
- Fleet-index query recipes for `docs/TOOLS.md`.
- Injection signals seen in the wild.

**Will be declined:**

- **Any tool that writes, publishes, deletes or modifies AWS state.** See [ADR 0002](docs/adr/0002-read-only-by-construction.md). This is not negotiable and the test suite enforces it; a PR adding one fails CI before review.
- Remediation suggestions in tool output, including a printed `aws iot ...` command. Diagnose and stop.
- Authentication inside the HTTP transport. It composes with API Gateway or an OIDC proxy on purpose — see [ADR 0003](docs/adr/0003-untrusted-device-data.md).
- Dependencies. Four runtime packages is the budget. A PR that adds a fifth needs to argue for it.
- Support for non-AWS IoT platforms. Different server, different repository.

## Setup

```bash
npm install
npm run verify     # format + lint + typecheck + tests — run this before pushing
```

Node 20.19 or newer. No AWS account needed.

## The rules the code follows

1. **Tools depend on ports, never on the AWS SDK.** `src/aws/iot.ts` is the only file that may import `@aws-sdk/*`. This is what keeps the whole tool layer testable and the read-only guarantee auditable in one file.
2. **Every device-authored value goes through `sanitizeUntrusted` + `fenceUntrusted`**, and its signal ids are returned in `ToolOutcome.signals` so they reach the audit log.
3. **The clock is injected.** Use `ctx.now()`, never `Date.now()` inside a tool or a domain function.
4. **stdout belongs to the protocol.** Diagnostics go to stderr. A `console.log` in `src/` is a bug.
5. **Normalise units at the boundary.** AWS mixes `Date`, epoch seconds and epoch milliseconds across these APIs; the ports speak milliseconds and `src/aws/iot.ts` converts. Do not let a raw AWS date escape the adapter.
6. **Fail at startup, not per call.** A configuration or registration problem should abort with an explanation.
7. **Never render "unknown" as "ok".** If a signal could not be read, say so.

## Adding a tool

The checklist lives in [`docs/TESTING.md`](docs/TESTING.md#adding-a-tool). In short: declare `annotations: READ_ONLY`, depend on the ports, fence untrusted values, add it to the module's exported array, write a unit test plus an integration test through the harness, and document it in `docs/TOOLS.md` — the `tools/list` test fails if a tool has no description.

## Commits and PRs

- Conventional-ish prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) are appreciated, not enforced.
- One concern per PR. A PR that reformats while fixing a bug is hard to review.
- Say what you tested. "Ran against a fleet of 40 gateways in sa-east-1" is worth more than a paragraph of description.
- CI runs `npm run verify` on Node 20 and 22 plus a coverage gate. It must be green.

## Maintenance expectations

**2–4 hours per month**, and issues answered within **5 business days**. This is reference software maintained by a two-person firm, not a 24/7 supported product. If a PR sits, it is bandwidth, not disinterest — a nudge is fine.

If six months from now the repository has produced no real conversation, it gets frozen and marked as a portfolio piece. That is written down so nobody has to guess whether it is maintained.

## Security

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## License

Contributions are accepted under the MIT license of the project.
