/**
 * Tool contract.
 *
 * A tool is a pure-ish function of `(args, context) -> text`. It does not know
 * about MCP, about transports, or about audit logging; the registry adds all
 * three. That separation is what lets the whole tool layer be tested by calling
 * a function with fake ports.
 */

import type { z } from 'zod';

import type { AuditLogger } from '../audit.js';
import type { IotControlPort, IotDataPort } from '../aws/ports.js';
import type { HealthThresholds } from '../domain/health.js';
import type { Policy, ToolAnnotationsLike } from '../policy.js';

export interface ToolContext {
    control: IotControlPort;
    data: IotDataPort;
    policy: Policy;
    audit: AuditLogger;
    thresholds: HealthThresholds;
    region: string;
    /** Injected so results are reproducible in tests. */
    now: () => number;
}

export interface ToolOutcome {
    /** The text handed back to the client. */
    text: string;
    /** Injection signal ids raised while building this result, for the audit log. */
    signals?: string[];
}

/** Shape stored by the registry, with the argument type erased. */
export interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
    annotations: ToolAnnotationsLike;
    handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>;
}

/**
 * Declares a tool while keeping the argument type inferred from its schema.
 * The single cast here is what buys type safety in every tool body.
 */
export function defineTool<Shape extends z.ZodRawShape>(definition: {
    name: string;
    title: string;
    description: string;
    inputSchema: Shape;
    annotations: ToolAnnotationsLike;
    handler: (args: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<ToolOutcome>;
}): ToolDefinition {
    return {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
        handler: (args, context) => definition.handler(args as z.output<z.ZodObject<Shape>>, context),
    };
}

/** Annotations shared by every tool in this server. */
export const READ_ONLY: ToolAnnotationsLike = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};
