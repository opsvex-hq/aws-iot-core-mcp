# Testing

```bash
npm test                 # 264 tests
npm run test:coverage    # with thresholds (85% across the board)
npm run test:watch
npm run verify           # format + lint + typecheck + tests — what CI runs
```

No AWS account, no credentials and no network are needed. If a test ever needs them, that is a bug in the test.

## Layout

| Suite           | Files                                 | What it proves                                                                                                                                                 |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | `tests/unit/*.test.ts`                | The pure logic: shadow semantics, health assessment, sanitisation, policy, config, rendering, error translation, and the AWS adapter against a fake SDK client |
| **Integration** | `tests/integration/tools.test.ts`     | Every tool end-to-end through a **real MCP client** over the in-memory transport                                                                               |
| **Conformance** | `tests/conformance/hardening.test.ts` | The claims in [SECURITY-MODEL.md](SECURITY-MODEL.md), one test per sentence                                                                                    |

### Why integration tests go through a real client

`InMemoryTransport.createLinkedPair()` connects an actual `Client` to an actual `McpServer`. The tests therefore exercise tool registration, JSON-schema validation and result serialisation exactly as a desktop client would. A unit test calling a handler directly would not notice a wrong schema, a missing required field, or an annotation that failed to reach `tools/list` — and those are the failures a user hits first.

One consequence worth knowing: **invalid arguments come back as an error result, not as a thrown exception.** The SDK validates against the schema and answers with `isError: true`; the handler is never reached. Tests assert on that shape.

### Why conformance is a separate suite

Those tests are not about behaviour, they are about promises. Keeping them in one file, ordered like the threat model, makes the answer to "is the read-only claim still true?" a single file to read. Two of them are **structural**: they read `src/aws/iot.ts` and `src/aws/ports.ts` as text and fail if a mutating command or method name appears. That catches a regression at the import line, before a tool is even written to use it.

## Fixtures

`tests/support/fakes.ts` holds the doubles:

- `FakeControlPort` / `FakeDataPort` implement the AWS ports in memory, record every call for assertions, and can be told to throw a named AWS error (`failures: { searchIndex: new AwsCallError('IndexNotReadyException') }`).
- `CapturingSink` collects audit lines so a test can assert on the audit trail.
- `createHarness()` wires client, server, fakes, a capturing audit sink and a **fixed clock** (`NOW_MS`, 2026-09-12T12:00:00Z) so every rendered age is deterministic.
- `shadowFixture()` builds shadow documents with metadata `ageSeconds` old.

The fixtures are deliberately faithful about two things that break naive implementations: AWS declares almost every field optional, and **shadow metadata timestamps are epoch seconds while connectivity is epoch milliseconds**. Fixtures use the real units, so a unit-mixing bug fails a test instead of shipping.

## Rules the suite follows

1. **The clock is injected.** `ToolContext.now` and the `nowMs` argument of every domain function. No test depends on when it runs.
2. **Assert on codes, not prose.** Finding codes (`shadow_stale`), policy codes (`thing_out_of_scope`) and signal ids (`instruction_override`) are the stable contract; the sentences around them are free to improve.
3. **Test the "we do not know" path.** For every signal there are three cases, not two: healthy, unhealthy, and unknown. `unknown` must never render as `ok` — a device whose certificate could not be read is not a device with a valid certificate.
4. **Error paths get the same weight as happy paths.** A malformed shadow, a missing shadow, a throttled call, an unready index and a denied permission are all covered, because in fleet operations they are the normal case.
5. **Regex for padded output.** `renderKeyValues` aligns values, so assert `/Things assessed:\s+2/`, not a fixed number of spaces.

## Adding a tool

1. Write it in `src/tools/`, declaring `annotations: READ_ONLY`. The registry will refuse anything else at startup.
2. Depend only on `IotControlPort` / `IotDataPort` — never on the AWS SDK. If you need a new AWS read, add the method to the port, implement it in the adapter, and extend `FakeControlPort`.
3. Run every device-authored value through `sanitizeUntrusted` + `fenceUntrusted`, and return the signal ids in `ToolOutcome.signals` so they reach the audit log.
4. Add the tool to the array exported by its module, which `ALL_TOOLS` picks up.
5. Tests: a unit test per pure helper, an integration test through the harness, and a conformance test if the tool touches untrusted data or scope.
6. Document it in [TOOLS.md](TOOLS.md). The `tools/list` test asserts every tool has a non-empty description; the docs are not optional.

## Coverage

Thresholds are 85% for statements, branches, functions and lines. Current: statements 97%, branches 88%.

Excluded: `src/index.ts` and `src/http.ts` (entry-point wiring, exercised by the CLI smoke test below) and `src/aws/clients.ts` (constructs real AWS clients). Everything else is in scope, including the adapter.

Coverage is a floor, not a goal. The conformance suite matters more than the percentage.

## Manual smoke test

Against a real account, after any change to configuration or the adapter:

```bash
npm run build
node dist/index.js --version
node dist/index.js --list-tools                     # honours the allowlist
AWS_REGION=us-east-1 node dist/index.js --check     # real credentials, one ListThings call
node dist/index.js --list-tools                     # with no AWS_REGION: must exit 2 with an explanation
```

`--check` is the only thing in the repository that talks to AWS. Reports from real fleets are the most valuable issue anyone can file — see the Validation status table in the README for what is and is not proven.

## Lint choices

`oxlint` runs with `correctness` and `suspicious` as errors. Two rules are turned off on purpose:

- **`no-await-in-loop`** — `assess_fleet_health` and the certificate reader await inside loops deliberately. Fanning out with `Promise.all` across a fleet is the fastest way to get throttled by the IoT control plane, and a throttled sweep returns worse data than a slower one.
- **`prefer-set-has`** — the array it flags is iterated, not searched.

`no-control-regex` is off for tests only: the conformance suite matches control characters on purpose.
