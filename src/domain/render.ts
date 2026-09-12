/**
 * Result rendering.
 *
 * Tool output is read by a model and, when something breaks, by a human
 * scrolling a transcript. Both are served by the same thing: compact, aligned,
 * stable text. No colour, no box-drawing characters, no emoji — a fixed layout
 * that diffs cleanly between two calls.
 */

/** Renders an aligned table. Returns `emptyNote` when there are no rows. */
export function renderTable(
    headers: readonly string[],
    rows: readonly (readonly string[])[],
    emptyNote = '(none)',
): string {
    if (rows.length === 0) {
        return emptyNote;
    }

    const widths = headers.map((header, column) =>
        rows.reduce((max, row) => Math.max(max, (row[column] ?? '').length), header.length),
    );

    const line = (cells: readonly string[]): string =>
        cells
            .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
            .join('  ')
            .trimEnd();

    const separator = widths.map((width) => '-'.repeat(width)).join('  ');

    return [line(headers), separator, ...rows.map((row) => line(row))].join('\n');
}

/** Renders `key: value` lines, skipping undefined values. */
export function renderKeyValues(pairs: readonly (readonly [string, string | undefined])[]): string {
    const present = pairs.filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== '');
    if (present.length === 0) {
        return '(no details)';
    }
    const width = present.reduce((max, [key]) => Math.max(max, key.length), 0);
    return present.map(([key, value]) => `${`${key}:`.padEnd(width + 1)} ${value}`).join('\n');
}

/** Renders a bulleted list, or `emptyNote` when empty. */
export function renderList(items: readonly string[], emptyNote = '(none)'): string {
    return items.length === 0 ? emptyNote : items.map((item) => `- ${item}`).join('\n');
}

/** Joins sections with a blank line between them, dropping empty sections. */
export function renderSections(sections: readonly (string | undefined)[]): string {
    return sections
        .filter((section): section is string => section !== undefined && section !== '')
        .join('\n\n');
}

/** A heading with a rule under it, for multi-section results. */
export function heading(text: string): string {
    return `${text}\n${'='.repeat(text.length)}`;
}

/** Formats an optional value for display. */
export function show(value: string | number | boolean | undefined | null, fallback = '-'): string {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return String(value);
}

/** Formats an epoch-millisecond timestamp as an ISO string, or `-`. */
export function showTimestamp(epochMs: number | undefined): string {
    if (epochMs === undefined || !Number.isFinite(epochMs)) {
        return '-';
    }
    return new Date(epochMs).toISOString();
}

/** A one-line note about pagination, or undefined when there is nothing to say. */
export function paginationNote(shown: number, nextToken: string | undefined): string | undefined {
    if (nextToken === undefined || nextToken === '') {
        return shown === 0 ? undefined : `${shown} item(s); no further pages.`;
    }
    return `${shown} item(s) shown. More results exist — pass next_token to continue:\n${nextToken}`;
}
