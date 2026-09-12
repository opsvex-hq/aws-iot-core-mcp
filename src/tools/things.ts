/**
 * Thing inventory tools: list, describe, and fleet-index search.
 *
 * Thing attributes are customer-authored strings that anybody with
 * `iot:UpdateThing` can set, so they cross the untrusted boundary before being
 * shown — the same treatment a shadow gets.
 */

import { z } from 'zod';

import { fenceUntrusted, sanitizeUntrusted } from '../domain/untrusted.js';
import {
    paginationNote,
    renderKeyValues,
    renderList,
    renderSections,
    renderTable,
    show,
    showTimestamp,
} from '../domain/render.js';
import { READ_ONLY, defineTool } from './types.js';

const thingName = z.string().min(1).max(128).describe('Exact AWS IoT thing name.');
const nextToken = z.string().min(1).optional().describe('Pagination token from a previous call.');

/** Attributes are attacker-controllable; summarise them without trusting them. */
function renderAttributes(attributes: Record<string, string> | undefined, maxBytes: number): string {
    if (attributes === undefined || Object.keys(attributes).length === 0) {
        return '(no attributes)';
    }
    const sanitized = sanitizeUntrusted(attributes, maxBytes);
    return fenceUntrusted(sanitized, 'thing-attributes');
}

/** An absent indexing mode means the feature is off, not unknown. */
function showMode(value: string | undefined): string {
    return show(value, 'OFF');
}

function attributeSignals(attributes: Record<string, string> | undefined, maxBytes: number): string[] {
    if (attributes === undefined) {
        return [];
    }
    return sanitizeUntrusted(attributes, maxBytes).signals.map((signal) => signal.id);
}

export const listThings = defineTool({
    name: 'list_things',
    title: 'List IoT things',
    description:
        'Lists AWS IoT things in the configured region, newest page first, with optional filters by ' +
        'thing type or by a single attribute name/value pair. Use this to discover thing names before ' +
        'inspecting a shadow. Returns names and types only — call describe_thing for detail.',
    inputSchema: {
        max_results: z.coerce
            .number()
            .int()
            .positive()
            .max(250)
            .optional()
            .describe('Items per page. Clamped by server policy.'),
        next_token: nextToken,
        thing_type_name: z.string().min(1).optional().describe('Only things of this thing type.'),
        attribute_name: z
            .string()
            .min(1)
            .optional()
            .describe('Filter by attribute name. Requires attribute_value.'),
        attribute_value: z
            .string()
            .min(1)
            .optional()
            .describe('Filter by attribute value. Requires attribute_name.'),
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        if ((args.attribute_name === undefined) !== (args.attribute_value === undefined)) {
            return {
                text:
                    'attribute_name and attribute_value must be provided together — AWS ignores a ' +
                    'half-specified attribute filter, which would silently return the whole fleet.',
            };
        }

        const maxResults = ctx.policy.clampItems(args.max_results);
        const response = await ctx.control.listThings({
            maxResults,
            nextToken: args.next_token,
            thingTypeName: args.thing_type_name,
            attributeName: args.attribute_name,
            attributeValue: args.attribute_value,
        });

        const { allowed, refused } = ctx.policy.filterThings(response.things.map((thing) => thing.thingName));
        const allowedSet = new Set(allowed);
        const things = response.things.filter((thing) => allowedSet.has(thing.thingName));

        const table = renderTable(
            ['THING', 'TYPE', 'VERSION', 'ATTRS'],
            things.map((thing) => [
                thing.thingName,
                show(thing.thingTypeName),
                show(thing.version),
                String(Object.keys(thing.attributes ?? {}).length),
            ]),
            'No things matched in this region.',
        );

        return {
            text: renderSections([
                table,
                refused.length > 0 ? `${refused.length} thing(s) hidden by the configured scope.` : undefined,
                paginationNote(things.length, response.nextToken),
            ]),
        };
    },
});

export const describeThing = defineTool({
    name: 'describe_thing',
    title: 'Describe an IoT thing',
    description:
        'Returns the registry record of one thing: ARN, thing type, version, billing group, its thing ' +
        'groups, and its attributes. Attributes are returned inside an untrusted-data fence because any ' +
        'principal with UpdateThing can write them.',
    inputSchema: {
        thing_name: thingName,
        include_groups: z
            .boolean()
            .optional()
            .describe('Also list the thing groups this thing belongs to. Default true.'),
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        ctx.policy.assertThingAllowed(args.thing_name);
        const thing = await ctx.control.describeThing(args.thing_name);

        let groups: string[] | undefined;
        if (args.include_groups !== false) {
            groups = await ctx.control.listThingGroupsForThing(args.thing_name);
        }

        const details = renderKeyValues([
            ['Thing', thing.thingName],
            ['Thing ID', thing.thingId],
            ['ARN', thing.thingArn],
            ['Type', thing.thingTypeName],
            ['Version', thing.version === undefined ? undefined : String(thing.version)],
            ['Billing group', thing.billingGroupName],
            ['Region', ctx.region],
        ]);

        return {
            text: renderSections([
                details,
                groups === undefined ? undefined : `Thing groups:\n${renderList(groups)}`,
                `Attributes:\n${renderAttributes(thing.attributes, ctx.policy.maxUntrustedBytes)}`,
            ]),
            signals: attributeSignals(thing.attributes, ctx.policy.maxUntrustedBytes),
        };
    },
});

export const searchFleetIndex = defineTool({
    name: 'search_fleet_index',
    title: 'Search the fleet index',
    description:
        'Runs a fleet-indexing query (AWS_Things index) and returns matching things with their ' +
        'connectivity state when connectivity indexing is enabled. This is the only way to answer ' +
        '"which devices are offline right now". Query syntax examples: ' +
        'connectivity.connected:false — thingName:gw-* — attributes.site:santiago — ' +
        'shadow.reported.firmware:1.2.3. Requires fleet indexing to be enabled on the account.',
    inputSchema: {
        query: z
            .string()
            .min(1)
            .max(1000)
            .describe('Fleet-index query string. Use * as a wildcard; field:value syntax.'),
        max_results: z.coerce.number().int().positive().max(250).optional(),
        next_token: nextToken,
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        const maxResults = ctx.policy.clampItems(args.max_results);
        const response = await ctx.control.searchIndex({
            queryString: args.query,
            maxResults,
            nextToken: args.next_token,
        });

        const { allowed } = ctx.policy.filterThings(response.things.map((thing) => thing.thingName));
        const allowedSet = new Set(allowed);
        const things = response.things.filter((thing) => allowedSet.has(thing.thingName));
        const hidden = response.things.length - things.length;

        const table = renderTable(
            ['THING', 'TYPE', 'CONNECTED', 'LAST TRANSITION', 'REASON'],
            things.map((thing) => [
                thing.thingName,
                show(thing.thingTypeName),
                thing.connectivity?.connected === undefined
                    ? 'unknown'
                    : String(thing.connectivity.connected),
                showTimestamp(thing.connectivity?.timestampMs),
                show(thing.connectivity?.disconnectReason),
            ]),
            'No things matched the query.',
        );

        const connectivityKnown = things.some((thing) => thing.connectivity !== undefined);
        const note =
            things.length > 0 && !connectivityKnown
                ? 'Connectivity is reported as unknown for every match: connectivity indexing is ' +
                  'probably disabled. Enable it with iot:UpdateIndexingConfiguration ' +
                  '(thingConnectivityIndexingMode=STATUS).'
                : undefined;

        return {
            text: renderSections([
                table,
                note,
                hidden > 0 ? `${hidden} match(es) hidden by the configured scope.` : undefined,
                paginationNote(things.length, response.nextToken),
            ]),
        };
    },
});

export const describeIndexingConfiguration = defineTool({
    name: 'describe_indexing_configuration',
    title: 'Describe fleet indexing configuration',
    description:
        'Reports whether fleet indexing is enabled and which modes are active (registry, shadow, ' +
        'connectivity, named shadows). Call this first when search_fleet_index returns nothing or ' +
        'reports unknown connectivity — it distinguishes "no matches" from "not indexed".',
    inputSchema: {},
    annotations: READ_ONLY,
    async handler(_args, ctx) {
        const config = await ctx.control.getIndexingConfiguration();

        return {
            text: renderSections([
                renderKeyValues([
                    ['Registry indexing', showMode(config.thingIndexingMode)],
                    ['Connectivity indexing', showMode(config.thingConnectivityIndexingMode)],
                    ['Named shadow indexing', showMode(config.namedShadowIndexingMode)],
                    ['Region', ctx.region],
                ]),
                config.thingIndexingMode === undefined || config.thingIndexingMode === 'OFF'
                    ? 'Fleet indexing is off: search_fleet_index cannot answer any query until it is enabled.'
                    : undefined,
            ]),
        };
    },
});

export const thingTools = [listThings, describeThing, searchFleetIndex, describeIndexingConfiguration];
