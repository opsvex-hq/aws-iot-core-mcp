/**
 * Configuration, resolved once at startup from the environment.
 *
 * Every knob has a safe default, so the zero-configuration path works with
 * nothing but AWS credentials and a region. Anything that widens the server's
 * reach (larger pages, more things per call) is capped, and anything that
 * narrows it (tool allowlist, thing scope) is opt-in.
 *
 * Bad input fails loudly at startup rather than silently degrading at call
 * time: a typo in a threshold must not turn into "no device is ever stale".
 */

import { z } from 'zod';

const csv = z
    .string()
    .transform((value) =>
        value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== ''),
    )
    .refine((items) => items.length > 0, { message: 'must contain at least one entry' });

const positiveInt = (max: number) => z.coerce.number().int().positive().max(max);

const booleanish = z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => ['1', '0', 'true', 'false', 'on', 'off', 'yes', 'no'].includes(value), {
        message: 'must be one of true/false/on/off/1/0/yes/no',
    })
    .transform((value) => ['1', 'true', 'on', 'yes'].includes(value));

const schema = z.object({
    AWS_REGION: z.string().min(1).optional(),
    AWS_DEFAULT_REGION: z.string().min(1).optional(),
    AWS_IOT_MCP_REGION: z.string().min(1).optional(),

    AWS_IOT_MCP_TOOLS: csv.optional(),
    AWS_IOT_MCP_THING_ALLOW: csv.optional(),

    AWS_IOT_MCP_MAX_ITEMS: positiveInt(250).optional(),
    AWS_IOT_MCP_MAX_UNTRUSTED_BYTES: positiveInt(200_000).optional(),
    AWS_IOT_MCP_MAX_FLEET_SAMPLE: positiveInt(100).optional(),

    AWS_IOT_MCP_AUDIT: booleanish.optional(),
    AWS_IOT_MCP_AUDIT_ARGS: booleanish.optional(),

    AWS_IOT_MCP_STALE_WARN_SECONDS: positiveInt(31_536_000).optional(),
    AWS_IOT_MCP_STALE_CRITICAL_SECONDS: positiveInt(31_536_000).optional(),
    AWS_IOT_MCP_CERT_WARN_DAYS: positiveInt(3650).optional(),
    AWS_IOT_MCP_CERT_CRITICAL_DAYS: positiveInt(3650).optional(),

    AWS_IOT_MCP_HTTP_PORT: positiveInt(65_535).optional(),
    AWS_IOT_MCP_HTTP_HOST: z.string().min(1).optional(),
    AWS_IOT_MCP_HTTP_PATH: z.string().startsWith('/').optional(),
    PORT: positiveInt(65_535).optional(),
});

export interface ResolvedConfig {
    region: string;
    enabledTools?: string[];
    thingAllow?: string[];
    maxItemsPerCall: number;
    maxUntrustedBytes: number;
    maxFleetSample: number;
    auditEnabled: boolean;
    auditArgs: boolean;
    thresholds: {
        staleWarnSeconds: number;
        staleCriticalSeconds: number;
        certWarnDays: number;
        certCriticalDays: number;
    };
    http: {
        port: number;
        host: string;
        path: string;
    };
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

/**
 * Resolves configuration from an environment-like record.
 *
 * @throws {ConfigError} when a value is present but unusable, or when no region
 *         can be determined — failing at startup beats failing per call.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        throw new ConfigError(`Invalid configuration: ${issues}`);
    }

    const values = parsed.data;
    const region = values.AWS_IOT_MCP_REGION ?? values.AWS_REGION ?? values.AWS_DEFAULT_REGION;
    if (region === undefined) {
        throw new ConfigError(
            'No AWS region configured. Set AWS_REGION (or AWS_IOT_MCP_REGION) to the region ' +
                'holding the fleet — IoT Core is regional and a wrong region looks like an empty account.',
        );
    }

    const staleWarnSeconds = values.AWS_IOT_MCP_STALE_WARN_SECONDS ?? 3_600;
    const staleCriticalSeconds = values.AWS_IOT_MCP_STALE_CRITICAL_SECONDS ?? 86_400;
    if (staleCriticalSeconds < staleWarnSeconds) {
        throw new ConfigError(
            'AWS_IOT_MCP_STALE_CRITICAL_SECONDS must be greater than or equal to ' +
                'AWS_IOT_MCP_STALE_WARN_SECONDS, otherwise no device can ever be merely warned.',
        );
    }

    const certWarnDays = values.AWS_IOT_MCP_CERT_WARN_DAYS ?? 45;
    const certCriticalDays = values.AWS_IOT_MCP_CERT_CRITICAL_DAYS ?? 14;
    if (certCriticalDays > certWarnDays) {
        throw new ConfigError(
            'AWS_IOT_MCP_CERT_CRITICAL_DAYS must be less than or equal to ' +
                'AWS_IOT_MCP_CERT_WARN_DAYS: critical is the nearer deadline.',
        );
    }

    return {
        region,
        enabledTools: values.AWS_IOT_MCP_TOOLS,
        thingAllow: values.AWS_IOT_MCP_THING_ALLOW,
        maxItemsPerCall: values.AWS_IOT_MCP_MAX_ITEMS ?? 100,
        maxUntrustedBytes: values.AWS_IOT_MCP_MAX_UNTRUSTED_BYTES ?? 24_000,
        maxFleetSample: values.AWS_IOT_MCP_MAX_FLEET_SAMPLE ?? 25,
        auditEnabled: values.AWS_IOT_MCP_AUDIT ?? true,
        auditArgs: values.AWS_IOT_MCP_AUDIT_ARGS ?? true,
        thresholds: { staleWarnSeconds, staleCriticalSeconds, certWarnDays, certCriticalDays },
        http: {
            port: values.AWS_IOT_MCP_HTTP_PORT ?? values.PORT ?? 3000,
            host: values.AWS_IOT_MCP_HTTP_HOST ?? '127.0.0.1',
            path: values.AWS_IOT_MCP_HTTP_PATH ?? '/mcp',
        },
    };
}
