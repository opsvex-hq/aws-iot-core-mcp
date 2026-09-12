import { describe, expect, it } from 'vitest';

import { Policy, PolicyError, assertReadOnlyTool, globToRegExp } from '../../src/policy.js';

describe('assertReadOnlyTool', () => {
    it('accepts a tool annotated read-only', () => {
        expect(() =>
            assertReadOnlyTool('get_device_shadow', { readOnlyHint: true, destructiveHint: false }),
        ).not.toThrow();
    });

    it('refuses a tool with no annotations at all', () => {
        expect(() => assertReadOnlyTool('publish', undefined)).toThrowError(PolicyError);
    });

    it('refuses a tool that does not claim to be read-only', () => {
        try {
            assertReadOnlyTool('publish', { readOnlyHint: false });
            expect.unreachable('registration should have been refused');
        } catch (error) {
            expect((error as PolicyError).code).toBe('tool_not_read_only');
        }
    });

    it('refuses a destructive tool even if it also claims to be read-only', () => {
        try {
            assertReadOnlyTool('delete_thing', { readOnlyHint: true, destructiveHint: true });
            expect.unreachable('registration should have been refused');
        } catch (error) {
            expect((error as PolicyError).code).toBe('tool_destructive');
        }
    });
});

describe('globToRegExp', () => {
    it('anchors the pattern so a prefix match is not enough', () => {
        expect(globToRegExp('gw-*').test('gw-001')).toBe(true);
        expect(globToRegExp('gw-*').test('other-gw-001')).toBe(false);
    });

    it('supports ? as a single character', () => {
        expect(globToRegExp('gw-00?').test('gw-001')).toBe(true);
        expect(globToRegExp('gw-00?').test('gw-0012')).toBe(false);
    });

    it('escapes regex metacharacters in the literal part', () => {
        expect(globToRegExp('gw.001').test('gw.001')).toBe(true);
        expect(globToRegExp('gw.001').test('gwX001')).toBe(false);
    });

    it('matches everything with a bare star', () => {
        expect(globToRegExp('*').test('anything')).toBe(true);
    });
});

describe('Policy tool allowlist', () => {
    it('exposes every tool when no allowlist is configured', () => {
        const policy = new Policy({ maxItemsPerCall: 10, maxUntrustedBytes: 100, maxFleetSample: 5 });
        expect(policy.isToolEnabled('anything')).toBe(true);
        expect(policy.listRequestedTools()).toEqual([]);
    });

    it('exposes only the listed tools when an allowlist is configured', () => {
        const policy = new Policy({
            enabledTools: ['list_things'],
            maxItemsPerCall: 10,
            maxUntrustedBytes: 100,
            maxFleetSample: 5,
        });
        expect(policy.isToolEnabled('list_things')).toBe(true);
        expect(policy.isToolEnabled('get_device_shadow')).toBe(false);
        expect(policy.listRequestedTools()).toEqual(['list_things']);
    });
});

describe('Policy thing scope', () => {
    const scoped = new Policy({
        thingAllow: ['gw-*', 'sensor-01'],
        maxItemsPerCall: 10,
        maxUntrustedBytes: 100,
        maxFleetSample: 5,
    });

    it('allows a thing inside the scope', () => {
        expect(() => scoped.assertThingAllowed('gw-001')).not.toThrow();
        expect(() => scoped.assertThingAllowed('sensor-01')).not.toThrow();
    });

    it('denies anything outside the scope, by default', () => {
        try {
            scoped.assertThingAllowed('prod-db');
            expect.unreachable('should have been refused');
        } catch (error) {
            expect((error as PolicyError).code).toBe('thing_out_of_scope');
            expect((error as PolicyError).message).toContain('prod-db');
        }
    });

    it('reports itself as account-wide only when unscoped', () => {
        expect(scoped.isAccountWide).toBe(false);
        expect(
            new Policy({ maxItemsPerCall: 1, maxUntrustedBytes: 1, maxFleetSample: 1 }).isAccountWide,
        ).toBe(true);
    });

    it('partitions a list into allowed and refused', () => {
        const result = scoped.filterThings(['gw-001', 'prod-db', 'sensor-01']);
        expect(result.allowed).toEqual(['gw-001', 'sensor-01']);
        expect(result.refused).toEqual(['prod-db']);
    });

    it('passes every name through when unscoped', () => {
        const open = new Policy({ maxItemsPerCall: 1, maxUntrustedBytes: 1, maxFleetSample: 1 });
        expect(open.filterThings(['a', 'b']).refused).toEqual([]);
    });
});

describe('Policy budgets', () => {
    const policy = new Policy({ maxItemsPerCall: 50, maxUntrustedBytes: 1_000, maxFleetSample: 10 });

    it('clamps an over-large page request to the ceiling', () => {
        expect(policy.clampItems(10_000)).toBe(50);
    });

    it('uses a conservative default when nothing is requested', () => {
        expect(policy.clampItems(undefined)).toBe(25);
    });

    it('never returns a non-positive or fractional page size', () => {
        expect(policy.clampItems(0)).toBe(25);
        expect(policy.clampItems(-5)).toBe(25);
        expect(policy.clampItems(Number.NaN)).toBe(25);
        expect(policy.clampItems(7.9)).toBe(7);
    });

    it('clamps the fleet sample independently of the page size', () => {
        expect(policy.clampFleetSample(999)).toBe(10);
        expect(policy.clampFleetSample(undefined)).toBe(10);
        expect(policy.clampFleetSample(3)).toBe(3);
    });
});
