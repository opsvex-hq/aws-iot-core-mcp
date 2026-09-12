# ADR 0002 — Read-only by construction, not by configuration

**Status:** accepted · **Date:** 2026-09-12

## Context

The obvious design for an IoT MCP server is to expose the API surface and gate the dangerous half behind a flag: `ALLOW_WRITES=false` by default, tool annotations marking what mutates, maybe a confirmation prompt.

We rejected that, for three reasons.

1. **A flag is a promise; absent code is a fact.** "Writes are disabled by default" invites the question "what happens when someone flips it, or when a bug flips it?". There is no good answer.
2. **The write operations here are physical.** Publishing to an IoT topic can move a vehicle, open a valve or reboot a gateway in the field. The blast radius of a confused tool call is not a database row.
3. **The only reference implementation we found that publishes its own accuracy figures** takes exactly this stance: its agent diagnoses and opens a proposal for a human, and never writes to the live system. It publishes hit rate, cost and latency, and lists the adversarial cases where it must abstain. That is the standard worth copying.

## Decision

There is no write path in the codebase, enforced at three levels:

1. **Imports.** `src/aws/iot.ts` is the only file importing the AWS SDK and imports only read commands. A conformance test reads that file as text and fails if any mutating `*Command` name appears.
2. **Interfaces.** The ports in `src/aws/ports.ts` declare no mutating method, so a tool has nothing to call. A test asserts this too.
3. **Registration.** Every tool goes through `assertReadOnlyTool`, which throws at startup unless the tool declares `readOnlyHint: true` and does not declare `destructiveHint: true`.

The diagnostic tool also refuses to _prescribe_: `assess_fleet_health` reports findings and stops. It does not print a remediation command, because a tool that both diagnoses and repairs is not one you can safely hand to an autonomous agent, and a suggested `aws iot ...` line in the output is a remediation an agent can copy.

## Consequences

**Good.** The strongest claim in the README is structurally true, and it is asserted by tests rather than promised by prose. Adoption is easier: granting read-only IAM to an AI tool is a conversation an operations team can have; granting write is not. The threat model shrinks to "what can be read", which is where the fence and the scope controls apply.

**Bad.** Users will ask for write tools — rotating a certificate, pushing a desired state — and the answer is no. That is a real limit on usefulness, accepted deliberately. The honest response is that writes belong in a separate, differently-named, differently-permissioned tool that a human approves, not in this one.

**Note.** This makes the enterprise side of the open-core split cleaner rather than harder: the fleet console that _does_ act is a different product with a different trust model, not a flag on this one.
