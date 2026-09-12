/**
 * The AWS boundary, expressed as two narrow ports.
 *
 * Tools depend on these interfaces, never on the AWS SDK. That buys three
 * things: the whole tool layer is testable without credentials or network, the
 * read-only surface is visible in one file (there is no `updateThing` to call
 * by accident), and the SDK stays replaceable.
 *
 * Every field is optional wherever AWS declares it optional. Pretending
 * otherwise is how an MCP server ends up crashing on a thing without a type.
 */

export interface ThingSummary {
    thingName: string;
    thingTypeName?: string;
    attributes?: Record<string, string>;
    version?: number;
}

export interface ThingDetail extends ThingSummary {
    thingId?: string;
    thingArn?: string;
    billingGroupName?: string;
}

export interface IndexedThing {
    thingName: string;
    thingTypeName?: string;
    thingGroupNames?: string[];
    attributes?: Record<string, string>;
    /** Raw shadow JSON as stored in the fleet index. Untrusted. */
    shadowRaw?: string;
    connectivity?: {
        connected?: boolean;
        /** Epoch milliseconds of the last transition. */
        timestampMs?: number;
        disconnectReason?: string;
    };
}

export interface TopicRuleSummary {
    ruleName: string;
    ruleArn?: string;
    topicPattern?: string;
    /** Epoch milliseconds. */
    createdAtMs?: number;
    ruleDisabled?: boolean;
}

export interface TopicRuleAction {
    /** Action kind as named by AWS: `republish`, `lambda`, `sqs`, ... */
    type: string;
    /** Best-effort target identifier (ARN, table name, topic), when present. */
    target?: string;
}

export interface TopicRuleDetail {
    ruleName: string;
    /** The rule's SQL. Customer-authored, therefore untrusted. */
    sql?: string;
    description?: string;
    awsIotSqlVersion?: string;
    ruleDisabled?: boolean;
    createdAtMs?: number;
    actions: TopicRuleAction[];
    errorAction?: TopicRuleAction;
}

export interface CertificateDetail {
    certificateId: string;
    status?: string;
    /** Epoch milliseconds. */
    notAfterMs?: number;
    /** Epoch milliseconds. */
    notBeforeMs?: number;
    certificateArn?: string;
}

export interface IndexingConfiguration {
    thingIndexingMode?: string;
    thingConnectivityIndexingMode?: string;
    namedShadowIndexingMode?: string;
}

export interface ListThingsInput {
    maxResults: number;
    nextToken?: string;
    thingTypeName?: string;
    attributeName?: string;
    attributeValue?: string;
}

export interface SearchIndexInput {
    queryString: string;
    maxResults: number;
    nextToken?: string;
}

/** Control-plane reads (the `iot` API). */
export interface IotControlPort {
    listThings(input: ListThingsInput): Promise<{ things: ThingSummary[]; nextToken?: string }>;
    describeThing(thingName: string): Promise<ThingDetail>;
    listThingGroupsForThing(thingName: string): Promise<string[]>;
    searchIndex(input: SearchIndexInput): Promise<{ things: IndexedThing[]; nextToken?: string }>;
    listTopicRules(input: { maxResults: number; nextToken?: string }): Promise<{
        rules: TopicRuleSummary[];
        nextToken?: string;
    }>;
    getTopicRule(ruleName: string): Promise<TopicRuleDetail>;
    describeEndpoint(endpointType: string): Promise<string>;
    listThingPrincipals(thingName: string): Promise<string[]>;
    describeCertificate(certificateId: string): Promise<CertificateDetail>;
    getIndexingConfiguration(): Promise<IndexingConfiguration>;
}

/** Data-plane reads (the `iot-data` API). */
export interface IotDataPort {
    /** Returns the raw shadow document as text. Untrusted. */
    getThingShadow(input: { thingName: string; shadowName?: string }): Promise<string>;
    listNamedShadows(thingName: string): Promise<string[]>;
}

/** Extracts the certificate id from a principal ARN, if it is a certificate. */
export function certificateIdFromPrincipalArn(arn: string): string | undefined {
    const match = /:cert\/([0-9a-fA-F]{16,})$/.exec(arn);
    return match?.[1];
}
