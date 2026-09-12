/**
 * Fleet health assessment.
 *
 * This is the diagnostic core of the server and it follows one rule, borrowed
 * from the only reference implementation we found that publishes its own hit
 * rate: **the tool diagnoses, it never remediates.** It maps facts already
 * fetched from AWS onto findings with a severity, and stops there. No command
 * is published, no shadow is written, no certificate is rotated.
 *
 * Pure by construction: thresholds and the current time come in as arguments,
 * so the same input always produces the same findings.
 */

import type { DriftEntry, ShadowFreshness } from './shadow.js';
import { formatAge } from './shadow.js';

export type HealthSeverity = 'ok' | 'unknown' | 'warn' | 'critical';

const SEVERITY_ORDER: Record<HealthSeverity, number> = {
    ok: 0,
    unknown: 1,
    warn: 2,
    critical: 3,
};

export interface CertificateFact {
    certificateId: string;
    /** AWS certificate status, e.g. `ACTIVE`, `INACTIVE`, `REVOKED`. */
    status?: string;
    /** Expiry as epoch milliseconds, when it could be read. */
    notAfterMs?: number;
}

export interface ConnectivityFact {
    connected: boolean;
    /** Epoch milliseconds of the last connectivity transition, when known. */
    timestampMs?: number;
    disconnectReason?: string;
}

export interface DeviceFacts {
    thingName: string;
    /** Absent when the shadow could not be read; `error` says why. */
    freshness?: ShadowFreshness;
    drift?: DriftEntry[];
    /** Set when reading or parsing the shadow failed. */
    shadowError?: string;
    /** Injection signal ids raised while sanitising this device's payload. */
    injectionSignals?: string[];
    /** Absent when the principals could not be listed. */
    certificates?: CertificateFact[];
    /** Absent when fleet indexing with connectivity is not enabled. */
    connectivity?: ConnectivityFact;
}

export interface HealthThresholds {
    /** Reported data older than this is a warning. */
    staleWarnSeconds: number;
    /** Reported data older than this is critical. */
    staleCriticalSeconds: number;
    /** Certificates expiring within this many days are a warning. */
    certWarnDays: number;
    /** Certificates expiring within this many days are critical. */
    certCriticalDays: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
    staleWarnSeconds: 3_600, // 1 hour
    staleCriticalSeconds: 86_400, // 1 day
    certWarnDays: 45,
    certCriticalDays: 14,
};

export interface HealthFinding {
    /** Stable code, safe to alert on. */
    code: string;
    severity: HealthSeverity;
    message: string;
}

export interface DeviceHealth {
    thingName: string;
    severity: HealthSeverity;
    findings: HealthFinding[];
}

export interface FleetHealth {
    devices: DeviceHealth[];
    counts: Record<HealthSeverity, number>;
    /** Finding codes ordered by how many devices raised them. */
    topFindings: Array<{ code: string; devices: number; severity: HealthSeverity }>;
}

function worst(a: HealthSeverity, b: HealthSeverity): HealthSeverity {
    return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

const DAY_MS = 86_400_000;

/** Assesses one device against the thresholds. */
export function assessDevice(
    facts: DeviceFacts,
    nowMs: number,
    thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): DeviceHealth {
    const findings: HealthFinding[] = [];

    // --- Shadow readability and freshness -----------------------------------
    if (facts.shadowError !== undefined) {
        findings.push({
            code: 'shadow_unreadable',
            severity: 'warn',
            message: `Shadow could not be read: ${facts.shadowError}`,
        });
    } else if (facts.freshness === undefined) {
        findings.push({
            code: 'shadow_not_checked',
            severity: 'unknown',
            message: 'Shadow was not inspected for this device.',
        });
    } else if (facts.freshness.metadataMissing) {
        findings.push({
            code: 'shadow_without_metadata',
            severity: 'unknown',
            message: 'Shadow carries no reported-field timestamps, so freshness cannot be judged.',
        });
    } else {
        const age = facts.freshness.oldestAgeSeconds ?? 0;
        if (age >= thresholds.staleCriticalSeconds) {
            findings.push({
                code: 'shadow_stale',
                severity: 'critical',
                message: `Oldest reported field is ${formatAge(age)} old (critical at ${formatAge(
                    thresholds.staleCriticalSeconds,
                )}).`,
            });
        } else if (age >= thresholds.staleWarnSeconds) {
            findings.push({
                code: 'shadow_stale',
                severity: 'warn',
                message: `Oldest reported field is ${formatAge(age)} old (warning at ${formatAge(
                    thresholds.staleWarnSeconds,
                )}).`,
            });
        }
    }

    // --- Desired/reported convergence ---------------------------------------
    const drift = facts.drift ?? [];
    if (drift.length > 0) {
        const neverReported = drift.filter((entry) => entry.neverReported);
        findings.push({
            code: 'shadow_drift',
            severity: 'warn',
            message:
                `${drift.length} field(s) have not converged` +
                (neverReported.length > 0
                    ? `, ${neverReported.length} never reported at all (${neverReported
                          .slice(0, 3)
                          .map((entry) => entry.path)
                          .join(', ')})`
                    : ` (${drift
                          .slice(0, 3)
                          .map((entry) => entry.path)
                          .join(', ')})`) +
                '.',
        });
    }

    // --- Certificates --------------------------------------------------------
    if (facts.certificates === undefined) {
        findings.push({
            code: 'certificates_not_checked',
            severity: 'unknown',
            message: 'Certificates were not inspected for this device.',
        });
    } else if (facts.certificates.length === 0) {
        findings.push({
            code: 'no_certificates',
            severity: 'warn',
            message: 'Thing has no attached certificate principal.',
        });
    } else {
        for (const certificate of facts.certificates) {
            const label = certificate.certificateId.slice(0, 12);
            if (certificate.status !== undefined && certificate.status !== 'ACTIVE') {
                findings.push({
                    code: 'certificate_not_active',
                    severity: certificate.status === 'REVOKED' ? 'critical' : 'warn',
                    message: `Certificate ${label} is ${certificate.status}.`,
                });
            }
            if (certificate.notAfterMs === undefined) {
                continue;
            }
            const daysLeft = Math.floor((certificate.notAfterMs - nowMs) / DAY_MS);
            if (daysLeft < 0) {
                findings.push({
                    code: 'certificate_expired',
                    severity: 'critical',
                    message: `Certificate ${label} expired ${-daysLeft} day(s) ago.`,
                });
            } else if (daysLeft <= thresholds.certCriticalDays) {
                findings.push({
                    code: 'certificate_expiring',
                    severity: 'critical',
                    message: `Certificate ${label} expires in ${daysLeft} day(s).`,
                });
            } else if (daysLeft <= thresholds.certWarnDays) {
                findings.push({
                    code: 'certificate_expiring',
                    severity: 'warn',
                    message: `Certificate ${label} expires in ${daysLeft} day(s).`,
                });
            }
        }
    }

    // --- Connectivity --------------------------------------------------------
    if (facts.connectivity !== undefined && !facts.connectivity.connected) {
        const since =
            facts.connectivity.timestampMs !== undefined
                ? ` for ${formatAge(Math.floor((nowMs - facts.connectivity.timestampMs) / 1000))}`
                : '';
        const reason =
            facts.connectivity.disconnectReason !== undefined
                ? ` (${facts.connectivity.disconnectReason})`
                : '';
        findings.push({
            code: 'disconnected',
            severity: 'warn',
            message: `Device is disconnected${since}${reason}.`,
        });
    }

    // --- Untrusted-payload signals ------------------------------------------
    const signals = facts.injectionSignals ?? [];
    if (signals.length > 0) {
        findings.push({
            code: 'injection_signal',
            severity: 'warn',
            message:
                `Device payload raised injection signal(s): ${signals.join(', ')}. ` +
                'Treat this device data as hostile input and review who can publish to its shadow.',
        });
    }

    const severity = findings.reduce<HealthSeverity>((acc, finding) => worst(acc, finding.severity), 'ok');
    return { thingName: facts.thingName, severity, findings };
}

/** Assesses a set of devices and aggregates the result. */
export function assessFleet(
    facts: readonly DeviceFacts[],
    nowMs: number,
    thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): FleetHealth {
    const devices = facts.map((fact) => assessDevice(fact, nowMs, thresholds));
    const counts: Record<HealthSeverity, number> = { ok: 0, unknown: 0, warn: 0, critical: 0 };
    const byCode = new Map<string, { devices: number; severity: HealthSeverity }>();

    for (const device of devices) {
        counts[device.severity] += 1;
        const seen = new Set<string>();
        for (const finding of device.findings) {
            if (seen.has(finding.code)) {
                continue;
            }
            seen.add(finding.code);
            const current = byCode.get(finding.code);
            if (current === undefined) {
                byCode.set(finding.code, { devices: 1, severity: finding.severity });
            } else {
                current.devices += 1;
                current.severity = worst(current.severity, finding.severity);
            }
        }
    }

    const topFindings = [...byCode.entries()]
        .map(([code, value]) => ({ code, devices: value.devices, severity: value.severity }))
        .toSorted(
            (a, b) =>
                b.devices - a.devices ||
                SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
                a.code.localeCompare(b.code),
        );

    // Worst-first, so a truncated view still shows what matters.
    const ordered = devices.toSorted(
        (a, b) =>
            SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.thingName.localeCompare(b.thingName),
    );

    return { devices: ordered, counts, topFindings };
}
