/**
 * Diagnostic tools: certificates and fleet health.
 *
 * `assess_fleet_health` is the reason this server exists. It answers the
 * question an operator actually asks — "what is wrong with my fleet right
 * now?" — by combining three signals AWS keeps in three different places:
 * shadow freshness (data plane), certificate expiry (control plane) and
 * connectivity (fleet index).
 *
 * It diagnoses and stops. There is no remediation path, not even a suggested
 * CLI command that would mutate state, because a tool that both diagnoses and
 * repairs is a tool nobody can safely give an autonomous agent.
 *
 * Partial failure is normal at fleet scale: one unreadable shadow must not sink
 * the report. Per-device errors become findings, not exceptions.
 */

import { z } from 'zod';

import { translateAwsError } from '../aws/errors.js';
import { certificateIdFromPrincipalArn } from '../aws/ports.js';
import type { CertificateFact, DeviceFacts } from '../domain/health.js';
import { assessFleet } from '../domain/health.js';
import { parseShadowDocument, shadowDrift, shadowFreshness } from '../domain/shadow.js';
import { renderKeyValues, renderSections, renderTable, show, showTimestamp } from '../domain/render.js';
import { sanitizeUntrusted } from '../domain/untrusted.js';
import type { ToolContext } from './types.js';
import { READ_ONLY, defineTool } from './types.js';

const DAY_MS = 86_400_000;

/** Reads every certificate attached to a thing, tolerating per-cert failures. */
async function readCertificates(
    thingName: string,
    ctx: ToolContext,
): Promise<{ certificates?: CertificateFact[]; error?: string }> {
    try {
        const principals = await ctx.control.listThingPrincipals(thingName);
        const certificateIds = principals
            .map(certificateIdFromPrincipalArn)
            .filter((id): id is string => id !== undefined);

        const certificates: CertificateFact[] = [];
        for (const certificateId of certificateIds) {
            try {
                const detail = await ctx.control.describeCertificate(certificateId);
                certificates.push({
                    certificateId: detail.certificateId,
                    status: detail.status,
                    notAfterMs: detail.notAfterMs,
                });
            } catch {
                // The principal exists but cannot be described (usually a missing
                // iot:DescribeCertificate permission). Record it without expiry so
                // the assessment says "unknown" instead of "fine".
                certificates.push({ certificateId });
            }
        }
        return { certificates };
    } catch (error) {
        return { error: translateAwsError(error).message };
    }
}

export const inspectThingCertificates = defineTool({
    name: 'inspect_thing_certificates',
    title: 'Inspect the certificates of a thing',
    description:
        'Lists the X.509 certificates attached to a thing with their status and expiry date, and flags ' +
        'the ones that are inactive, revoked, already expired or expiring soon. Certificate expiry is ' +
        'the classic silent fleet outage: everything works until the day it does not.',
    inputSchema: {
        thing_name: z.string().min(1).max(128).describe('Exact AWS IoT thing name.'),
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        ctx.policy.assertThingAllowed(args.thing_name);
        const result = await readCertificates(args.thing_name, ctx);

        if (result.error !== undefined) {
            return { text: `Could not list principals of "${args.thing_name}": ${result.error}` };
        }

        const certificates = result.certificates ?? [];
        const now = ctx.now();

        const table = renderTable(
            ['CERTIFICATE', 'STATUS', 'EXPIRES (UTC)', 'DAYS LEFT'],
            certificates.map((certificate) => [
                certificate.certificateId.slice(0, 16),
                show(certificate.status, 'unknown'),
                showTimestamp(certificate.notAfterMs),
                certificate.notAfterMs === undefined
                    ? 'unknown'
                    : String(Math.floor((certificate.notAfterMs - now) / DAY_MS)),
            ]),
            'This thing has no certificate principal attached.',
        );

        const assessment = assessFleet([{ thingName: args.thing_name, certificates }], now, ctx.thresholds);
        const findings = assessment.devices[0]?.findings ?? [];

        return {
            text: renderSections([
                table,
                findings.length === 0
                    ? 'No certificate findings.'
                    : `Findings:\n${renderTable(
                          ['SEVERITY', 'CODE', 'DETAIL'],
                          findings
                              .filter(
                                  (finding) =>
                                      finding.code.startsWith('certificate') ||
                                      finding.code === 'no_certificates',
                              )
                              .map((finding) => [finding.severity, finding.code, finding.message]),
                          'No certificate findings.',
                      )}`,
            ]),
        };
    },
});

export const assessFleetHealth = defineTool({
    name: 'assess_fleet_health',
    title: 'Assess fleet health',
    description:
        'Diagnostic sweep over a sample of things. For each one it checks shadow freshness, ' +
        'desired-vs-reported convergence, certificate status and expiry, and connectivity when the ' +
        'fleet index provides it, then returns findings ranked worst-first with a per-code summary. ' +
        'Read-only and non-prescriptive: it reports what is wrong and never changes anything. Give it ' +
        'either an explicit list of thing names or a fleet-index query.',
    inputSchema: {
        thing_names: z
            .array(z.string().min(1).max(128))
            .min(1)
            .max(100)
            .optional()
            .describe('Explicit things to inspect. Mutually exclusive with query.'),
        query: z
            .string()
            .min(1)
            .max(1000)
            .optional()
            .describe('Fleet-index query selecting the things to inspect, e.g. thingName:gw-*'),
        max_things: z.coerce
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe('Sample ceiling. Clamped by server policy.'),
        shadow_name: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe('Inspect this named shadow instead of the classic one.'),
        include_certificates: z
            .boolean()
            .optional()
            .describe('Inspect certificates too. Default true. Costs 1-2 extra API calls per thing.'),
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
        if ((args.thing_names === undefined) === (args.query === undefined)) {
            return {
                text: 'Provide exactly one of thing_names or query.',
            };
        }

        const limit = ctx.policy.clampFleetSample(args.max_things);
        let candidates: string[];
        let connectivity = new Map<string, DeviceFacts['connectivity']>();

        if (args.thing_names !== undefined) {
            candidates = args.thing_names.slice(0, limit);
        } else {
            const response = await ctx.control.searchIndex({
                queryString: args.query as string,
                maxResults: limit,
            });
            candidates = response.things.map((thing) => thing.thingName);
            connectivity = new Map(
                response.things.map((thing) => [
                    thing.thingName,
                    thing.connectivity === undefined
                        ? undefined
                        : {
                              connected: thing.connectivity.connected ?? false,
                              timestampMs: thing.connectivity.timestampMs,
                              disconnectReason: thing.connectivity.disconnectReason,
                          },
                ]),
            );
        }

        const { allowed, refused } = ctx.policy.filterThings(candidates);
        const now = ctx.now();
        const withCertificates = args.include_certificates !== false;

        const facts: DeviceFacts[] = [];
        const allSignals = new Set<string>();

        for (const thingName of allowed) {
            const device: DeviceFacts = { thingName };
            const link = connectivity.get(thingName);
            if (link !== undefined) {
                device.connectivity = link;
            }

            try {
                const raw = await ctx.data.getThingShadow({ thingName, shadowName: args.shadow_name });
                const { document, parseError } = parseShadowDocument(raw);
                if (parseError !== undefined) {
                    device.shadowError = parseError;
                } else {
                    device.freshness = shadowFreshness(document, now);
                    device.drift = shadowDrift(document);
                    const signals = sanitizeUntrusted(document, ctx.policy.maxUntrustedBytes).signals.map(
                        (signal) => signal.id,
                    );
                    if (signals.length > 0) {
                        device.injectionSignals = signals;
                        for (const signal of signals) {
                            allSignals.add(signal);
                        }
                    }
                }
            } catch (error) {
                device.shadowError = translateAwsError(error).message;
            }

            if (withCertificates) {
                const result = await readCertificates(thingName, ctx);
                if (result.certificates !== undefined) {
                    device.certificates = result.certificates;
                }
            }

            facts.push(device);
        }

        if (facts.length === 0) {
            return {
                text:
                    'No things to assess.' +
                    (refused.length > 0
                        ? ` ${refused.length} candidate(s) were outside the configured scope.`
                        : ''),
            };
        }

        const fleet = assessFleet(facts, now, ctx.thresholds);

        const summary = renderKeyValues([
            ['Things assessed', String(fleet.devices.length)],
            ['Critical', String(fleet.counts.critical)],
            ['Warning', String(fleet.counts.warn)],
            ['Unknown', String(fleet.counts.unknown)],
            ['Healthy', String(fleet.counts.ok)],
            ['Shadow inspected', args.shadow_name ?? '(classic)'],
            ['Certificates inspected', withCertificates ? 'yes' : 'no'],
            [
                'Thresholds',
                `stale warn ${ctx.thresholds.staleWarnSeconds}s / critical ${ctx.thresholds.staleCriticalSeconds}s; ` +
                    `cert warn ${ctx.thresholds.certWarnDays}d / critical ${ctx.thresholds.certCriticalDays}d`,
            ],
        ]);

        const byDevice = renderTable(
            ['SEVERITY', 'THING', 'FINDINGS'],
            fleet.devices.map((device) => [
                device.severity.toUpperCase(),
                device.thingName,
                device.findings.length === 0
                    ? 'none'
                    : device.findings.map((finding) => finding.code).join(', '),
            ]),
        );

        const detail = fleet.devices
            .filter((device) => device.severity === 'critical' || device.severity === 'warn')
            .slice(0, 15)
            .map((device) =>
                [
                    `${device.thingName} [${device.severity}]`,
                    ...device.findings.map((finding) => `  - ${finding.severity}: ${finding.message}`),
                ].join('\n'),
            );

        const top = renderTable(
            ['CODE', 'DEVICES', 'WORST SEVERITY'],
            fleet.topFindings.map((finding) => [finding.code, String(finding.devices), finding.severity]),
            'No findings at all.',
        );

        return {
            text: renderSections([
                summary,
                `Per device:\n${byDevice}`,
                `Findings by code:\n${top}`,
                detail.length > 0 ? `Detail:\n${detail.join('\n\n')}` : undefined,
                refused.length > 0
                    ? `${refused.length} candidate(s) hidden by the configured scope.`
                    : undefined,
                allSignals.size > 0
                    ? `Injection signals raised by device payloads: ${[...allSignals].join(', ')}.`
                    : undefined,
            ]),
            signals: [...allSignals],
        };
    },
});

export const healthTools = [inspectThingCertificates, assessFleetHealth];
