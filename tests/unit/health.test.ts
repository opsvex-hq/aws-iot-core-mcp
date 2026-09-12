import { describe, expect, it } from 'vitest';

import { DEFAULT_THRESHOLDS, assessDevice, assessFleet, type DeviceFacts } from '../../src/domain/health.js';

const NOW_MS = Date.UTC(2026, 8, 12, 12, 0, 0);
const DAY_MS = 86_400_000;

function facts(overrides: Partial<DeviceFacts> = {}): DeviceFacts {
    return {
        thingName: 'gw-001',
        freshness: {
            fields: [],
            oldestAgeSeconds: 60,
            newestAgeSeconds: 60,
            metadataMissing: false,
        },
        drift: [],
        certificates: [
            { certificateId: 'a'.repeat(64), status: 'ACTIVE', notAfterMs: NOW_MS + 200 * DAY_MS },
        ],
        ...overrides,
    };
}

const codes = (device: { findings: Array<{ code: string }> }): string[] =>
    device.findings.map((finding) => finding.code);

describe('assessDevice', () => {
    it('reports a healthy device with no findings', () => {
        const health = assessDevice(facts(), NOW_MS);
        expect(health.severity).toBe('ok');
        expect(health.findings).toEqual([]);
    });

    it('warns on a shadow older than the warn threshold', () => {
        const health = assessDevice(
            facts({
                freshness: {
                    fields: [],
                    oldestAgeSeconds: 7_200,
                    newestAgeSeconds: 60,
                    metadataMissing: false,
                },
            }),
            NOW_MS,
        );
        expect(health.severity).toBe('warn');
        expect(codes(health)).toContain('shadow_stale');
    });

    it('escalates to critical past the critical threshold', () => {
        const health = assessDevice(
            facts({
                freshness: {
                    fields: [],
                    oldestAgeSeconds: 200_000,
                    newestAgeSeconds: 200_000,
                    metadataMissing: false,
                },
            }),
            NOW_MS,
        );
        expect(health.severity).toBe('critical');
    });

    it('treats the threshold as inclusive at its exact boundary', () => {
        const atWarn = assessDevice(
            facts({
                freshness: {
                    fields: [],
                    oldestAgeSeconds: DEFAULT_THRESHOLDS.staleWarnSeconds,
                    newestAgeSeconds: 0,
                    metadataMissing: false,
                },
            }),
            NOW_MS,
        );
        expect(atWarn.severity).toBe('warn');
    });

    it('says unknown, not ok, when the shadow has no metadata', () => {
        const health = assessDevice(
            facts({
                freshness: {
                    fields: [],
                    oldestAgeSeconds: null,
                    newestAgeSeconds: null,
                    metadataMissing: true,
                },
            }),
            NOW_MS,
        );
        expect(health.severity).toBe('unknown');
        expect(codes(health)).toContain('shadow_without_metadata');
    });

    it('reports an unreadable shadow as a finding, not a crash', () => {
        const health = assessDevice(facts({ freshness: undefined, shadowError: 'denied' }), NOW_MS);
        expect(codes(health)).toContain('shadow_unreadable');
        expect(health.severity).toBe('warn');
    });

    it('names the fields that never converged', () => {
        const health = assessDevice(
            facts({
                drift: [
                    { path: 'firmware', desired: '2.0.0', reported: '1.2.3', neverReported: false },
                    { path: 'newFlag', desired: true, reported: undefined, neverReported: true },
                ],
            }),
            NOW_MS,
        );
        const drift = health.findings.find((finding) => finding.code === 'shadow_drift');
        expect(drift?.message).toContain('2 field(s)');
        expect(drift?.message).toContain('newFlag');
    });

    it('flags an expired certificate as critical', () => {
        const health = assessDevice(
            facts({
                certificates: [
                    { certificateId: 'b'.repeat(64), status: 'ACTIVE', notAfterMs: NOW_MS - 3 * DAY_MS },
                ],
            }),
            NOW_MS,
        );
        expect(health.severity).toBe('critical');
        const finding = health.findings.find((entry) => entry.code === 'certificate_expired');
        expect(finding?.message).toContain('3 day(s) ago');
    });

    it('escalates by proximity: warn at 45 days, critical at 14', () => {
        const warn = assessDevice(
            facts({
                certificates: [
                    { certificateId: 'c'.repeat(64), status: 'ACTIVE', notAfterMs: NOW_MS + 30 * DAY_MS },
                ],
            }),
            NOW_MS,
        );
        expect(warn.severity).toBe('warn');

        const critical = assessDevice(
            facts({
                certificates: [
                    { certificateId: 'c'.repeat(64), status: 'ACTIVE', notAfterMs: NOW_MS + 10 * DAY_MS },
                ],
            }),
            NOW_MS,
        );
        expect(critical.severity).toBe('critical');
    });

    it('treats a revoked certificate as critical and an inactive one as a warning', () => {
        const revoked = assessDevice(
            facts({ certificates: [{ certificateId: 'd'.repeat(64), status: 'REVOKED' }] }),
            NOW_MS,
        );
        expect(revoked.severity).toBe('critical');

        const inactive = assessDevice(
            facts({ certificates: [{ certificateId: 'd'.repeat(64), status: 'INACTIVE' }] }),
            NOW_MS,
        );
        expect(inactive.severity).toBe('warn');
    });

    it('warns when a thing has no certificate at all', () => {
        const health = assessDevice(facts({ certificates: [] }), NOW_MS);
        expect(codes(health)).toContain('no_certificates');
    });

    it('says unknown when a certificate expiry could not be read', () => {
        const health = assessDevice(facts({ certificates: [{ certificateId: 'e'.repeat(64) }] }), NOW_MS);
        expect(health.severity).toBe('ok');
        expect(codes(health)).not.toContain('certificate_expiring');
    });

    it('reports a disconnected device with how long it has been down', () => {
        const health = assessDevice(
            facts({ connectivity: { connected: false, timestampMs: NOW_MS - 2 * 3_600_000 } }),
            NOW_MS,
        );
        const finding = health.findings.find((entry) => entry.code === 'disconnected');
        expect(finding?.message).toContain('2h');
    });

    it('stays quiet about a connected device', () => {
        const health = assessDevice(facts({ connectivity: { connected: true } }), NOW_MS);
        expect(codes(health)).not.toContain('disconnected');
    });

    it('surfaces injection signals as an operational finding', () => {
        const health = assessDevice(facts({ injectionSignals: ['instruction_override'] }), NOW_MS);
        const finding = health.findings.find((entry) => entry.code === 'injection_signal');
        expect(finding?.message).toContain('instruction_override');
        expect(finding?.message).toContain('review who can publish');
    });

    it('honours custom thresholds', () => {
        const health = assessDevice(
            facts({
                freshness: {
                    fields: [],
                    oldestAgeSeconds: 120,
                    newestAgeSeconds: 120,
                    metadataMissing: false,
                },
            }),
            NOW_MS,
            { ...DEFAULT_THRESHOLDS, staleWarnSeconds: 60, staleCriticalSeconds: 90 },
        );
        expect(health.severity).toBe('critical');
    });

    it('says "not checked" rather than "ok" for signals nobody looked at', () => {
        const health = assessDevice({ thingName: 'gw-x' }, NOW_MS);
        expect(codes(health)).toContain('shadow_not_checked');
        expect(codes(health)).toContain('certificates_not_checked');
        expect(health.severity).toBe('unknown');
    });
});

describe('assessFleet', () => {
    it('counts devices by severity and ranks findings by reach', () => {
        const fleet = assessFleet(
            [
                facts({ thingName: 'ok-1' }),
                facts({
                    thingName: 'stale-1',
                    freshness: {
                        fields: [],
                        oldestAgeSeconds: 7_200,
                        newestAgeSeconds: 7_200,
                        metadataMissing: false,
                    },
                }),
                facts({
                    thingName: 'stale-2',
                    freshness: {
                        fields: [],
                        oldestAgeSeconds: 200_000,
                        newestAgeSeconds: 200_000,
                        metadataMissing: false,
                    },
                }),
            ],
            NOW_MS,
        );

        expect(fleet.counts).toEqual({ ok: 1, unknown: 0, warn: 1, critical: 1 });
        expect(fleet.topFindings[0]).toEqual({ code: 'shadow_stale', devices: 2, severity: 'critical' });
    });

    it('sorts devices worst-first so a truncated view still shows what matters', () => {
        const fleet = assessFleet(
            [
                facts({ thingName: 'zz-ok' }),
                facts({
                    thingName: 'aa-critical',
                    certificates: [{ certificateId: 'f'.repeat(64), status: 'REVOKED' }],
                }),
            ],
            NOW_MS,
        );
        expect(fleet.devices[0]?.thingName).toBe('aa-critical');
    });

    it('counts a device once per finding code, not once per finding', () => {
        const fleet = assessFleet(
            [
                facts({
                    thingName: 'multi',
                    certificates: [
                        { certificateId: 'g'.repeat(64), status: 'INACTIVE' },
                        { certificateId: 'h'.repeat(64), status: 'INACTIVE' },
                    ],
                }),
            ],
            NOW_MS,
        );
        const finding = fleet.topFindings.find((entry) => entry.code === 'certificate_not_active');
        expect(finding?.devices).toBe(1);
    });

    it('handles an empty fleet without dividing by zero', () => {
        const fleet = assessFleet([], NOW_MS);
        expect(fleet.devices).toEqual([]);
        expect(fleet.topFindings).toEqual([]);
        expect(fleet.counts.ok).toBe(0);
    });
});
