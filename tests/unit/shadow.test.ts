import { describe, expect, it } from 'vitest';

import {
    diffJson,
    flattenJson,
    formatAge,
    parseShadowDocument,
    shadowDrift,
    shadowFreshness,
    type ShadowDocument,
} from '../../src/domain/shadow.js';

const NOW_MS = Date.UTC(2026, 8, 12, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

describe('flattenJson', () => {
    it('produces dotted paths for nested objects', () => {
        const flat = flattenJson({ a: { b: 1 }, c: 2 });
        expect([...flat.keys()].toSorted()).toEqual(['a.b', 'c']);
        expect(flat.get('a.b')).toBe(1);
    });

    it('indexes array members', () => {
        const flat = flattenJson({ tags: ['x', 'y'] });
        expect(flat.get('tags[0]')).toBe('x');
        expect(flat.get('tags[1]')).toBe('y');
    });

    it('treats an empty object or array as a leaf, so "present but empty" survives', () => {
        expect(flattenJson({ a: {} }).get('a')).toEqual({});
        expect(flattenJson({ a: [] }).get('a')).toEqual([]);
    });

    it('keeps null as a value rather than dropping the key', () => {
        const flat = flattenJson({ a: null });
        expect(flat.has('a')).toBe(true);
        expect(flat.get('a')).toBeNull();
    });
});

describe('diffJson', () => {
    it('classifies added, removed and changed leaves', () => {
        const entries = diffJson({ same: 1, gone: 2, moved: 'a' }, { same: 1, added: 3, moved: 'b' });
        expect(entries).toEqual([
            { path: 'added', kind: 'added', right: 3 },
            { path: 'gone', kind: 'removed', left: 2 },
            { path: 'moved', kind: 'changed', left: 'a', right: 'b' },
        ]);
    });

    it('returns nothing for structurally equal documents', () => {
        expect(diffJson({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toEqual([]);
    });

    it('is order-insensitive for object keys but not for arrays', () => {
        expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
        expect(diffJson({ a: [1, 2] }, { a: [2, 1] })).toHaveLength(2);
    });

    it('does not confuse the number 1 with the string "1"', () => {
        const entries = diffJson({ a: 1 }, { a: '1' });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.kind).toBe('changed');
    });
});

describe('shadowDrift', () => {
    it('reports fields the device has not converged on', () => {
        const document: ShadowDocument = {
            state: { desired: { firmware: '2.0.0' }, reported: { firmware: '1.2.3' } },
        };
        expect(shadowDrift(document)).toEqual([
            { path: 'firmware', desired: '2.0.0', reported: '1.2.3', neverReported: false },
        ]);
    });

    it('marks desired fields the device never reported', () => {
        const document: ShadowDocument = {
            state: { desired: { newFlag: true }, reported: { firmware: '1.2.3' } },
        };
        const drift = shadowDrift(document);
        expect(drift).toHaveLength(1);
        expect(drift[0]?.neverReported).toBe(true);
    });

    it('ignores reported fields nobody asked for', () => {
        const document: ShadowDocument = {
            state: { desired: { a: 1 }, reported: { a: 1, extraTelemetry: 42 } },
        };
        expect(shadowDrift(document)).toEqual([]);
    });

    it('returns nothing when there is no desired state at all', () => {
        expect(shadowDrift({ state: { reported: { a: 1 } } })).toEqual([]);
        expect(shadowDrift({})).toEqual([]);
    });

    it('does not invent drift when desired is an empty object', () => {
        expect(shadowDrift({ state: { desired: {}, reported: { a: 1 } } })).toEqual([]);
    });
});

describe('shadowFreshness', () => {
    it('converts epoch-second metadata into ages without mixing units', () => {
        const document: ShadowDocument = {
            metadata: {
                reported: {
                    battery: { timestamp: NOW_SECONDS - 120 },
                    firmware: { timestamp: NOW_SECONDS - 7200 },
                },
            },
        };
        const freshness = shadowFreshness(document, NOW_MS);
        expect(freshness.metadataMissing).toBe(false);
        expect(freshness.oldestAgeSeconds).toBe(7200);
        expect(freshness.newestAgeSeconds).toBe(120);
        // Oldest first, so a truncated view shows the worst field.
        expect(freshness.fields[0]?.path).toBe('firmware');
    });

    it('walks nested metadata to the timestamp leaves', () => {
        const document: ShadowDocument = {
            metadata: { reported: { gps: { lat: { timestamp: NOW_SECONDS - 30 } } } },
        };
        const freshness = shadowFreshness(document, NOW_MS);
        expect(freshness.fields[0]?.path).toBe('gps.lat');
        expect(freshness.oldestAgeSeconds).toBe(30);
    });

    it('reports metadataMissing instead of guessing when there are no timestamps', () => {
        const freshness = shadowFreshness({ state: { reported: { a: 1 } } }, NOW_MS);
        expect(freshness.metadataMissing).toBe(true);
        expect(freshness.oldestAgeSeconds).toBeNull();
        expect(freshness.fields).toEqual([]);
    });

    it('ignores non-numeric timestamps rather than producing NaN ages', () => {
        const document = {
            metadata: { reported: { a: { timestamp: 'yesterday' } } },
        } as unknown as ShadowDocument;
        expect(shadowFreshness(document, NOW_MS).metadataMissing).toBe(true);
    });
});

describe('parseShadowDocument', () => {
    it('parses a well-formed document', () => {
        const result = parseShadowDocument('{"version":3}');
        expect(result.parseError).toBeUndefined();
        expect(result.document.version).toBe(3);
    });

    it('reports malformed JSON instead of throwing', () => {
        const result = parseShadowDocument('{not json');
        expect(result.parseError).toContain('not valid JSON');
        expect(result.document).toEqual({});
    });

    it('rejects a JSON value that is not an object', () => {
        expect(parseShadowDocument('[1,2]').parseError).toContain('not a JSON object');
        expect(parseShadowDocument('"text"').parseError).toContain('not a JSON object');
    });
});

describe('formatAge', () => {
    it.each([
        [0, '0s'],
        [45, '45s'],
        [60, '1m'],
        [3599, '59m'],
        [3600, '1h'],
        [5400, '1h 30m'],
        [86_400, '1d'],
        [90_000, '1d 1h'],
    ])('formats %i seconds as %s', (seconds, expected) => {
        expect(formatAge(seconds)).toBe(expected);
    });

    it('handles a clock skew that puts the timestamp in the future', () => {
        expect(formatAge(-120)).toBe('in 2m');
    });

    it('does not pretend to know an infinite age', () => {
        expect(formatAge(Number.POSITIVE_INFINITY)).toBe('unknown');
    });
});
