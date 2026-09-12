import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config.js';

const base = { AWS_REGION: 'us-east-1' };

describe('loadConfig region resolution', () => {
    it('accepts AWS_REGION', () => {
        expect(loadConfig(base).region).toBe('us-east-1');
    });

    it('prefers the server-specific override over the generic variables', () => {
        const config = loadConfig({
            AWS_REGION: 'us-east-1',
            AWS_DEFAULT_REGION: 'eu-west-1',
            AWS_IOT_MCP_REGION: 'sa-east-1',
        });
        expect(config.region).toBe('sa-east-1');
    });

    it('falls back to AWS_DEFAULT_REGION', () => {
        expect(loadConfig({ AWS_DEFAULT_REGION: 'eu-west-1' }).region).toBe('eu-west-1');
    });

    it('fails loudly when no region is configured', () => {
        expect(() => loadConfig({})).toThrowError(ConfigError);
        expect(() => loadConfig({})).toThrowError(/IoT Core is regional/);
    });
});

describe('loadConfig defaults', () => {
    it('is usable with only a region', () => {
        const config = loadConfig(base);
        expect(config).toMatchObject({
            maxItemsPerCall: 100,
            maxUntrustedBytes: 24_000,
            maxFleetSample: 25,
            auditEnabled: true,
            auditArgs: true,
        });
        expect(config.thresholds).toEqual({
            staleWarnSeconds: 3_600,
            staleCriticalSeconds: 86_400,
            certWarnDays: 45,
            certCriticalDays: 14,
        });
    });

    it('leaves the tool allowlist and thing scope unset by default', () => {
        const config = loadConfig(base);
        expect(config.enabledTools).toBeUndefined();
        expect(config.thingAllow).toBeUndefined();
    });
});

describe('loadConfig lists', () => {
    it('parses a comma-separated tool allowlist and trims it', () => {
        const config = loadConfig({ ...base, AWS_IOT_MCP_TOOLS: 'list_things , get_device_shadow' });
        expect(config.enabledTools).toEqual(['list_things', 'get_device_shadow']);
    });

    it('parses thing globs', () => {
        const config = loadConfig({ ...base, AWS_IOT_MCP_THING_ALLOW: 'gw-*,sensor-01' });
        expect(config.thingAllow).toEqual(['gw-*', 'sensor-01']);
    });

    it('rejects a list that is present but empty, instead of silently ignoring it', () => {
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_TOOLS: ' , ' })).toThrowError(ConfigError);
    });
});

describe('loadConfig numbers and booleans', () => {
    it('coerces numeric strings', () => {
        const config = loadConfig({ ...base, AWS_IOT_MCP_MAX_ITEMS: '42' });
        expect(config.maxItemsPerCall).toBe(42);
    });

    it('rejects a non-numeric limit rather than falling back to a default', () => {
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_MAX_ITEMS: 'lots' })).toThrowError(ConfigError);
    });

    it('rejects a limit above the hard ceiling', () => {
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_MAX_ITEMS: '100000' })).toThrowError(ConfigError);
    });

    it('rejects zero and negative limits', () => {
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_MAX_FLEET_SAMPLE: '0' })).toThrowError(ConfigError);
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_MAX_ITEMS: '-1' })).toThrowError(ConfigError);
    });

    it.each(['off', 'false', '0', 'no'])('reads %s as audit disabled', (value) => {
        expect(loadConfig({ ...base, AWS_IOT_MCP_AUDIT: value }).auditEnabled).toBe(false);
    });

    it.each(['on', 'true', '1', 'yes'])('reads %s as audit enabled', (value) => {
        expect(loadConfig({ ...base, AWS_IOT_MCP_AUDIT: value }).auditEnabled).toBe(true);
    });

    it('rejects an ambiguous boolean', () => {
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_AUDIT: 'maybe' })).toThrowError(ConfigError);
    });
});

describe('loadConfig threshold coherence', () => {
    it('refuses a critical staleness below the warning one', () => {
        expect(() =>
            loadConfig({
                ...base,
                AWS_IOT_MCP_STALE_WARN_SECONDS: '600',
                AWS_IOT_MCP_STALE_CRITICAL_SECONDS: '300',
            }),
        ).toThrowError(/greater than or equal/);
    });

    it('accepts equal staleness thresholds', () => {
        const config = loadConfig({
            ...base,
            AWS_IOT_MCP_STALE_WARN_SECONDS: '600',
            AWS_IOT_MCP_STALE_CRITICAL_SECONDS: '600',
        });
        expect(config.thresholds.staleCriticalSeconds).toBe(600);
    });

    it('refuses a certificate critical window wider than the warning one', () => {
        expect(() =>
            loadConfig({
                ...base,
                AWS_IOT_MCP_CERT_WARN_DAYS: '10',
                AWS_IOT_MCP_CERT_CRITICAL_DAYS: '30',
            }),
        ).toThrowError(/critical is the nearer deadline/);
    });
});

describe('loadConfig http', () => {
    it('defaults to localhost so an unauthenticated server is not exposed by accident', () => {
        expect(loadConfig(base).http).toEqual({ port: 3000, host: '127.0.0.1', path: '/mcp' });
    });

    it('honours PORT, as platforms inject it', () => {
        expect(loadConfig({ ...base, PORT: '8080' }).http.port).toBe(8080);
    });

    it('prefers the server-specific port over PORT', () => {
        const config = loadConfig({ ...base, PORT: '8080', AWS_IOT_MCP_HTTP_PORT: '9090' });
        expect(config.http.port).toBe(9090);
    });

    it('requires the path to be absolute', () => {
        expect(() => loadConfig({ ...base, AWS_IOT_MCP_HTTP_PATH: 'mcp' })).toThrowError(ConfigError);
    });
});
