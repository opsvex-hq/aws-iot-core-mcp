# Tool reference

Twelve tools, all read-only, all annotated `readOnlyHint: true` and `destructiveHint: false`.

Conventions used throughout:

- Arguments are `snake_case`; optional unless marked **required**.
- Any argument named `thing_name` is checked against `AWS_IOT_MCP_THING_ALLOW` before an AWS call is made. Out of scope means refused, with no API call at all.
- `max_results` is a _request_, not a guarantee: the server clamps it to `AWS_IOT_MCP_MAX_ITEMS`.
- Anything a device or a customer wrote comes back inside an untrusted fence. See [SECURITY-MODEL.md](SECURITY-MODEL.md).
- Output is plain aligned text. It is designed to be equally readable by a model and by a human scrolling a transcript, and to diff cleanly between two calls.

---

## `assess_fleet_health`

The one to reach for when the question is vague. One call, one ranked answer.

| Argument               | Type     | Notes                                                                  |
| ---------------------- | -------- | ---------------------------------------------------------------------- |
| `thing_names`          | string[] | Explicit things. **Exactly one of** this or `query`                    |
| `query`                | string   | Fleet-index query selecting the sample                                 |
| `max_things`           | number   | Sample ceiling, clamped by `AWS_IOT_MCP_MAX_FLEET_SAMPLE` (default 25) |
| `shadow_name`          | string   | Inspect a named shadow instead of the classic one                      |
| `include_certificates` | boolean  | Default `true`. Costs 1–2 extra API calls per thing                    |

For each thing it gathers shadow freshness, desired-vs-reported convergence, certificate status and expiry, and connectivity (only via `query`, since connectivity comes from the fleet index). Then it maps facts to findings:

| Finding code               | Severity        | Raised when                                                    |
| -------------------------- | --------------- | -------------------------------------------------------------- |
| `shadow_stale`             | warn / critical | Oldest reported field older than the warn / critical threshold |
| `shadow_drift`             | warn            | Desired fields the device has not converged on                 |
| `shadow_unreadable`        | warn            | Shadow could not be read or parsed                             |
| `shadow_without_metadata`  | unknown         | No reported-field timestamps, so freshness is unknowable       |
| `shadow_not_checked`       | unknown         | The shadow was not inspected                                   |
| `certificate_expired`      | critical        | Expiry already passed                                          |
| `certificate_expiring`     | warn / critical | Inside the warn / critical window                              |
| `certificate_not_active`   | warn / critical | `INACTIVE` is a warning, `REVOKED` is critical                 |
| `no_certificates`          | warn            | Thing has no certificate principal                             |
| `certificates_not_checked` | unknown         | Certificates were not inspected                                |
| `disconnected`             | warn            | Fleet index reports the device disconnected                    |
| `injection_signal`         | warn            | The device payload raised an injection signal                  |

A device's severity is the worst of its findings. `unknown` sits between `ok` and `warn` on purpose: "we could not tell" must never render as "fine".

```
Things assessed:         2
Critical:                1
Warning:                 0
Unknown:                 0
Healthy:                 1
Shadow inspected:        (classic)
Certificates inspected:  yes
Thresholds:              stale warn 3600s / critical 86400s; cert warn 45d / critical 14d

Per device:
SEVERITY  THING   FINDINGS
--------  ------  ---------------------------------------
CRITICAL  gw-001  shadow_stale, certificate_expiring
OK        gw-002

Findings by code:
CODE                  DEVICES  WORST SEVERITY
--------------------  -------  --------------
shadow_stale          1        critical
certificate_expiring  1        critical

Detail:
gw-001 [critical]
  - critical: Oldest reported field is 2d 7h old (critical at 1d).
  - critical: Certificate cccccccccccc expires in 5 day(s).
```

Partial failure is expected at fleet scale: one unreadable shadow becomes a `shadow_unreadable` finding on that device, and the report still comes back.

---

## `get_device_shadow`

| Argument      | Type    | Notes                                 |
| ------------- | ------- | ------------------------------------- |
| `thing_name`  | string  | **required**                          |
| `shadow_name` | string  | Omit for the classic (unnamed) shadow |
| `include_raw` | boolean | Default `true`                        |

Returns a summary, per-field freshness (oldest first, capped at 25 rows), the desired-vs-reported table, and the raw document fenced.

A thing with no shadow is **not** an error — it gets a plain explanation and a pointer to `list_named_shadows`, because a thing only has a shadow once something writes one. A malformed shadow is returned as data with the parse error, because a device writing broken JSON is exactly what an operator needs to see.

Freshness comes from `metadata.reported.<field>.timestamp`, which AWS reports in epoch **seconds**. A shadow with no metadata reports `metadataMissing` rather than guessing.

---

## `compare_device_shadows`

| Argument                                 | Type                    | Notes                 |
| ---------------------------------------- | ----------------------- | --------------------- |
| `left_thing_name`                        | string                  | **required**          |
| `right_thing_name`                       | string                  | **required**          |
| `left_shadow_name` / `right_shadow_name` | string                  | Compare named shadows |
| `section`                                | `reported` \| `desired` | Default `reported`    |

Structural diff of only the fields that differ, up to 60 rows, sorted by path. Object key order is irrelevant; array order is significant, because for a shadow the order is data. `1` and `"1"` are reported as different — a type change in telemetry is a real incident.

Each cell is sanitised individually, so one hostile field cannot break the table or smuggle a delimiter into a neighbouring column.

---

## `search_fleet_index`

| Argument      | Type   | Notes                                  |
| ------------- | ------ | -------------------------------------- |
| `query`       | string | **required**. Fleet-index query syntax |
| `max_results` | number | Clamped by policy                      |
| `next_token`  | string | Pagination                             |

Useful queries:

```
connectivity.connected:false          # everything offline right now
thingName:gw-*                        # by name prefix
attributes.site:santiago              # by registry attribute
shadow.reported.firmware:1.2.3        # by shadow content (needs shadow indexing)
thingTypeName:gateway AND connectivity.connected:false
```

When every match reports unknown connectivity, the tool says so and names the fix (`thingConnectivityIndexingMode=STATUS`) instead of leaving a column of blanks. If the index is not ready, the error says _not ready_ and marks it retryable — distinct from "no matches", which is the distinction that matters at 2 a.m.

---

## `list_things` / `describe_thing`

`list_things` takes `max_results`, `next_token`, `thing_type_name`, `attribute_name`, `attribute_value`.

`attribute_name` and `attribute_value` must be given **together**. AWS silently ignores a half-specified attribute filter and returns the whole fleet; this tool refuses instead, without calling AWS.

`describe_thing` takes `thing_name` (**required**) and `include_groups` (default `true`). Attributes come back fenced — any principal with `iot:UpdateThing` can write them.

---

## `list_named_shadows`

`thing_name` (**required**). AWS never lists the classic shadow here; read it with `get_device_shadow` and no `shadow_name`.

---

## `list_topic_rules` / `describe_topic_rule`

`list_topic_rules` takes `max_results` and `next_token`, and calls out disabled rules explicitly — a disabled rule silently drops matching messages.

`describe_topic_rule` takes `rule_name` (**required**) and returns the SQL (fenced), the SQL version, every action with its destination, and the error action. **A rule with no error action loses messages without a trace when its action fails**, and the tool says so every time.

Action targets prefer the destination over the IAM role: for `republish` you get the topic, for `kinesis` the stream. The role is incidental to "where does this data go?".

---

## `describe_iot_endpoint`

`endpoint_type`, one of `iot:Data-ATS` (default), `iot:Jobs`, `iot:CredentialProvider`, `iot:Data`. Endpoints are per account _and_ per region, which is the usual cause of "the device connects but nothing arrives".

---

## `inspect_thing_certificates`

`thing_name` (**required**). Lists attached certificates with status, expiry and days remaining, then the findings.

A certificate whose expiry cannot be read (usually a missing `iot:DescribeCertificate` permission) is reported as **unknown**, never as healthy. Principals that are not certificates — a Cognito identity, for instance — are ignored rather than mis-reported.

---

## `describe_indexing_configuration`

No arguments. Reports registry, connectivity and named-shadow indexing modes. Call it first whenever `search_fleet_index` returns nothing: it separates "no matches" from "not indexed", and an absent mode is reported as `OFF` rather than as unknown.

---

## Errors

Every AWS failure is translated to a stable code, a sentence, and — where one exists — the operator action that fixes it.

| AWS error                                         | What the tool says                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ResourceNotFoundException`                       | Does not exist in this account and region; check the region                                 |
| `UnauthorizedException` / `AccessDeniedException` | Names the missing read action to grant                                                      |
| `IndexNotReadyException`                          | The index is still building; retryable                                                      |
| `InvalidQueryException`                           | Points at the `attributes.<name>:<value>` syntax                                            |
| `ThrottlingException`                             | Suggests a smaller page or sample; retryable                                                |
| anything unknown                                  | Passed through **with its AWS name intact** — an unfamiliar error is information, not noise |

Policy refusals are distinct from AWS errors: they come back as `Refused by server policy (thing_out_of_scope)` and are logged with `outcome: denied`.

## Audit log

One JSON object per line on stderr (never stdout — that is the protocol channel on stdio):

```json
{
  "ts": "2026-09-12T18:22:31.004Z",
  "tool": "get_device_shadow",
  "outcome": "ok",
  "durationMs": 128,
  "region": "us-east-1",
  "args": { "thing_name": "gw-001" },
  "signals": ["instruction_override"]
}
```

Arguments are redacted before logging: credential-shaped keys become `[redacted]`, long strings are truncated, and objects and arrays are replaced by a shape marker (`[array:3]`) so no device payload or PII reaches the log. Set `AWS_IOT_MCP_AUDIT_ARGS=off` to drop arguments entirely.
