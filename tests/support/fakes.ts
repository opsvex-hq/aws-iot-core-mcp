/**
 * Test doubles for the AWS ports, plus a harness that speaks real MCP.
 *
 * The fakes are deliberately faithful about the two things that break naive
 * implementations: AWS returns almost every field as optional, and shadow
 * metadata timestamps are epoch **seconds** while connectivity is epoch
 * **milliseconds**. Fixtures here use the real units so a unit-mixing bug fails
 * a test instead of shipping.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { AuditSink } from '../../src/audit.js';
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
    TopicRuleDetail,
    TopicRuleSummary,
} from '../../src/aws/ports.js';
import type { ResolvedConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';

/** A fixed instant so every rendered age is deterministic: 2026-09-12T12:00:00Z. */
export const NOW_MS = Date.UTC(2026, 8, 12, 12, 0, 0);

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Builds a shadow document with reported metadata `ageSeconds` old. */
export function shadowFixture(options: {
    reported?: Record<string, unknown>;
    desired?: Record<string, unknown>;
    ageSeconds?: number;
    version?: number;
    withMetadata?: boolean;
}): string {
    const reported = options.reported ?? { firmware: '1.2.3', battery: 91 };
    const ageSeconds = options.ageSeconds ?? 60;
    const timestamp = Math.floor(NOW_MS / 1000) - ageSeconds;

    const metadata =
        options.withMetadata === false
            ? undefined
            : {
                  reported: Object.fromEntries(Object.keys(reported).map((key) => [key, { timestamp }])),
              };

    return JSON.stringify({
        state: {
            reported,
            ...(options.desired === undefined ? {} : { desired: options.desired }),
        },
        ...(metadata === undefined ? {} : { metadata }),
        version: options.version ?? 7,
        timestamp: Math.floor(NOW_MS / 1000),
    });
}

export class AwsCallError extends Error {
    constructor(name: string, message = name) {
        super(message);
        this.name = name;
    }
}

export interface FakeControlOptions {
    things?: ThingSummary[];
    thingDetails?: Record<string, ThingDetail>;
    thingGroups?: Record<string, string[]>;
    indexed?: IndexedThing[];
    rules?: TopicRuleSummary[];
    ruleDetails?: Record<string, TopicRuleDetail>;
    endpoints?: Record<string, string>;
    principals?: Record<string, string[]>;
    certificates?: Record<string, CertificateDetail>;
    indexing?: IndexingConfiguration;
    /** Force a failure for the named method. */
    failures?: Partial<Record<keyof IotControlPort, Error>>;
    nextToken?: string;
}

export class FakeControlPort implements IotControlPort {
    public readonly calls: Array<{ method: string; input?: unknown }> = [];

    constructor(private readonly options: FakeControlOptions = {}) {}

    private guard(method: keyof IotControlPort, input?: unknown): void {
        this.calls.push({ method, input });
        const failure = this.options.failures?.[method];
        if (failure !== undefined) {
            throw failure;
        }
    }

    public async listThings(input: ListThingsInput): Promise<{ things: ThingSummary[]; nextToken?: string }> {
        this.guard('listThings', input);
        let things = this.options.things ?? [];
        if (input.thingTypeName !== undefined) {
            things = things.filter((thing) => thing.thingTypeName === input.thingTypeName);
        }
        if (input.attributeName !== undefined && input.attributeValue !== undefined) {
            things = things.filter(
                (thing) => thing.attributes?.[input.attributeName as string] === input.attributeValue,
            );
        }
        return { things: things.slice(0, input.maxResults), nextToken: this.options.nextToken };
    }

    public async describeThing(thingName: string): Promise<ThingDetail> {
        this.guard('describeThing', thingName);
        const detail = this.options.thingDetails?.[thingName];
        if (detail === undefined) {
            throw new AwsCallError('ResourceNotFoundException', `No thing ${thingName}`);
        }
        return detail;
    }

    public async listThingGroupsForThing(thingName: string): Promise<string[]> {
        this.guard('listThingGroupsForThing', thingName);
        return this.options.thingGroups?.[thingName] ?? [];
    }

    public async searchIndex(
        input: SearchIndexInput,
    ): Promise<{ things: IndexedThing[]; nextToken?: string }> {
        this.guard('searchIndex', input);
        return { things: (this.options.indexed ?? []).slice(0, input.maxResults) };
    }

    public async listTopicRules(input: { maxResults: number; nextToken?: string }): Promise<{
        rules: TopicRuleSummary[];
        nextToken?: string;
    }> {
        this.guard('listTopicRules', input);
        return { rules: (this.options.rules ?? []).slice(0, input.maxResults) };
    }

    public async getTopicRule(ruleName: string): Promise<TopicRuleDetail> {
        this.guard('getTopicRule', ruleName);
        const detail = this.options.ruleDetails?.[ruleName];
        if (detail === undefined) {
            throw new AwsCallError('ResourceNotFoundException', `No rule ${ruleName}`);
        }
        return detail;
    }

    public async describeEndpoint(endpointType: string): Promise<string> {
        this.guard('describeEndpoint', endpointType);
        return this.options.endpoints?.[endpointType] ?? 'abc123-ats.iot.us-east-1.amazonaws.com';
    }

    public async listThingPrincipals(thingName: string): Promise<string[]> {
        this.guard('listThingPrincipals', thingName);
        return this.options.principals?.[thingName] ?? [];
    }

    public async describeCertificate(certificateId: string): Promise<CertificateDetail> {
        this.guard('describeCertificate', certificateId);
        const certificate = this.options.certificates?.[certificateId];
        if (certificate === undefined) {
            throw new AwsCallError('UnauthorizedException', 'no DescribeCertificate permission');
        }
        return certificate;
    }

    public async getIndexingConfiguration(): Promise<IndexingConfiguration> {
        this.guard('getIndexingConfiguration');
        return this.options.indexing ?? { thingIndexingMode: 'REGISTRY_AND_SHADOW' };
    }
}

export interface FakeDataOptions {
    shadows?: Record<string, string>;
    namedShadows?: Record<string, string[]>;
    failures?: Partial<Record<keyof IotDataPort, Error>>;
}

export class FakeDataPort implements IotDataPort {
    public readonly calls: Array<{ method: string; input?: unknown }> = [];

    constructor(private readonly options: FakeDataOptions = {}) {}

    public async getThingShadow(input: { thingName: string; shadowName?: string }): Promise<string> {
        this.calls.push({ method: 'getThingShadow', input });
        const failure = this.options.failures?.getThingShadow;
        if (failure !== undefined) {
            throw failure;
        }
        const key =
            input.shadowName === undefined ? input.thingName : `${input.thingName}/${input.shadowName}`;
        const shadow = this.options.shadows?.[key];
        if (shadow === undefined) {
            throw new AwsCallError('ResourceNotFoundException', 'No shadow exists');
        }
        return shadow;
    }

    public async listNamedShadows(thingName: string): Promise<string[]> {
        this.calls.push({ method: 'listNamedShadows', input: thingName });
        const failure = this.options.failures?.listNamedShadows;
        if (failure !== undefined) {
            throw failure;
        }
        return this.options.namedShadows?.[thingName] ?? [];
    }
}

/** Collects audit lines instead of writing them anywhere. */
export class CapturingSink implements AuditSink {
    public readonly lines: string[] = [];

    public write(line: string): void {
        this.lines.push(line);
    }

    public events(): Array<Record<string, unknown>> {
        return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    }
}

export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return {
        region: 'us-east-1',
        maxItemsPerCall: 100,
        maxUntrustedBytes: 24_000,
        maxFleetSample: 25,
        auditEnabled: true,
        auditArgs: true,
        thresholds: {
            staleWarnSeconds: 3_600,
            staleCriticalSeconds: 86_400,
            certWarnDays: 45,
            certCriticalDays: 14,
        },
        http: { port: 3000, host: '127.0.0.1', path: '/mcp' },
        ...overrides,
    };
}

export interface Harness {
    client: Client;
    audit: CapturingSink;
    control: FakeControlPort;
    data: FakeDataPort;
    close: () => Promise<void>;
}

/**
 * Wires a real MCP client to a real server over the in-memory transport, with
 * fake AWS ports underneath. Tests therefore exercise schema validation,
 * serialisation and the tool registry exactly as a client would.
 */
export async function createHarness(
    options: {
        control?: FakeControlPort;
        data?: FakeDataPort;
        config?: Partial<ResolvedConfig>;
    } = {},
): Promise<Harness> {
    const control = options.control ?? new FakeControlPort();
    const data = options.data ?? new FakeDataPort();
    const audit = new CapturingSink();

    const { server } = createServer({
        config: testConfig(options.config),
        ports: { control, data },
        auditSink: audit,
        now: () => NOW_MS,
    });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
        client,
        audit,
        control,
        data,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

/**
 * Extracts the concatenated text of a tool result.
 *
 * Takes `unknown` on purpose: the SDK's CallToolResult is a union that includes
 * a legacy `toolResult` shape with no `content` at all, and a narrower
 * parameter type would force a cast at every call site in the tests.
 */
export function resultText(result: unknown): string {
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) {
        return '';
    }
    return (content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
}
