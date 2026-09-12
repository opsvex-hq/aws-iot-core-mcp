/**
 * Access policy.
 *
 * Three independent guards, in order of how much they matter:
 *
 *   1. **No write path exists.** Every tool is registered through
 *      {@link assertReadOnlyTool}, which refuses at startup — not at call time —
 *      any tool that is not annotated read-only. A mutating tool cannot be
 *      added to this server without deleting that guard, and deleting it fails
 *      the test suite. This is the guarantee the README makes.
 *   2. **Deny-by-default resource scope.** When `thingAllow` is configured,
 *      anything not matched is refused. An unconfigured server is readable
 *      across the account — the IAM policy remains the outer boundary, and the
 *      docs say so rather than implying this layer replaces it.
 *   3. **Budgets.** Page sizes and payload bytes are capped so a single call
 *      cannot drain the context window or the API quota.
 */

/** A refusal by policy, distinct from an AWS error or a bug. */
export class PolicyError extends Error {
    public readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PolicyError';
        this.code = code;
    }
}

export interface ToolAnnotationsLike {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

/**
 * Startup guard: a tool may only be registered if it declares itself read-only
 * and non-destructive. Called by the registry for every tool, so the invariant
 * cannot be bypassed by forgetting to check.
 */
export function assertReadOnlyTool(name: string, annotations: ToolAnnotationsLike | undefined): void {
    if (annotations?.readOnlyHint !== true) {
        throw new PolicyError(
            'tool_not_read_only',
            `Refusing to register tool "${name}": this server exposes read-only tools and the ` +
                'tool does not declare readOnlyHint: true.',
        );
    }
    if (annotations.destructiveHint === true) {
        throw new PolicyError(
            'tool_destructive',
            `Refusing to register tool "${name}": destructiveHint is true.`,
        );
    }
}

/** Translates a `*`/`?` glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\*/g, '[^\\s]*').replace(/\?/g, '.');
    return new RegExp(`^${pattern}$`);
}

export interface PolicyOptions {
    /** Tool allowlist. `undefined` exposes every registered read-only tool. */
    enabledTools?: readonly string[];
    /** Thing-name globs. `undefined` allows any thing the IAM role can read. */
    thingAllow?: readonly string[];
    /** Hard cap on items returned by one list/search call. */
    maxItemsPerCall: number;
    /** Hard cap on untrusted bytes embedded in one result. */
    maxUntrustedBytes: number;
    /** Hard cap on things inspected by one fleet-health call. */
    maxFleetSample: number;
}

export const DEFAULT_POLICY_OPTIONS: PolicyOptions = {
    maxItemsPerCall: 100,
    maxUntrustedBytes: 24_000,
    maxFleetSample: 25,
};

export class Policy {
    private readonly enabledTools?: ReadonlySet<string>;
    private readonly thingPatterns?: readonly RegExp[];
    public readonly maxItemsPerCall: number;
    public readonly maxUntrustedBytes: number;
    public readonly maxFleetSample: number;

    constructor(options: PolicyOptions = DEFAULT_POLICY_OPTIONS) {
        this.enabledTools = options.enabledTools ? new Set(options.enabledTools) : undefined;
        this.thingPatterns = options.thingAllow?.map(globToRegExp);
        this.maxItemsPerCall = options.maxItemsPerCall;
        this.maxUntrustedBytes = options.maxUntrustedBytes;
        this.maxFleetSample = options.maxFleetSample;
    }

    /** True when the tool should be exposed to clients. */
    public isToolEnabled(name: string): boolean {
        return this.enabledTools === undefined || this.enabledTools.has(name);
    }

    /**
     * The tool names the operator explicitly asked for, or an empty array when
     * no allowlist is configured. The registry uses this to fail loudly on a
     * typo instead of starting a server with no tools.
     */
    public listRequestedTools(): string[] {
        return this.enabledTools === undefined ? [] : [...this.enabledTools];
    }

    /** True when no scope is configured, so reads span the IAM role's reach. */
    public get isAccountWide(): boolean {
        return this.thingPatterns === undefined;
    }

    /** Throws {@link PolicyError} when `thingName` is outside the configured scope. */
    public assertThingAllowed(thingName: string): void {
        if (this.thingPatterns === undefined) {
            return;
        }
        const allowed = this.thingPatterns.some((pattern) => pattern.test(thingName));
        if (!allowed) {
            throw new PolicyError(
                'thing_out_of_scope',
                `Thing "${thingName}" is outside the configured scope of this server.`,
            );
        }
    }

    /** Clamps a requested page size to the policy ceiling. */
    public clampItems(requested: number | undefined): number {
        if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
            return Math.min(25, this.maxItemsPerCall);
        }
        return Math.min(Math.floor(requested), this.maxItemsPerCall);
    }

    /** Clamps a fleet-health sample size to the policy ceiling. */
    public clampFleetSample(requested: number | undefined): number {
        if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
            return Math.min(10, this.maxFleetSample);
        }
        return Math.min(Math.floor(requested), this.maxFleetSample);
    }

    /** Filters a list of thing names down to the configured scope. */
    public filterThings(names: readonly string[]): { allowed: string[]; refused: string[] } {
        if (this.thingPatterns === undefined) {
            return { allowed: [...names], refused: [] };
        }
        const allowed: string[] = [];
        const refused: string[] = [];
        for (const name of names) {
            if (this.thingPatterns.some((pattern) => pattern.test(name))) {
                allowed.push(name);
            } else {
                refused.push(name);
            }
        }
        return { allowed, refused };
    }
}
