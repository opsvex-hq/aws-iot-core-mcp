/**
 * The AWS adapter, against a fake SDK client.
 *
 * This layer looks like boilerplate and is not: the IoT APIs return dates in
 * three different shapes (a `Date`, epoch seconds for certificate validity,
 * epoch milliseconds for connectivity), and topic-rule actions are a union of
 * ~20 optional keys. Both are normalised here, and both are easy to get wrong
 * in a way no type checker catches.
 */

import { describe, expect, it } from 'vitest';

import type { IoTClient } from '@aws-sdk/client-iot';
import type { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';

import { AwsIotControlAdapter, AwsIotDataAdapter } from '../../src/aws/iot.js';
import { certificateIdFromPrincipalArn } from '../../src/aws/ports.js';

type Responder = (input: Record<string, unknown>) => unknown;

/** Minimal stand-in for an AWS SDK client, dispatching on the command name. */
function fakeClient(responders: Record<string, Responder>): {
    client: IoTClient & IoTDataPlaneClient;
    sent: Array<{ command: string; input: Record<string, unknown> }>;
} {
    const sent: Array<{ command: string; input: Record<string, unknown> }> = [];

    const client = {
        async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
            const name = command.constructor.name;
            sent.push({ command: name, input: command.input });
            const responder = responders[name];
            if (responder === undefined) {
                throw new Error(`Unexpected command in test: ${name}`);
            }
            return responder(command.input);
        },
    };

    return { client: client as unknown as IoTClient & IoTDataPlaneClient, sent };
}

describe('AwsIotControlAdapter.listThings', () => {
    it('maps things and forwards every filter', async () => {
        const { client, sent } = fakeClient({
            ListThingsCommand: () => ({
                things: [
                    { thingName: 'gw-001', thingTypeName: 'gateway', version: 2, attributes: { a: 'b' } },
                    { thingName: 'gw-002' },
                ],
                nextToken: 'NEXT',
            }),
        });

        const result = await new AwsIotControlAdapter(client).listThings({
            maxResults: 10,
            thingTypeName: 'gateway',
            attributeName: 'site',
            attributeValue: 'cl',
            nextToken: 'PREV',
        });

        expect(result.things).toHaveLength(2);
        expect(result.things[0]).toEqual({
            thingName: 'gw-001',
            thingTypeName: 'gateway',
            version: 2,
            attributes: { a: 'b' },
        });
        expect(result.nextToken).toBe('NEXT');
        expect(sent[0]?.input).toEqual({
            maxResults: 10,
            nextToken: 'PREV',
            thingTypeName: 'gateway',
            attributeName: 'site',
            attributeValue: 'cl',
        });
    });

    it('drops a thing with no name rather than emitting undefined', async () => {
        const { client } = fakeClient({
            ListThingsCommand: () => ({ things: [{ thingTypeName: 'orphan' }, { thingName: 'ok' }] }),
        });

        const result = await new AwsIotControlAdapter(client).listThings({ maxResults: 10 });
        expect(result.things.map((thing) => thing.thingName)).toEqual(['ok']);
    });

    it('survives a response with no things array at all', async () => {
        const { client } = fakeClient({ ListThingsCommand: () => ({}) });
        const result = await new AwsIotControlAdapter(client).listThings({ maxResults: 10 });
        expect(result.things).toEqual([]);
        expect(result.nextToken).toBeUndefined();
    });
});

describe('AwsIotControlAdapter.describeThing', () => {
    it('maps the registry record', async () => {
        const { client } = fakeClient({
            DescribeThingCommand: () => ({
                thingName: 'gw-001',
                thingId: 'id-1',
                thingArn: 'arn:aws:iot:us-east-1:111:thing/gw-001',
                thingTypeName: 'gateway',
                attributes: { site: 'cl' },
                version: 3,
                billingGroupName: 'bg',
            }),
        });

        const detail = await new AwsIotControlAdapter(client).describeThing('gw-001');
        expect(detail).toEqual({
            thingName: 'gw-001',
            thingId: 'id-1',
            thingArn: 'arn:aws:iot:us-east-1:111:thing/gw-001',
            thingTypeName: 'gateway',
            attributes: { site: 'cl' },
            version: 3,
            billingGroupName: 'bg',
        });
    });

    it('falls back to the requested name when AWS omits it', async () => {
        const { client } = fakeClient({ DescribeThingCommand: () => ({}) });
        const detail = await new AwsIotControlAdapter(client).describeThing('gw-001');
        expect(detail.thingName).toBe('gw-001');
    });
});

describe('AwsIotControlAdapter.listThingGroupsForThing', () => {
    it('keeps only named groups', async () => {
        const { client } = fakeClient({
            ListThingGroupsForThingCommand: () => ({
                thingGroups: [{ groupName: 'fleet-cl' }, { groupArn: 'arn-without-name' }],
            }),
        });

        const groups = await new AwsIotControlAdapter(client).listThingGroupsForThing('gw-001');
        expect(groups).toEqual(['fleet-cl']);
    });
});

describe('AwsIotControlAdapter.searchIndex', () => {
    it('queries the things index and preserves connectivity milliseconds', async () => {
        const timestampMs = 1_789_200_000_000;
        const { client, sent } = fakeClient({
            SearchIndexCommand: () => ({
                things: [
                    {
                        thingName: 'gw-001',
                        thingTypeName: 'gateway',
                        thingGroupNames: ['fleet-cl'],
                        attributes: { site: 'cl' },
                        shadow: '{"state":{"reported":{"a":1}}}',
                        connectivity: {
                            connected: false,
                            timestamp: timestampMs,
                            disconnectReason: 'CONNECTION_LOST',
                        },
                    },
                ],
            }),
        });

        const result = await new AwsIotControlAdapter(client).searchIndex({
            queryString: 'thingName:gw-*',
            maxResults: 5,
        });

        expect(sent[0]?.input).toMatchObject({ indexName: 'AWS_Things', queryString: 'thingName:gw-*' });
        expect(result.things[0]?.connectivity).toEqual({
            connected: false,
            timestampMs,
            disconnectReason: 'CONNECTION_LOST',
        });
        expect(result.things[0]?.shadowRaw).toContain('reported');
    });

    it('leaves connectivity undefined when the index does not carry it', async () => {
        const { client } = fakeClient({
            SearchIndexCommand: () => ({ things: [{ thingName: 'gw-001' }] }),
        });

        const result = await new AwsIotControlAdapter(client).searchIndex({
            queryString: '*',
            maxResults: 5,
        });
        expect(result.things[0]?.connectivity).toBeUndefined();
    });
});

describe('AwsIotControlAdapter topic rules', () => {
    it('converts a createdAt Date into epoch milliseconds', async () => {
        const createdAt = new Date('2026-01-15T10:00:00.000Z');
        const { client } = fakeClient({
            ListTopicRulesCommand: () => ({
                rules: [
                    { ruleName: 'to_kinesis', topicPattern: 'telemetry/#', createdAt, ruleDisabled: false },
                    { topicPattern: 'nameless' },
                ],
            }),
        });

        const result = await new AwsIotControlAdapter(client).listTopicRules({ maxResults: 10 });
        expect(result.rules).toHaveLength(1);
        expect(result.rules[0]?.createdAtMs).toBe(createdAt.getTime());
    });

    it('reduces an action union to its type and target', async () => {
        const { client } = fakeClient({
            GetTopicRuleCommand: () => ({
                rule: {
                    ruleName: 'to_kinesis',
                    sql: "SELECT * FROM 'telemetry/#'",
                    awsIotSqlVersion: '2016-03-23',
                    actions: [
                        { kinesis: { streamName: 's', roleArn: 'arn:aws:iam::111:role/r' } },
                        { republish: { topic: 'copy/telemetry', roleArn: 'arn:aws:iam::111:role/r2' } },
                        { unknownFuture: {} },
                    ],
                    errorAction: { sqs: { queueUrl: 'https://sqs/queue' } },
                },
            }),
        });

        const rule = await new AwsIotControlAdapter(client).getTopicRule('to_kinesis');
        // The destination wins over the IAM role in both cases: the stream for
        // kinesis, the topic for republish. The role is incidental to the question
        // "where does this data go?".
        expect(rule.actions[0]).toEqual({ type: 'kinesis', target: 's' });
        expect(rule.actions[1]).toEqual({ type: 'republish', target: 'copy/telemetry' });
        expect(rule.actions[2]).toEqual({ type: 'unknownFuture' });
        expect(rule.errorAction).toEqual({ type: 'sqs', target: 'https://sqs/queue' });
    });

    it('reports an action with no populated key as unknown instead of crashing', async () => {
        const { client } = fakeClient({
            GetTopicRuleCommand: () => ({ rule: { ruleName: 'weird', actions: [{}] } }),
        });

        const rule = await new AwsIotControlAdapter(client).getTopicRule('weird');
        expect(rule.actions).toEqual([{ type: 'unknown' }]);
    });

    it('handles a rule response with no rule body', async () => {
        const { client } = fakeClient({ GetTopicRuleCommand: () => ({}) });
        const rule = await new AwsIotControlAdapter(client).getTopicRule('ghost');
        expect(rule).toEqual({
            ruleName: 'ghost',
            sql: undefined,
            description: undefined,
            awsIotSqlVersion: undefined,
            ruleDisabled: undefined,
            createdAtMs: undefined,
            actions: [],
            errorAction: undefined,
        });
    });
});

describe('AwsIotControlAdapter.describeEndpoint', () => {
    it('returns the address', async () => {
        const { client, sent } = fakeClient({
            DescribeEndpointCommand: () => ({ endpointAddress: 'abc-ats.iot.sa-east-1.amazonaws.com' }),
        });

        const address = await new AwsIotControlAdapter(client).describeEndpoint('iot:Data-ATS');
        expect(address).toBe('abc-ats.iot.sa-east-1.amazonaws.com');
        expect(sent[0]?.input).toEqual({ endpointType: 'iot:Data-ATS' });
    });

    it('returns an empty string rather than undefined', async () => {
        const { client } = fakeClient({ DescribeEndpointCommand: () => ({}) });
        expect(await new AwsIotControlAdapter(client).describeEndpoint('iot:Jobs')).toBe('');
    });
});

describe('AwsIotControlAdapter certificates', () => {
    it('converts certificate validity from epoch seconds to milliseconds', async () => {
        // This is the conversion that matters: AWS sends seconds here and
        // milliseconds for connectivity. Treating seconds as millis puts every
        // expiry date in 1970 and reports the whole fleet as expired.
        const notAfterSeconds = 1_800_000_000;
        const { client } = fakeClient({
            DescribeCertificateCommand: () => ({
                certificateDescription: {
                    certificateId: 'abc',
                    status: 'ACTIVE',
                    certificateArn: 'arn:aws:iot:us-east-1:111:cert/abc',
                    validity: { notAfter: notAfterSeconds, notBefore: notAfterSeconds - 86_400 },
                },
            }),
        });

        const detail = await new AwsIotControlAdapter(client).describeCertificate('abc');
        expect(detail.notAfterMs).toBe(notAfterSeconds * 1000);
        expect(detail.notBeforeMs).toBe((notAfterSeconds - 86_400) * 1000);
        expect(new Date(detail.notAfterMs as number).getUTCFullYear()).toBe(2027);
    });

    it('accepts validity already expressed as a Date', async () => {
        const notAfter = new Date('2027-01-15T10:00:00.000Z');
        const { client } = fakeClient({
            DescribeCertificateCommand: () => ({
                certificateDescription: { certificateId: 'abc', validity: { notAfter } },
            }),
        });

        const detail = await new AwsIotControlAdapter(client).describeCertificate('abc');
        expect(detail.notAfterMs).toBe(notAfter.getTime());
    });

    it('leaves expiry undefined when the value is unusable', async () => {
        const { client } = fakeClient({
            DescribeCertificateCommand: () => ({
                certificateDescription: { certificateId: 'abc', validity: { notAfter: Number.NaN } },
            }),
        });

        const detail = await new AwsIotControlAdapter(client).describeCertificate('abc');
        expect(detail.notAfterMs).toBeUndefined();
    });

    it('falls back to the requested id when the description is empty', async () => {
        const { client } = fakeClient({ DescribeCertificateCommand: () => ({}) });
        const detail = await new AwsIotControlAdapter(client).describeCertificate('abc');
        expect(detail).toEqual({
            certificateId: 'abc',
            status: undefined,
            certificateArn: undefined,
            notAfterMs: undefined,
            notBeforeMs: undefined,
        });
    });

    it('returns principals verbatim', async () => {
        const { client } = fakeClient({
            ListThingPrincipalsCommand: () => ({ principals: ['arn:aws:iot:us-east-1:111:cert/abc'] }),
        });
        expect(await new AwsIotControlAdapter(client).listThingPrincipals('gw-001')).toEqual([
            'arn:aws:iot:us-east-1:111:cert/abc',
        ]);
    });

    it('returns an empty list when a thing has no principals', async () => {
        const { client } = fakeClient({ ListThingPrincipalsCommand: () => ({}) });
        expect(await new AwsIotControlAdapter(client).listThingPrincipals('gw-001')).toEqual([]);
    });
});

describe('AwsIotControlAdapter.getIndexingConfiguration', () => {
    it('maps the three modes', async () => {
        const { client } = fakeClient({
            GetIndexingConfigurationCommand: () => ({
                thingIndexingConfiguration: {
                    thingIndexingMode: 'REGISTRY_AND_SHADOW',
                    thingConnectivityIndexingMode: 'STATUS',
                    namedShadowIndexingMode: 'ON',
                },
            }),
        });

        expect(await new AwsIotControlAdapter(client).getIndexingConfiguration()).toEqual({
            thingIndexingMode: 'REGISTRY_AND_SHADOW',
            thingConnectivityIndexingMode: 'STATUS',
            namedShadowIndexingMode: 'ON',
        });
    });

    it('returns undefined modes when indexing was never configured', async () => {
        const { client } = fakeClient({ GetIndexingConfigurationCommand: () => ({}) });
        const config = await new AwsIotControlAdapter(client).getIndexingConfiguration();
        expect(config.thingIndexingMode).toBeUndefined();
    });
});

describe('AwsIotDataAdapter', () => {
    it('decodes the shadow payload as UTF-8 text', async () => {
        const payload = new TextEncoder().encode('{"state":{"reported":{"site":"ñuñoa"}}}');
        const { client, sent } = fakeClient({ GetThingShadowCommand: () => ({ payload }) });

        const raw = await new AwsIotDataAdapter(client).getThingShadow({
            thingName: 'gw-001',
            shadowName: 'telemetry',
        });

        expect(JSON.parse(raw)).toEqual({ state: { reported: { site: 'ñuñoa' } } });
        expect(sent[0]?.input).toEqual({ thingName: 'gw-001', shadowName: 'telemetry' });
    });

    it('returns an empty string when there is no payload', async () => {
        const { client } = fakeClient({ GetThingShadowCommand: () => ({}) });
        expect(await new AwsIotDataAdapter(client).getThingShadow({ thingName: 'gw-001' })).toBe('');
    });

    it('lists named shadows, defaulting to an empty list', async () => {
        const withResults = fakeClient({
            ListNamedShadowsForThingCommand: () => ({ results: ['telemetry', 'config'] }),
        });
        expect(await new AwsIotDataAdapter(withResults.client).listNamedShadows('gw-001')).toEqual([
            'telemetry',
            'config',
        ]);

        const empty = fakeClient({ ListNamedShadowsForThingCommand: () => ({}) });
        expect(await new AwsIotDataAdapter(empty.client).listNamedShadows('gw-001')).toEqual([]);
    });
});

describe('certificateIdFromPrincipalArn', () => {
    it('extracts the id from a certificate ARN', () => {
        expect(certificateIdFromPrincipalArn(`arn:aws:iot:us-east-1:111:cert/${'a'.repeat(64)}`)).toBe(
            'a'.repeat(64),
        );
    });

    it('ignores principals that are not certificates', () => {
        expect(
            certificateIdFromPrincipalArn('arn:aws:cognito-identity:us-east-1:111:id/abc'),
        ).toBeUndefined();
        expect(certificateIdFromPrincipalArn('arn:aws:iot:us-east-1:111:cert/short')).toBeUndefined();
        expect(certificateIdFromPrincipalArn('nonsense')).toBeUndefined();
    });
});
