/**
 * End-to-end through a real MCP client over the in-memory transport.
 *
 * These tests go through tool registration, JSON-schema validation and result
 * serialisation exactly as a desktop client would, with fake AWS ports
 * underneath. If a tool's schema is wrong, this suite fails; a unit test on the
 * handler would not notice.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
    AwsCallError,
    DAY,
    FakeControlPort,
    FakeDataPort,
    HOUR,
    NOW_MS,
    createHarness,
    resultText,
    shadowFixture,
    type Harness,
} from '../support/fakes.js';

let harness: Harness | undefined;

afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

describe('tool listing', () => {
    it('advertises every tool as read-only and non-destructive', async () => {
        harness = await createHarness();
        const { tools } = await harness.client.listTools();

        expect(tools.length).toBeGreaterThanOrEqual(11);
        for (const tool of tools) {
            expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
            expect(tool.annotations?.destructiveHint, `${tool.name} must not be destructive`).toBe(false);
            expect(tool.description ?? '', `${tool.name} needs a description`).not.toBe('');
        }
    });

    it('exposes no tool whose name suggests mutation', async () => {
        harness = await createHarness();
        const { tools } = await harness.client.listTools();
        const mutating = tools.filter((tool) =>
            /^(publish|update|delete|create|set|write|attach|detach|reject|accept)_/.test(tool.name),
        );
        expect(mutating.map((tool) => tool.name)).toEqual([]);
    });

    it('honours the tool allowlist', async () => {
        harness = await createHarness({ config: { enabledTools: ['list_things', 'describe_thing'] } });
        const { tools } = await harness.client.listTools();
        expect(tools.map((tool) => tool.name).toSorted()).toEqual(['describe_thing', 'list_things']);
    });
});

describe('list_things', () => {
    it('renders a table of things', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                things: [
                    { thingName: 'gw-001', thingTypeName: 'gateway', version: 3 },
                    { thingName: 'gw-002' },
                ],
            }),
        });

        const text = resultText(await harness.client.callTool({ name: 'list_things', arguments: {} }));
        expect(text).toContain('gw-001');
        expect(text).toContain('gateway');
        // A thing without a type must render as a dash, not as "undefined".
        expect(text).not.toContain('undefined');
        expect(text).toContain('2 item(s); no further pages.');
    });

    it('refuses a half-specified attribute filter instead of returning the whole fleet', async () => {
        harness = await createHarness({
            control: new FakeControlPort({ things: [{ thingName: 'gw-001' }] }),
        });

        const text = resultText(
            await harness.client.callTool({ name: 'list_things', arguments: { attribute_name: 'site' } }),
        );
        expect(text).toContain('must be provided together');
        expect(harness.control.calls).toHaveLength(0);
    });

    it('applies the attribute filter when both halves are present', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                things: [
                    { thingName: 'gw-001', attributes: { site: 'santiago' } },
                    { thingName: 'gw-002', attributes: { site: 'lima' } },
                ],
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'list_things',
                arguments: { attribute_name: 'site', attribute_value: 'santiago' },
            }),
        );
        expect(text).toContain('gw-001');
        expect(text).not.toContain('gw-002');
    });

    it('hides things outside the configured scope and says how many', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                things: [{ thingName: 'gw-001' }, { thingName: 'prod-db' }],
            }),
            config: { thingAllow: ['gw-*'] },
        });

        const text = resultText(await harness.client.callTool({ name: 'list_things', arguments: {} }));
        expect(text).toContain('gw-001');
        expect(text).not.toContain('prod-db');
        expect(text).toContain('1 thing(s) hidden by the configured scope.');
    });

    it('clamps an over-large page request to the policy ceiling', async () => {
        harness = await createHarness({
            control: new FakeControlPort({ things: [] }),
            config: { maxItemsPerCall: 10 },
        });

        await harness.client.callTool({ name: 'list_things', arguments: { max_results: 200 } });
        expect(harness.control.calls[0]?.input).toMatchObject({ maxResults: 10 });
    });

    it('offers the pagination token when AWS reports more pages', async () => {
        harness = await createHarness({
            control: new FakeControlPort({ things: [{ thingName: 'gw-001' }], nextToken: 'NEXT-1' }),
        });

        const text = resultText(await harness.client.callTool({ name: 'list_things', arguments: {} }));
        expect(text).toContain('NEXT-1');
    });
});

describe('describe_thing', () => {
    it('returns registry detail and fences the attributes', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                thingDetails: {
                    'gw-001': {
                        thingName: 'gw-001',
                        thingArn: 'arn:aws:iot:us-east-1:111:thing/gw-001',
                        thingTypeName: 'gateway',
                        attributes: { site: 'santiago' },
                        version: 4,
                    },
                },
                thingGroups: { 'gw-001': ['fleet-cl'] },
            }),
        });

        const text = resultText(
            await harness.client.callTool({ name: 'describe_thing', arguments: { thing_name: 'gw-001' } }),
        );
        expect(text).toContain('arn:aws:iot:us-east-1:111:thing/gw-001');
        expect(text).toContain('fleet-cl');
        expect(text).toContain('<<<UNTRUSTED_DEVICE_DATA');
        expect(text).toContain('santiago');
    });

    it('refuses a thing outside the scope, as an error result', async () => {
        harness = await createHarness({ config: { thingAllow: ['gw-*'] } });

        const result = await harness.client.callTool({
            name: 'describe_thing',
            arguments: { thing_name: 'prod-db' },
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain('thing_out_of_scope');
        expect(harness.control.calls).toHaveLength(0);
    });

    it('maps an AWS not-found into an explained error', async () => {
        harness = await createHarness({ control: new FakeControlPort({ thingDetails: {} }) });

        const result = await harness.client.callTool({
            name: 'describe_thing',
            arguments: { thing_name: 'ghost' },
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain('ResourceNotFoundException');
        expect(resultText(result)).toContain('right region');
    });

    it('rejects a missing required argument at the protocol level', async () => {
        harness = await createHarness();

        // The SDK validates against the tool's JSON schema and answers with an
        // error result rather than throwing, so the handler is never reached.
        const result = await harness.client.callTool({ name: 'describe_thing', arguments: {} });
        expect(result.isError).toBe(true);
        expect(resultText(result).toLowerCase()).toContain('thing_name');
        expect(harness.control.calls).toHaveLength(0);
    });
});

describe('get_device_shadow', () => {
    it('reports freshness and drift before the raw document', async () => {
        harness = await createHarness({
            data: new FakeDataPort({
                shadows: {
                    'gw-001': shadowFixture({
                        reported: { firmware: '1.2.3' },
                        desired: { firmware: '2.0.0' },
                        ageSeconds: 7_200,
                    }),
                },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'get_device_shadow',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toMatch(/Oldest reported field:\s+2h/);
        expect(text).toMatch(/Fields not converged:\s+1/);
        expect(text).toContain('2.0.0');
        expect(text.indexOf('Reported-field freshness')).toBeLessThan(text.indexOf('Raw document'));
    });

    it('explains a thing without a shadow instead of erroring', async () => {
        harness = await createHarness({ data: new FakeDataPort({ shadows: {} }) });

        const result = await harness.client.callTool({
            name: 'get_device_shadow',
            arguments: { thing_name: 'gw-001' },
        });
        expect(result.isError).toBeFalsy();
        expect(resultText(result)).toContain('has no classic shadow');
        expect(resultText(result)).toContain('list_named_shadows');
    });

    it('names the shadow in the not-found message when one was requested', async () => {
        harness = await createHarness({ data: new FakeDataPort({ shadows: {} }) });
        const text = resultText(
            await harness.client.callTool({
                name: 'get_device_shadow',
                arguments: { thing_name: 'gw-001', shadow_name: 'telemetry' },
            }),
        );
        expect(text).toContain('shadow "telemetry"');
    });

    it('says so when the shadow carries no metadata', async () => {
        harness = await createHarness({
            data: new FakeDataPort({
                shadows: { 'gw-001': shadowFixture({ withMetadata: false }) },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'get_device_shadow',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toContain('no reported-field timestamps');
    });

    it('surfaces a malformed shadow as data, not as a crash', async () => {
        harness = await createHarness({
            data: new FakeDataPort({ shadows: { 'gw-001': '{not-json' } }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'get_device_shadow',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toContain('could not be parsed');
        expect(text).toContain('<<<UNTRUSTED_DEVICE_DATA');
    });

    it('omits the raw document when asked to', async () => {
        harness = await createHarness({
            data: new FakeDataPort({ shadows: { 'gw-001': shadowFixture({}) } }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'get_device_shadow',
                arguments: { thing_name: 'gw-001', include_raw: false },
            }),
        );
        expect(text).not.toContain('Raw document');
    });
});

describe('compare_device_shadows', () => {
    it('lists only the fields that differ', async () => {
        harness = await createHarness({
            data: new FakeDataPort({
                shadows: {
                    'gw-001': shadowFixture({ reported: { firmware: '1.2.3', region: 'cl' } }),
                    'gw-002': shadowFixture({ reported: { firmware: '2.0.0', region: 'cl' } }),
                },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'compare_device_shadows',
                arguments: { left_thing_name: 'gw-001', right_thing_name: 'gw-002' },
            }),
        );
        expect(text).toContain('Differences: 1');
        expect(text).toContain('firmware');
        expect(text).not.toMatch(/^region/m);
    });

    it('can compare the desired half instead', async () => {
        harness = await createHarness({
            data: new FakeDataPort({
                shadows: {
                    'gw-001': shadowFixture({ desired: { mode: 'a' } }),
                    'gw-002': shadowFixture({ desired: { mode: 'b' } }),
                },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'compare_device_shadows',
                arguments: {
                    left_thing_name: 'gw-001',
                    right_thing_name: 'gw-002',
                    section: 'desired',
                },
            }),
        );
        expect(text).toMatch(/Comparing:\s+state\.desired/);
        expect(text).toContain('mode');
    });

    it('reports identical shadows plainly', async () => {
        const same = shadowFixture({ reported: { firmware: '1.2.3' } });
        harness = await createHarness({
            data: new FakeDataPort({ shadows: { 'gw-001': same, 'gw-002': same } }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'compare_device_shadows',
                arguments: { left_thing_name: 'gw-001', right_thing_name: 'gw-002' },
            }),
        );
        expect(text).toContain('No differences in state.reported');
    });
});

describe('topic rules and endpoints', () => {
    it('flags disabled rules in the listing', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                rules: [
                    { ruleName: 'to_kinesis', topicPattern: 'telemetry/#' },
                    { ruleName: 'old_rule', ruleDisabled: true },
                ],
            }),
        });

        const text = resultText(await harness.client.callTool({ name: 'list_topic_rules', arguments: {} }));
        expect(text).toContain('DISABLED');
        expect(text).toContain('silently drops matching messages');
    });

    it('calls out a rule with no error action', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                ruleDetails: {
                    to_kinesis: {
                        ruleName: 'to_kinesis',
                        sql: "SELECT * FROM 'telemetry/#'",
                        actions: [{ type: 'kinesis', target: 'arn:aws:kinesis:...:stream/telemetry' }],
                    },
                },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'describe_topic_rule',
                arguments: { rule_name: 'to_kinesis' },
            }),
        );
        expect(text).toContain('dropped without a trace');
        expect(text).toContain('kinesis');
        expect(text).toContain('<<<UNTRUSTED_DEVICE_DATA');
    });

    it('warns when a rule has no actions at all', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                ruleDetails: { empty: { ruleName: 'empty', actions: [] } },
            }),
        });

        const text = resultText(
            await harness.client.callTool({ name: 'describe_topic_rule', arguments: { rule_name: 'empty' } }),
        );
        expect(text).toContain('matching messages go nowhere');
    });

    it('resolves the data endpoint by default', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                endpoints: { 'iot:Data-ATS': 'xyz-ats.iot.sa-east-1.amazonaws.com' },
            }),
        });

        const text = resultText(
            await harness.client.callTool({ name: 'describe_iot_endpoint', arguments: {} }),
        );
        expect(text).toContain('iot:Data-ATS');
        expect(text).toContain('xyz-ats.iot.sa-east-1.amazonaws.com');
    });

    it('rejects an endpoint type outside the enum', async () => {
        harness = await createHarness();

        const result = await harness.client.callTool({
            name: 'describe_iot_endpoint',
            arguments: { endpoint_type: 'iot:Whatever' },
        });
        expect(result.isError).toBe(true);
        expect(harness.control.calls).toHaveLength(0);
    });
});

describe('fleet index', () => {
    it('reports connectivity when the index provides it', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                indexed: [
                    {
                        thingName: 'gw-001',
                        connectivity: {
                            connected: false,
                            timestampMs: NOW_MS - 3 * HOUR,
                            disconnectReason: 'CONNECTION_LOST',
                        },
                    },
                ],
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'search_fleet_index',
                arguments: { query: 'connectivity.connected:false' },
            }),
        );
        expect(text).toContain('gw-001');
        expect(text).toContain('CONNECTION_LOST');
        expect(text).toContain('false');
    });

    it('explains unknown connectivity as a configuration gap', async () => {
        harness = await createHarness({
            control: new FakeControlPort({ indexed: [{ thingName: 'gw-001' }] }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'search_fleet_index',
                arguments: { query: 'thingName:*' },
            }),
        );
        expect(text).toContain('connectivity indexing is');
        expect(text).toContain('thingConnectivityIndexingMode=STATUS');
    });

    it('distinguishes "not indexed" from "no matches"', async () => {
        harness = await createHarness({
            control: new FakeControlPort({ indexing: { thingIndexingMode: 'OFF' } }),
        });

        const text = resultText(
            await harness.client.callTool({ name: 'describe_indexing_configuration', arguments: {} }),
        );
        expect(text).toContain('Fleet indexing is off');
    });

    it('explains an unready index rather than reporting an empty fleet', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                failures: { searchIndex: new AwsCallError('IndexNotReadyException') },
            }),
        });

        const result = await harness.client.callTool({
            name: 'search_fleet_index',
            arguments: { query: 'thingName:*' },
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain('not ready');
        expect(resultText(result)).toContain('transient');
    });
});

describe('certificates', () => {
    it('flags an expiring certificate with days left', async () => {
        const certificateId = 'a'.repeat(64);
        harness = await createHarness({
            control: new FakeControlPort({
                principals: { 'gw-001': [`arn:aws:iot:us-east-1:111:cert/${certificateId}`] },
                certificates: {
                    [certificateId]: {
                        certificateId,
                        status: 'ACTIVE',
                        notAfterMs: NOW_MS + 10 * DAY,
                    },
                },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'inspect_thing_certificates',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toContain('ACTIVE');
        expect(text).toContain('10');
        expect(text).toContain('certificate_expiring');
    });

    it('says the thing has no certificate when it has none', async () => {
        harness = await createHarness({ control: new FakeControlPort({ principals: { 'gw-001': [] } }) });

        const text = resultText(
            await harness.client.callTool({
                name: 'inspect_thing_certificates',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toContain('no certificate principal attached');
    });

    it('ignores principals that are not certificates', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                principals: { 'gw-001': ['arn:aws:cognito-identity:us-east-1:111:id/abc'] },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'inspect_thing_certificates',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toContain('no certificate principal attached');
    });

    it('records a certificate it cannot describe as unknown, not as healthy', async () => {
        const certificateId = 'b'.repeat(64);
        harness = await createHarness({
            control: new FakeControlPort({
                principals: { 'gw-001': [`arn:aws:iot:us-east-1:111:cert/${certificateId}`] },
                certificates: {},
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'inspect_thing_certificates',
                arguments: { thing_name: 'gw-001' },
            }),
        );
        expect(text).toContain('unknown');
    });
});

describe('assess_fleet_health', () => {
    it('requires exactly one of thing_names or query', async () => {
        harness = await createHarness();

        const neither = resultText(
            await harness.client.callTool({ name: 'assess_fleet_health', arguments: {} }),
        );
        expect(neither).toContain('exactly one');

        const both = resultText(
            await harness.client.callTool({
                name: 'assess_fleet_health',
                arguments: { thing_names: ['gw-001'], query: 'thingName:*' },
            }),
        );
        expect(both).toContain('exactly one');
    });

    it('ranks devices worst-first and summarises findings by code', async () => {
        const expiring = 'c'.repeat(64);
        harness = await createHarness({
            control: new FakeControlPort({
                principals: {
                    'gw-001': [`arn:aws:iot:us-east-1:111:cert/${expiring}`],
                    'gw-002': [`arn:aws:iot:us-east-1:111:cert/${expiring}`],
                },
                certificates: {
                    [expiring]: { certificateId: expiring, status: 'ACTIVE', notAfterMs: NOW_MS + 5 * DAY },
                },
            }),
            data: new FakeDataPort({
                shadows: {
                    'gw-001': shadowFixture({ ageSeconds: 200_000 }),
                    'gw-002': shadowFixture({ ageSeconds: 30 }),
                },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'assess_fleet_health',
                arguments: { thing_names: ['gw-002', 'gw-001'] },
            }),
        );

        expect(text).toMatch(/Things assessed:\s+2/);
        expect(text).toContain('certificate_expiring');
        expect(text).toContain('shadow_stale');
        // gw-001 is critical on two counts, so it must be listed first.
        expect(text.indexOf('gw-001')).toBeLessThan(text.indexOf('gw-002'));
        expect(text).toContain('stale warn 3600s');
    });

    it('takes candidates from a fleet-index query and keeps their connectivity', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                indexed: [
                    {
                        thingName: 'gw-009',
                        connectivity: { connected: false, timestampMs: NOW_MS - 2 * HOUR },
                    },
                ],
            }),
            data: new FakeDataPort({ shadows: { 'gw-009': shadowFixture({ ageSeconds: 60 }) } }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'assess_fleet_health',
                arguments: { query: 'thingName:gw-*', include_certificates: false },
            }),
        );
        expect(text).toContain('disconnected');
        expect(text).toMatch(/Certificates inspected:\s+no/);
    });

    it('turns one unreadable shadow into a finding without sinking the report', async () => {
        harness = await createHarness({
            data: new FakeDataPort({
                shadows: { 'gw-001': shadowFixture({ ageSeconds: 30 }) },
            }),
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'assess_fleet_health',
                arguments: { thing_names: ['gw-001', 'gw-404'], include_certificates: false },
            }),
        );
        expect(text).toMatch(/Things assessed:\s+2/);
        expect(text).toContain('shadow_unreadable');
    });

    it('clamps the sample to the policy ceiling', async () => {
        harness = await createHarness({
            data: new FakeDataPort({ shadows: {} }),
            config: { maxFleetSample: 2 },
        });

        const text = resultText(
            await harness.client.callTool({
                name: 'assess_fleet_health',
                arguments: {
                    thing_names: ['a', 'b', 'c', 'd'],
                    include_certificates: false,
                    max_things: 4,
                },
            }),
        );
        expect(text).toMatch(/Things assessed:\s+2/);
    });

    it('says so when every candidate is out of scope', async () => {
        harness = await createHarness({ config: { thingAllow: ['gw-*'] } });

        const text = resultText(
            await harness.client.callTool({
                name: 'assess_fleet_health',
                arguments: { thing_names: ['prod-db'] },
            }),
        );
        expect(text).toContain('No things to assess');
        expect(text).toContain('outside the configured scope');
    });
});

describe('audit trail', () => {
    it('records one line per call with outcome and duration', async () => {
        harness = await createHarness({
            control: new FakeControlPort({ things: [{ thingName: 'gw-001' }] }),
        });

        await harness.client.callTool({ name: 'list_things', arguments: { max_results: 5 } });
        const events = harness.audit.events();

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            tool: 'list_things',
            outcome: 'ok',
            region: 'us-east-1',
            args: { max_results: 5 },
        });
        expect(typeof events[0]?.durationMs).toBe('number');
    });

    it('records a policy refusal as denied, with its code', async () => {
        harness = await createHarness({ config: { thingAllow: ['gw-*'] } });

        await harness.client.callTool({ name: 'describe_thing', arguments: { thing_name: 'prod-db' } });

        expect(harness.audit.events()[0]).toMatchObject({
            outcome: 'denied',
            code: 'thing_out_of_scope',
        });
    });

    it('records an AWS failure as an error, with the AWS code', async () => {
        harness = await createHarness({
            control: new FakeControlPort({
                failures: { listThings: new AwsCallError('ThrottlingException') },
            }),
        });

        await harness.client.callTool({ name: 'list_things', arguments: {} });

        expect(harness.audit.events()[0]).toMatchObject({
            outcome: 'error',
            code: 'ThrottlingException',
        });
    });
});
