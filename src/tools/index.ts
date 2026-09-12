/**
 * Tool registry.
 *
 * Everything cross-cutting happens exactly once, here: the read-only
 * invariant is enforced at registration, the policy allowlist decides what is
 * exposed, and every call is timed, audited and error-mapped. A tool module
 * never has to remember to do any of it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { redactArgs } from '../audit.js';
import { formatToolError, translateAwsError } from '../aws/errors.js';
import { PolicyError, assertReadOnlyTool } from '../policy.js';
import { healthTools } from './health.js';
import { ruleTools } from './rules.js';
import { shadowTools } from './shadows.js';
import { thingTools } from './things.js';
import type { ToolContext, ToolDefinition } from './types.js';

/** Every tool this server can expose, in a stable order. */
export const ALL_TOOLS: readonly ToolDefinition[] = [
    ...thingTools,
    ...shadowTools,
    ...ruleTools,
    ...healthTools,
];

export interface RegistrationResult {
    registered: string[];
    /** Tools excluded by the configured allowlist. */
    skipped: string[];
}

function textResult(text: string, isError = false): CallToolResult {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Registers the enabled tools on an MCP server.
 *
 * @throws {PolicyError} if any tool is not annotated read-only, or if the
 *         allowlist names a tool that does not exist — a typo in
 *         `AWS_IOT_MCP_TOOLS` must not silently expose nothing.
 */
export function registerTools(
    server: McpServer,
    context: ToolContext,
    tools: readonly ToolDefinition[] = ALL_TOOLS,
): RegistrationResult {
    const known = new Set(tools.map((tool) => tool.name));
    for (const name of context.policy.listRequestedTools()) {
        if (!known.has(name)) {
            throw new PolicyError(
                'unknown_tool_in_allowlist',
                `Tool allowlist names "${name}", which this server does not provide. Known tools: ${[...known]
                    .toSorted()
                    .join(', ')}.`,
            );
        }
    }

    const registered: string[] = [];
    const skipped: string[] = [];

    for (const tool of tools) {
        assertReadOnlyTool(tool.name, tool.annotations);

        if (!context.policy.isToolEnabled(tool.name)) {
            skipped.push(tool.name);
            continue;
        }

        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
            },
            async (args: Record<string, unknown>): Promise<CallToolResult> => {
                const started = Date.now();
                try {
                    const outcome = await tool.handler(args ?? {}, context);
                    context.audit.record({
                        tool: tool.name,
                        outcome: 'ok',
                        durationMs: Date.now() - started,
                        args: redactArgs(args),
                        signals: outcome.signals,
                    });
                    return textResult(outcome.text);
                } catch (error) {
                    if (error instanceof PolicyError) {
                        context.audit.record({
                            tool: tool.name,
                            outcome: 'denied',
                            durationMs: Date.now() - started,
                            args: redactArgs(args),
                            code: error.code,
                        });
                        return textResult(`Refused by server policy (${error.code}): ${error.message}`, true);
                    }

                    const translated = translateAwsError(error);
                    context.audit.record({
                        tool: tool.name,
                        outcome: 'error',
                        durationMs: Date.now() - started,
                        args: redactArgs(args),
                        code: translated.code,
                    });
                    return textResult(formatToolError(translated, tool.name), true);
                }
            },
        );

        registered.push(tool.name);
    }

    return { registered, skipped };
}
