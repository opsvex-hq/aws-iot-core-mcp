/**
 * Topic-rule and endpoint tools.
 *
 * Rule SQL is customer-authored text. It is shown fenced for the same reason a
 * shadow is: a rule description is a perfectly good place to hide an
 * instruction aimed at whoever reads the account next.
 */

import { z } from 'zod';

import {
    paginationNote,
    renderKeyValues,
    renderSections,
    renderTable,
    show,
    showTimestamp,
} from '../domain/render.js';
import { fenceUntrusted, sanitizeUntrusted } from '../domain/untrusted.js';
import { READ_ONLY, defineTool } from './types.js';

/** Endpoint types AWS exposes, with the one you almost always want first. */
const ENDPOINT_TYPES = ['iot:Data-ATS', 'iot:Jobs', 'iot:CredentialProvider', 'iot:Data'] as const;

export const listTopicRules = defineTool({
    name: 'list_topic_rules',
    title: 'List IoT topic rules',
    description:
        'Lists the topic rules of the account with their topic filter and whether they are disabled. ' +
        'Use it to answer "where does telemetry from this topic go?" before opening a single rule.',
    inputSchema: {
        max_results: z.coerce.number().int().positive().max(250).optional(),
        next_token: z.string().min(1).optional(),
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        const maxResults = ctx.policy.clampItems(args.max_results);
        const response = await ctx.control.listTopicRules({ maxResults, nextToken: args.next_token });

        const table = renderTable(
            ['RULE', 'TOPIC FILTER', 'STATE', 'CREATED (UTC)'],
            response.rules.map((rule) => [
                rule.ruleName,
                show(rule.topicPattern),
                rule.ruleDisabled === true ? 'DISABLED' : 'enabled',
                showTimestamp(rule.createdAtMs),
            ]),
            'No topic rules in this region.',
        );

        const disabled = response.rules.filter((rule) => rule.ruleDisabled === true).length;

        return {
            text: renderSections([
                table,
                disabled > 0
                    ? `${disabled} rule(s) are disabled — a disabled rule silently drops matching messages.`
                    : undefined,
                paginationNote(response.rules.length, response.nextToken),
            ]),
        };
    },
});

export const describeTopicRule = defineTool({
    name: 'describe_topic_rule',
    title: 'Describe an IoT topic rule',
    description:
        'Returns one topic rule in full: its SQL, its SQL version, every action with the target it ' +
        'writes to, and its error action. A rule without an error action loses messages silently when ' +
        'its action fails, which this tool calls out explicitly.',
    inputSchema: { rule_name: z.string().min(1).max(128).describe('Exact topic rule name.') },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        const rule = await ctx.control.getTopicRule(args.rule_name);
        const sanitizedSql = sanitizeUntrusted(rule.sql ?? '(no SQL)', ctx.policy.maxUntrustedBytes);
        const sanitizedDescription =
            rule.description === undefined || rule.description === ''
                ? undefined
                : sanitizeUntrusted(rule.description, 2000);

        const actions = renderTable(
            ['ACTION', 'TARGET'],
            rule.actions.map((action) => [action.type, show(action.target)]),
            'Rule has no actions — matching messages go nowhere.',
        );

        const signals = [
            ...new Set([
                ...sanitizedSql.signals.map((signal) => signal.id),
                ...(sanitizedDescription?.signals.map((signal) => signal.id) ?? []),
            ]),
        ];

        return {
            text: renderSections([
                renderKeyValues([
                    ['Rule', rule.ruleName],
                    ['State', rule.ruleDisabled === true ? 'DISABLED' : 'enabled'],
                    ['SQL version', show(rule.awsIotSqlVersion)],
                    ['Created', showTimestamp(rule.createdAtMs)],
                    ['Actions', String(rule.actions.length)],
                    [
                        'Error action',
                        rule.errorAction === undefined
                            ? 'none — failed actions are dropped without a trace'
                            : `${rule.errorAction.type}${rule.errorAction.target ? ` -> ${rule.errorAction.target}` : ''}`,
                    ],
                ]),
                sanitizedDescription === undefined
                    ? undefined
                    : `Description:\n${fenceUntrusted(sanitizedDescription, 'topic-rule-description')}`,
                `SQL:\n${fenceUntrusted(sanitizedSql, 'topic-rule-sql')}`,
                `Actions:\n${actions}`,
            ]),
            signals,
        };
    },
});

export const describeIotEndpoint = defineTool({
    name: 'describe_iot_endpoint',
    title: 'Describe the account IoT endpoints',
    description:
        'Returns the account-specific IoT endpoint addresses. iot:Data-ATS is the MQTT/HTTPS data ' +
        'endpoint devices connect to; the others serve jobs and the credential provider. Endpoints are ' +
        'per account and per region, which is the usual cause of "the device connects but nothing arrives".',
    inputSchema: {
        endpoint_type: z
            .enum(ENDPOINT_TYPES)
            .optional()
            .describe('Which endpoint to resolve. Omit to resolve the data endpoint (iot:Data-ATS).'),
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        const endpointType = args.endpoint_type ?? 'iot:Data-ATS';
        const address = await ctx.control.describeEndpoint(endpointType);
        return {
            text: renderKeyValues([
                ['Endpoint type', endpointType],
                ['Address', address === '' ? '(empty response)' : address],
                ['Region', ctx.region],
            ]),
        };
    },
});

export const ruleTools = [listTopicRules, describeTopicRule, describeIotEndpoint];
