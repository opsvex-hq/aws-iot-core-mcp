# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0 onward.
Before 1.0, tool names and output format may change in a minor release.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-09-12

First release. Not yet exercised against a live AWS account — see the
Validation status table in the README before trusting it in production.

### Added

- **Twelve read-only tools** over AWS IoT Core: `list_things`, `describe_thing`,
  `search_fleet_index`, `describe_indexing_configuration`, `get_device_shadow`,
  `list_named_shadows`, `compare_device_shadows`, `list_topic_rules`,
  `describe_topic_rule`, `describe_iot_endpoint`, `inspect_thing_certificates`
  and `assess_fleet_health`.
- **`assess_fleet_health`**: one call that combines shadow freshness,
  desired-vs-reported convergence, certificate status and expiry, and
  connectivity, returning findings ranked worst-first with a per-code summary.
  Diagnoses only; it never prescribes a mutating action.
- **Read-only by construction**: the AWS adapter imports only read commands,
  the ports declare no mutating method, and tool registration refuses anything
  not annotated `readOnlyHint: true`. All three are asserted by the conformance
  suite, two of them structurally against the source text.
- **Untrusted-data boundary** for everything a device or customer authored:
  canonicalisation, control- and bidi-character stripping, injection-signal
  screening, size caps, fence-delimiter neutralisation, and a provenance header.
- **Deny-by-default scoping**: `AWS_IOT_MCP_THING_ALLOW` globs refuse
  out-of-scope things before any AWS call and hide them from list and search
  output; `AWS_IOT_MCP_TOOLS` leaves unlisted tools unregistered.
- **Audit trail**: one JSON line per call on stderr with outcome, duration,
  redacted arguments and any injection signals raised.
- **Startup validation**: unknown tool in the allowlist, incoherent thresholds,
  a missing region or any invalid value aborts with an explanation instead of
  failing per call.
- **Two transports**: stdio, and a stateless streamable-HTTP entry point with
  DNS-rebinding protection and a 4 MB body cap.
- **CLI**: `--help`, `--version`, `--list-tools`, and `--check` to validate
  configuration and credentials against a real account.
- **Documentation**: tool reference, security model, testing guide, deployment
  guide, three ADRs, a minimal IAM policy, and a full Spanish guide.
- **264 tests** across unit, integration (through a real MCP client over the
  in-memory transport) and conformance suites.

[Unreleased]: https://github.com/opsvex-hq/aws-iot-core-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/opsvex-hq/aws-iot-core-mcp/releases/tag/v0.1.0
