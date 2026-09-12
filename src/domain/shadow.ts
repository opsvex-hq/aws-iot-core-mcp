/**
 * Device-shadow semantics.
 *
 * AWS returns a shadow as an opaque JSON payload. The three questions an
 * operator actually asks about it are not answered by that payload directly:
 *
 *   - "is the device doing what we asked?"      -> {@link shadowDrift}
 *   - "when did it last tell us anything?"      -> {@link shadowFreshness}
 *   - "what changed between these two devices?" -> {@link diffJson}
 *
 * Everything here is pure: no AWS client, no clock of its own (the caller
 * passes `nowMs`), no I/O. That is what makes the semantics testable, and the
 * semantics are the part that is easy to get subtly wrong.
 *
 * One unit gotcha this module encapsulates: shadow metadata timestamps are
 * epoch **seconds**, while `Date.now()` is milliseconds. Mixing them silently
 * reports every device as ~57 years stale.
 */

/** A shadow document as returned by the IoT data plane, parsed but not trusted. */
export interface ShadowDocument {
    state?: {
        desired?: Record<string, unknown>;
        reported?: Record<string, unknown>;
        delta?: Record<string, unknown>;
    };
    metadata?: {
        desired?: Record<string, unknown>;
        reported?: Record<string, unknown>;
    };
    version?: number;
    timestamp?: number;
}

export type JsonDiffKind = 'added' | 'removed' | 'changed';

export interface JsonDiffEntry {
    /** Dotted path, with array indices in brackets: `sensors.temp`, `tags[0]`. */
    path: string;
    kind: JsonDiffKind;
    left?: unknown;
    right?: unknown;
}

export interface DriftEntry {
    path: string;
    desired: unknown;
    reported: unknown;
    /** True when the path exists in `desired` but not in `reported` at all. */
    neverReported: boolean;
}

export interface FieldAge {
    path: string;
    /** Epoch seconds, as AWS reports it. */
    timestampSeconds: number;
    ageSeconds: number;
}

export interface ShadowFreshness {
    /** Per-field ages, oldest first. Empty when the shadow carries no metadata. */
    fields: FieldAge[];
    /** Age of the least recently updated reported field, or null if unknown. */
    oldestAgeSeconds: number | null;
    /** Age of the most recently updated reported field, or null if unknown. */
    newestAgeSeconds: number | null;
    /** True when the document carried no usable `metadata.reported` timestamps. */
    metadataMissing: boolean;
}

/** Type guard for a plain JSON object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(prefix: string, key: string): string {
    return prefix === '' ? key : `${prefix}.${key}`;
}

function joinIndex(prefix: string, index: number): string {
    return `${prefix}[${index}]`;
}

/**
 * Flattens a JSON value into `path -> leaf` pairs. A leaf is any non-object,
 * non-array value; an empty object or empty array is itself a leaf, because
 * "this key exists and is empty" is a distinct fact from "this key is absent".
 */
export function flattenJson(value: unknown, prefix = ''): Map<string, unknown> {
    const out = new Map<string, unknown>();

    if (Array.isArray(value)) {
        if (value.length === 0) {
            out.set(prefix, value);
            return out;
        }
        value.forEach((item, index) => {
            for (const [path, leaf] of flattenJson(item, joinIndex(prefix, index))) {
                out.set(path, leaf);
            }
        });
        return out;
    }

    if (isRecord(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            out.set(prefix, value);
            return out;
        }
        for (const key of keys.toSorted()) {
            for (const [path, leaf] of flattenJson(value[key], joinPath(prefix, key))) {
                out.set(path, leaf);
            }
        }
        return out;
    }

    out.set(prefix, value);
    return out;
}

/** True when two leaves are equal for diffing purposes (structural equality). */
function leafEquals(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (typeof left !== typeof right) {
        return false;
    }
    if (typeof left === 'object' && left !== null && right !== null) {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    return false;
}

/**
 * Structural diff of two JSON values, deterministic and sorted by path.
 * Used both for "desired vs reported" and for comparing two devices.
 */
export function diffJson(left: unknown, right: unknown): JsonDiffEntry[] {
    const leftLeaves = flattenJson(left);
    const rightLeaves = flattenJson(right);
    const paths = new Set([...leftLeaves.keys(), ...rightLeaves.keys()]);
    const entries: JsonDiffEntry[] = [];

    for (const path of [...paths].toSorted()) {
        const inLeft = leftLeaves.has(path);
        const inRight = rightLeaves.has(path);
        const leftValue = leftLeaves.get(path);
        const rightValue = rightLeaves.get(path);

        if (inLeft && !inRight) {
            entries.push({ path, kind: 'removed', left: leftValue });
        } else if (!inLeft && inRight) {
            entries.push({ path, kind: 'added', right: rightValue });
        } else if (!leafEquals(leftValue, rightValue)) {
            entries.push({ path, kind: 'changed', left: leftValue, right: rightValue });
        }
    }

    return entries;
}

/**
 * Fields where the device has not converged on what was asked of it.
 *
 * Only paths present in `desired` are considered: a device reporting extra
 * telemetry nobody asked for is not drift. A path in `desired` that is absent
 * from `reported` is flagged with `neverReported`, which in practice means
 * either "the device has not applied it yet" or "the device does not
 * understand that key" — a distinction worth surfacing rather than hiding.
 */
export function shadowDrift(document: ShadowDocument): DriftEntry[] {
    const desired = flattenJson(document.state?.desired ?? {});
    const reported = flattenJson(document.state?.reported ?? {});
    const entries: DriftEntry[] = [];

    for (const path of [...desired.keys()].toSorted()) {
        // The empty path appears when `desired` itself is `{}`; nothing to compare.
        if (path === '') {
            continue;
        }
        const desiredValue = desired.get(path);
        if (!reported.has(path)) {
            entries.push({ path, desired: desiredValue, reported: undefined, neverReported: true });
            continue;
        }
        const reportedValue = reported.get(path);
        if (!leafEquals(desiredValue, reportedValue)) {
            entries.push({
                path,
                desired: desiredValue,
                reported: reportedValue,
                neverReported: false,
            });
        }
    }

    return entries;
}

/**
 * Walks `metadata.reported` collecting `{ timestamp }` leaves.
 *
 * The metadata tree mirrors the state tree, with each leaf replaced by an
 * object carrying a `timestamp` in epoch seconds.
 */
function collectTimestamps(node: unknown, prefix: string, out: Map<string, number>): void {
    if (!isRecord(node)) {
        return;
    }
    const timestamp = node['timestamp'];
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
        out.set(prefix, timestamp);
        return;
    }
    for (const key of Object.keys(node).toSorted()) {
        collectTimestamps(node[key], joinPath(prefix, key), out);
    }
}

/**
 * How long ago each reported field was last updated.
 *
 * @param document Parsed shadow document.
 * @param nowMs    Current time in **milliseconds** (e.g. `Date.now()`).
 */
export function shadowFreshness(document: ShadowDocument, nowMs: number): ShadowFreshness {
    const timestamps = new Map<string, number>();
    collectTimestamps(document.metadata?.reported, '', timestamps);

    if (timestamps.size === 0) {
        return {
            fields: [],
            oldestAgeSeconds: null,
            newestAgeSeconds: null,
            metadataMissing: true,
        };
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    const fields: FieldAge[] = [...timestamps.entries()]
        .map(([path, timestampSeconds]) => ({
            path: path === '' ? '(root)' : path,
            timestampSeconds,
            ageSeconds: nowSeconds - timestampSeconds,
        }))
        .toSorted((a, b) => b.ageSeconds - a.ageSeconds || a.path.localeCompare(b.path));

    const oldest = fields[0];
    const newest = fields[fields.length - 1];

    return {
        fields,
        oldestAgeSeconds: oldest ? oldest.ageSeconds : null,
        newestAgeSeconds: newest ? newest.ageSeconds : null,
        metadataMissing: false,
    };
}

/**
 * Parses a raw shadow payload (the data plane returns a byte stream).
 *
 * Deliberately lenient: an unexpected shape is still returned as a document
 * with no recognised fields rather than throwing, because a device that writes
 * a malformed shadow is exactly the case an operator needs to see.
 */
export function parseShadowDocument(raw: string): { document: ShadowDocument; parseError?: string } {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
            return { document: {}, parseError: 'Shadow payload is not a JSON object.' };
        }
        return { document: parsed as ShadowDocument };
    } catch (error) {
        return {
            document: {},
            parseError: `Shadow payload is not valid JSON: ${(error as Error).message}`,
        };
    }
}

/** Renders a duration in seconds as a compact human string (`3d 4h`, `12m`). */
export function formatAge(seconds: number): string {
    if (!Number.isFinite(seconds)) {
        return 'unknown';
    }
    if (seconds < 0) {
        return `in ${formatAge(-seconds)}`;
    }
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const restMinutes = minutes % 60;
        return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
