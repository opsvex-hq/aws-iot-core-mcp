/**
 * Real implementations of the AWS ports.
 *
 * This file is the only place in the repository that imports the AWS SDK. It
 * contains no policy, no formatting and no decisions — it maps AWS shapes onto
 * the port shapes and normalises units (AWS mixes epoch seconds, epoch
 * milliseconds and `Date` across these APIs; the ports speak milliseconds).
 *
 * Only read commands are imported. That is deliberate and load-bearing: a
 * mutating call cannot be made from code that never imports it.
 */

import {
    DescribeCertificateCommand,
    DescribeEndpointCommand,
    DescribeThingCommand,
    GetIndexingConfigurationCommand,
    GetTopicRuleCommand,
    ListThingGroupsForThingCommand,
    ListThingPrincipalsCommand,
    ListThingsCommand,
    ListTopicRulesCommand,
    SearchIndexCommand,
    type IoTClient,
} from '@aws-sdk/client-iot';
import {
    GetThingShadowCommand,
    ListNamedShadowsForThingCommand,
    type IoTDataPlaneClient,
} from '@aws-sdk/client-iot-data-plane';

import type {
    CertificateDetail,
    IndexedThing,
    IndexingConfiguration,
    IotControlPort,
    IotDataPort,
    ListThingsInput,
    SearchIndexInput,
    ThingDetail,
    ThingSummary,
    TopicRuleAction,
    TopicRuleDetail,
    TopicRuleSummary,
} from './ports.js';

/** Normalises the several date shapes the IoT APIs return to epoch millis. */
function toEpochMs(value: Date | number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    if (!Number.isFinite(value)) {
        return undefined;
    }
    // IoT returns certificate validity in epoch seconds and connectivity in
    // epoch milliseconds. Anything below year 2001 in millis is really seconds.
    return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * Keys that can name an action's destination, in the order an operator cares
 * about. Destinations come first and `roleArn` is last on purpose: nearly every
 * action carries a role, so checking it first would report the IAM role of a
 * republish action instead of the topic the data actually goes to.
 */
const ACTION_TARGET_KEYS = [
    'topic',
    'queueUrl',
    'functionArn',
    'tableName',
    'deliveryStreamName',
    'streamName',
    'stateMachineName',
    'channelName',
    'alarmName',
    'metricName',
    'url',
    'targetArn',
    'roleArn',
] as const;

/**
 * Reduces a topic-rule action object (a union with exactly one populated key)
 * to a type plus a best-effort target. AWS models these as ~20 optional keys;
 * the first populated one is the action.
 */
function describeAction(action: Record<string, unknown>): TopicRuleAction {
    const entry = Object.entries(action).find(([, value]) => value !== undefined && value !== null);
    if (entry === undefined) {
        return { type: 'unknown' };
    }
    const [type, value] = entry;
    if (value !== null && typeof value === 'object') {
        const candidate = value as Record<string, unknown>;
        for (const key of ACTION_TARGET_KEYS) {
            const target = candidate[key];
            if (typeof target === 'string' && target !== '') {
                return { type, target };
            }
        }
    }
    return { type };
}

export class AwsIotControlAdapter implements IotControlPort {
    constructor(private readonly client: IoTClient) {}

    public async listThings(input: ListThingsInput): Promise<{ things: ThingSummary[]; nextToken?: string }> {
        const response = await this.client.send(
            new ListThingsCommand({
                maxResults: input.maxResults,
                nextToken: input.nextToken,
                thingTypeName: input.thingTypeName,
                attributeName: input.attributeName,
                attributeValue: input.attributeValue,
            }),
        );

        const things: ThingSummary[] = (response.things ?? [])
            .filter((thing): thing is typeof thing & { thingName: string } => thing.thingName !== undefined)
            .map((thing) => ({
                thingName: thing.thingName,
                thingTypeName: thing.thingTypeName,
                attributes: thing.attributes,
                version: thing.version,
            }));

        return { things, nextToken: response.nextToken };
    }

    public async describeThing(thingName: string): Promise<ThingDetail> {
        const response = await this.client.send(new DescribeThingCommand({ thingName }));
        return {
            thingName: response.thingName ?? thingName,
            thingId: response.thingId,
            thingArn: response.thingArn,
            thingTypeName: response.thingTypeName,
            attributes: response.attributes,
            version: response.version,
            billingGroupName: response.billingGroupName,
        };
    }

    public async listThingGroupsForThing(thingName: string): Promise<string[]> {
        const response = await this.client.send(new ListThingGroupsForThingCommand({ thingName }));
        return (response.thingGroups ?? [])
            .map((group) => group.groupName)
            .filter((name): name is string => name !== undefined);
    }

    public async searchIndex(
        input: SearchIndexInput,
    ): Promise<{ things: IndexedThing[]; nextToken?: string }> {
        const response = await this.client.send(
            new SearchIndexCommand({
                indexName: 'AWS_Things',
                queryString: input.queryString,
                maxResults: input.maxResults,
                nextToken: input.nextToken,
            }),
        );

        const things: IndexedThing[] = (response.things ?? [])
            .filter((thing): thing is typeof thing & { thingName: string } => thing.thingName !== undefined)
            .map((thing) => ({
                thingName: thing.thingName,
                thingTypeName: thing.thingTypeName,
                thingGroupNames: thing.thingGroupNames,
                attributes: thing.attributes,
                shadowRaw: thing.shadow,
                connectivity:
                    thing.connectivity === undefined
                        ? undefined
                        : {
                              connected: thing.connectivity.connected,
                              timestampMs: toEpochMs(thing.connectivity.timestamp),
                              disconnectReason: thing.connectivity.disconnectReason,
                          },
            }));

        return { things, nextToken: response.nextToken };
    }

    public async listTopicRules(input: { maxResults: number; nextToken?: string }): Promise<{
        rules: TopicRuleSummary[];
        nextToken?: string;
    }> {
        const response = await this.client.send(
            new ListTopicRulesCommand({ maxResults: input.maxResults, nextToken: input.nextToken }),
        );

        const rules: TopicRuleSummary[] = (response.rules ?? [])
            .filter((rule): rule is typeof rule & { ruleName: string } => rule.ruleName !== undefined)
            .map((rule) => ({
                ruleName: rule.ruleName,
                ruleArn: rule.ruleArn,
                topicPattern: rule.topicPattern,
                createdAtMs: toEpochMs(rule.createdAt),
                ruleDisabled: rule.ruleDisabled,
            }));

        return { rules, nextToken: response.nextToken };
    }

    public async getTopicRule(ruleName: string): Promise<TopicRuleDetail> {
        const response = await this.client.send(new GetTopicRuleCommand({ ruleName }));
        const rule = response.rule ?? {};
        return {
            ruleName: rule.ruleName ?? ruleName,
            sql: rule.sql,
            description: rule.description,
            awsIotSqlVersion: rule.awsIotSqlVersion,
            ruleDisabled: rule.ruleDisabled,
            createdAtMs: toEpochMs(rule.createdAt),
            actions: (rule.actions ?? []).map((action) => describeAction(action as Record<string, unknown>)),
            errorAction:
                rule.errorAction === undefined
                    ? undefined
                    : describeAction(rule.errorAction as Record<string, unknown>),
        };
    }

    public async describeEndpoint(endpointType: string): Promise<string> {
        const response = await this.client.send(new DescribeEndpointCommand({ endpointType }));
        return response.endpointAddress ?? '';
    }

    public async listThingPrincipals(thingName: string): Promise<string[]> {
        const response = await this.client.send(new ListThingPrincipalsCommand({ thingName }));
        return response.principals ?? [];
    }

    public async describeCertificate(certificateId: string): Promise<CertificateDetail> {
        const response = await this.client.send(new DescribeCertificateCommand({ certificateId }));
        const description = response.certificateDescription ?? {};
        return {
            certificateId: description.certificateId ?? certificateId,
            status: description.status,
            certificateArn: description.certificateArn,
            notAfterMs: toEpochMs(description.validity?.notAfter),
            notBeforeMs: toEpochMs(description.validity?.notBefore),
        };
    }

    public async getIndexingConfiguration(): Promise<IndexingConfiguration> {
        const response = await this.client.send(new GetIndexingConfigurationCommand({}));
        const config = response.thingIndexingConfiguration;
        return {
            thingIndexingMode: config?.thingIndexingMode,
            thingConnectivityIndexingMode: config?.thingConnectivityIndexingMode,
            namedShadowIndexingMode: config?.namedShadowIndexingMode,
        };
    }
}

export class AwsIotDataAdapter implements IotDataPort {
    private readonly decoder = new TextDecoder('utf-8');

    constructor(private readonly client: IoTDataPlaneClient) {}

    public async getThingShadow(input: { thingName: string; shadowName?: string }): Promise<string> {
        const response = await this.client.send(
            new GetThingShadowCommand({ thingName: input.thingName, shadowName: input.shadowName }),
        );
        if (response.payload === undefined) {
            return '';
        }
        return this.decoder.decode(response.payload);
    }

    public async listNamedShadows(thingName: string): Promise<string[]> {
        const response = await this.client.send(new ListNamedShadowsForThingCommand({ thingName }));
        return response.results ?? [];
    }
}
