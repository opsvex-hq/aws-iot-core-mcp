import { describe, expect, it } from 'vitest';

import {
    heading,
    paginationNote,
    renderKeyValues,
    renderList,
    renderSections,
    renderTable,
    show,
    showTimestamp,
} from '../../src/domain/render.js';

describe('renderTable', () => {
    it('aligns columns to the widest cell', () => {
        const table = renderTable(['A', 'BB'], [['long-value', 'x']]);
        const lines = table.split('\n');
        expect(lines[0]).toBe('A           BB');
        expect(lines[1]).toBe('----------  --');
        expect(lines[2]).toBe('long-value  x');
    });

    it('returns the empty note when there are no rows', () => {
        expect(renderTable(['A'], [], 'nothing here')).toBe('nothing here');
    });

    it('tolerates a short row without throwing', () => {
        const table = renderTable(['A', 'B'], [['only-a']]);
        expect(table.split('\n')[2]).toBe('only-a');
    });

    it('does not leave trailing whitespace on any line', () => {
        const table = renderTable(
            ['A', 'B'],
            [
                ['a', 'b'],
                ['aaa', 'b'],
            ],
        );
        for (const line of table.split('\n')) {
            expect(line).toBe(line.trimEnd());
        }
    });
});

describe('renderKeyValues', () => {
    it('skips undefined and empty values', () => {
        const text = renderKeyValues([
            ['Thing', 'gw-001'],
            ['Type', undefined],
            ['Empty', ''],
        ]);
        expect(text).toBe('Thing: gw-001');
    });

    it('pads keys so values line up', () => {
        const text = renderKeyValues([
            ['A', '1'],
            ['Longer', '2'],
        ]);
        expect(text.split('\n')[0]).toBe('A:      1');
    });

    it('reports having nothing rather than returning an empty string', () => {
        expect(renderKeyValues([['A', undefined]])).toBe('(no details)');
    });
});

describe('renderList', () => {
    it('bullets each item', () => {
        expect(renderList(['a', 'b'])).toBe('- a\n- b');
    });

    it('uses the empty note for an empty list', () => {
        expect(renderList([], '(none yet)')).toBe('(none yet)');
    });
});

describe('renderSections', () => {
    it('joins with a blank line and drops empty sections', () => {
        expect(renderSections(['a', undefined, '', 'b'])).toBe('a\n\nb');
    });
});

describe('heading', () => {
    it('underlines with the same width as the text', () => {
        expect(heading('Fleet')).toBe('Fleet\n=====');
    });
});

describe('show', () => {
    it('falls back for empty-ish values but keeps false and zero', () => {
        expect(show(undefined)).toBe('-');
        expect(show(null)).toBe('-');
        expect(show('')).toBe('-');
        expect(show(0)).toBe('0');
        expect(show(false)).toBe('false');
    });

    it('honours a custom fallback', () => {
        expect(show(undefined, 'OFF')).toBe('OFF');
    });
});

describe('showTimestamp', () => {
    it('renders epoch millis as ISO-8601 UTC', () => {
        expect(showTimestamp(Date.UTC(2026, 8, 12, 12, 0, 0))).toBe('2026-09-12T12:00:00.000Z');
    });

    it('does not invent a date for missing or broken input', () => {
        expect(showTimestamp(undefined)).toBe('-');
        expect(showTimestamp(Number.NaN)).toBe('-');
    });
});

describe('paginationNote', () => {
    it('offers the token when more pages exist', () => {
        const note = paginationNote(25, 'TOKEN123');
        expect(note).toContain('More results exist');
        expect(note).toContain('TOKEN123');
    });

    it('says the listing is complete when there is no token', () => {
        expect(paginationNote(3, undefined)).toBe('3 item(s); no further pages.');
    });

    it('stays silent for an empty result with no token', () => {
        expect(paginationNote(0, undefined)).toBeUndefined();
    });
});
