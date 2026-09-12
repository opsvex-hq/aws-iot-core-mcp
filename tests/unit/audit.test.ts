import { describe, expect, it } from 'vitest';

import { AuditLogger, redactArgs, type AuditSink } from '../../src/audit.js';

class Sink implements AuditSink {
    public readonly lines: string[] = [];
    public write(line: string): void {
        this.lines.push(line);
    }
    public last(): Record<string, unknown> {
        return JSON.parse(this.lines[this.lines.length - 1] ?? '{}') as Record<string, unknown>;
    }
}

describe('redactArgs', () => {
    it('keeps scalars as they are', () => {
        expect(redactArgs({ thing_name: 'gw-001', max_results: 10, include_raw: true })).toEqual({
            thing_name: 'gw-001',
            max_results: 10,
            include_raw: true,
        });
    });

    it('redacts anything that looks like a credential', () => {
        const redacted = redactArgs({
            token: 'abc',
            api_key: 'abc',
            password: 'abc',
            authorization: 'abc',
            client_secret: 'abc',
        });
        expect(Object.values(redacted).every((value) => value === '[redacted]')).toBe(true);
    });

    it('replaces objects and arrays with a shape marker, never their content', () => {
        const redacted = redactArgs({ thing_names: ['a', 'b'], nested: { pii: 'value' } });
        expect(redacted.thing_names).toBe('[array:2]');
        expect(redacted.nested).toBe('[object:1]');
        expect(JSON.stringify(redacted)).not.toContain('value');
    });

    it('truncates a long string so a huge query cannot flood the log', () => {
        const redacted = redactArgs({ query: 'x'.repeat(500) });
        expect(String(redacted.query)).toHaveLength(120 + '...(truncated)'.length);
        expect(String(redacted.query)).toContain('...(truncated)');
    });

    it('returns an empty record for non-object input', () => {
        expect(redactArgs(undefined)).toEqual({});
        expect(redactArgs('string')).toEqual({});
        expect(redactArgs(['a'])).toEqual({});
    });

    it('records an explicit null rather than dropping the key', () => {
        expect(redactArgs({ shadow_name: null })).toEqual({ shadow_name: 'null' });
    });
});

describe('AuditLogger', () => {
    it('writes one JSON object per line', () => {
        const sink = new Sink();
        const logger = new AuditLogger({ sink, region: 'us-east-1' });

        logger.record({ tool: 'list_things', outcome: 'ok', durationMs: 12 });

        expect(sink.lines).toHaveLength(1);
        expect(sink.lines[0]).not.toContain('\n');
        expect(sink.last()).toMatchObject({
            tool: 'list_things',
            outcome: 'ok',
            durationMs: 12,
            region: 'us-east-1',
        });
        expect(typeof sink.last().ts).toBe('string');
    });

    it('omits empty signal arrays instead of logging noise', () => {
        const sink = new Sink();
        new AuditLogger({ sink }).record({
            tool: 'get_device_shadow',
            outcome: 'ok',
            durationMs: 1,
            signals: [],
        });
        expect(sink.last()).not.toHaveProperty('signals');
    });

    it('records signals when present', () => {
        const sink = new Sink();
        new AuditLogger({ sink }).record({
            tool: 'get_device_shadow',
            outcome: 'ok',
            durationMs: 1,
            signals: ['instruction_override'],
        });
        expect(sink.last().signals).toEqual(['instruction_override']);
    });

    it('records the failure code for denied and errored calls', () => {
        const sink = new Sink();
        const logger = new AuditLogger({ sink });
        logger.record({
            tool: 'describe_thing',
            outcome: 'denied',
            durationMs: 0,
            code: 'thing_out_of_scope',
        });
        expect(sink.last()).toMatchObject({ outcome: 'denied', code: 'thing_out_of_scope' });
    });

    it('drops arguments entirely when argument logging is off', () => {
        const sink = new Sink();
        new AuditLogger({ sink, includeArgs: false }).record({
            tool: 'describe_thing',
            outcome: 'ok',
            durationMs: 1,
            args: { thing_name: 'gw-001' },
        });
        expect(sink.last()).not.toHaveProperty('args');
    });

    it('accepts an injected timestamp so tests are deterministic', () => {
        const sink = new Sink();
        new AuditLogger({ sink }).record({
            ts: '2026-09-12T12:00:00.000Z',
            tool: 'list_things',
            outcome: 'ok',
            durationMs: 1,
        });
        expect(sink.last().ts).toBe('2026-09-12T12:00:00.000Z');
    });
});
