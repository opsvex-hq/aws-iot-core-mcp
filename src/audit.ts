/**
 * Tool-call audit trail.
 *
 * An MCP server sits between a model and a production account, which makes
 * "what did the assistant actually ask for?" an operational question. Every
 * call lands here as one JSON object per line: greppable, shippable to
 * CloudWatch or Loki, and stable enough to alert on.
 *
 * Two constraints shape this module:
 *
 *   - **Never write to stdout.** On the stdio transport, stdout is the protocol
 *     channel; a stray line there corrupts the session. The default sink is
 *     stderr.
 *   - **Never log the payload.** A shadow can carry location, plate numbers or
 *     personal data. Arguments are recorded as redacted scalars, and device
 *     payloads are never included — only the signals raised by them.
 */

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditEvent {
    /** ISO-8601 timestamp. */
    ts: string;
    tool: string;
    outcome: AuditOutcome;
    durationMs: number;
    /** Redacted, scalar-only view of the arguments. */
    args?: Record<string, string | number | boolean>;
    /** Injection signal ids raised while sanitising the response. */
    signals?: string[];
    /** Error or policy code when `outcome` is not `ok`. */
    code?: string;
    /** AWS region the call was made against. */
    region?: string;
}

export interface AuditSink {
    write(line: string): void;
}

/** Writes to stderr, which is safe on both stdio and HTTP transports. */
export const stderrSink: AuditSink = {
    write(line: string): void {
        process.stderr.write(`${line}\n`);
    },
};

/** Drops everything. Used by tests and by `--no-audit`. */
export const nullSink: AuditSink = {
    write(): void {
        /* intentionally empty */
    },
};

const REDACTED = '[redacted]';

/** Argument names whose values are never recorded, matched case-insensitively. */
const SENSITIVE_KEY = /token|secret|password|credential|signature|authorization|key$/i;

/** Longest argument value recorded before truncation. */
const MAX_VALUE_LENGTH = 120;

/**
 * Reduces tool arguments to a flat, redacted, scalar-only record.
 * Objects and arrays are replaced by a shape marker rather than their content.
 */
export function redactArgs(args: unknown): Record<string, string | number | boolean> {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return {};
    }
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) {
            out[key] = REDACTED;
            continue;
        }
        if (typeof value === 'string') {
            out[key] =
                value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...(truncated)` : value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value;
        } else if (Array.isArray(value)) {
            out[key] = `[array:${value.length}]`;
        } else if (value !== null && typeof value === 'object') {
            out[key] = `[object:${Object.keys(value as Record<string, unknown>).length}]`;
        } else if (value === null) {
            out[key] = 'null';
        }
    }
    return out;
}

export interface AuditLoggerOptions {
    sink?: AuditSink;
    region?: string;
    /** Set false to record outcomes without argument values at all. */
    includeArgs?: boolean;
}

export class AuditLogger {
    private readonly sink: AuditSink;
    private readonly region?: string;
    private readonly includeArgs: boolean;

    constructor(options: AuditLoggerOptions = {}) {
        this.sink = options.sink ?? stderrSink;
        this.region = options.region;
        this.includeArgs = options.includeArgs ?? true;
    }

    public record(event: Omit<AuditEvent, 'ts' | 'region'> & { ts?: string }): void {
        const payload: AuditEvent = {
            ts: event.ts ?? new Date().toISOString(),
            tool: event.tool,
            outcome: event.outcome,
            durationMs: event.durationMs,
            ...(this.region !== undefined ? { region: this.region } : {}),
            ...(this.includeArgs && event.args !== undefined ? { args: event.args } : {}),
            ...(event.signals !== undefined && event.signals.length > 0 ? { signals: event.signals } : {}),
            ...(event.code !== undefined ? { code: event.code } : {}),
        };
        this.sink.write(JSON.stringify(payload));
    }
}
