#!/usr/bin/env node
/**
 * stdio entry point — the transport every desktop MCP client speaks.
 *
 * Hard rule for this file: **stdout belongs to the protocol.** Every diagnostic
 * goes to stderr. A single stray `console.log` here corrupts the session for
 * the client, and the failure looks like a protocol bug rather than a log line.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { PolicyError } from './policy.js';
import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';
import { ALL_TOOLS } from './tools/index.js';

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

Read-only MCP server for AWS IoT Core.

USAGE
  aws-iot-core-mcp [options]

OPTIONS
  --help, -h      Show this help.
  --version, -v   Print the version.
  --list-tools    Print the tools this build exposes, with the current allowlist applied.
  --check         Validate configuration and AWS credentials, then exit.

With no options it speaks MCP over stdio, which is what an MCP client expects.

ENVIRONMENT
  AWS_REGION                        Required. Region holding the fleet.
  AWS_IOT_MCP_TOOLS                 Optional comma-separated tool allowlist.
  AWS_IOT_MCP_THING_ALLOW           Optional comma-separated thing-name globs (deny anything else).
  AWS_IOT_MCP_MAX_ITEMS             Page-size ceiling. Default 100.
  AWS_IOT_MCP_MAX_FLEET_SAMPLE      Things per fleet-health call. Default 25.
  AWS_IOT_MCP_MAX_UNTRUSTED_BYTES   Device bytes per result. Default 24000.
  AWS_IOT_MCP_AUDIT                 Audit log to stderr. Default on.
  AWS_IOT_MCP_AUDIT_ARGS            Include redacted arguments in the audit log. Default on.
  AWS_IOT_MCP_STALE_WARN_SECONDS    Shadow staleness warning. Default 3600.
  AWS_IOT_MCP_STALE_CRITICAL_SECONDS Shadow staleness critical. Default 86400.
  AWS_IOT_MCP_CERT_WARN_DAYS        Certificate expiry warning. Default 45.
  AWS_IOT_MCP_CERT_CRITICAL_DAYS    Certificate expiry critical. Default 14.

Credentials come from the standard AWS chain. This server never accepts
credentials as a tool argument.

Docs: https://github.com/opsvex-hq/aws-iot-core-mcp
`;

/** Writes a line to stderr. stdout is reserved for the protocol. */
function log(line: string): void {
    process.stderr.write(`${line}\n`);
}

async function runCheck(): Promise<number> {
    const config = loadConfig();
    log(`Configuration OK. Region: ${config.region}`);
    log(
        `Tool allowlist: ${config.enabledTools === undefined ? '(all tools)' : config.enabledTools.join(', ')}`,
    );
    log(
        `Thing scope: ${
            config.thingAllow === undefined
                ? '(account-wide, bounded only by IAM)'
                : config.thingAllow.join(', ')
        }`,
    );

    const { context } = createServer({ config });
    try {
        const response = await context.control.listThings({ maxResults: 1 });
        log(`AWS credentials OK. ListThings returned ${response.things.length} item(s).`);
    } catch (error) {
        log(`AWS check FAILED: ${(error as Error).message}`);
        log('The server can still start; every tool call will fail the same way until this is fixed.');
        return 1;
    }

    try {
        const indexing = await context.control.getIndexingConfiguration();
        const mode = indexing.thingIndexingMode ?? 'OFF';
        log(
            `Fleet indexing: registry=${mode} connectivity=${indexing.thingConnectivityIndexingMode ?? 'OFF'}`,
        );
        if (mode === 'OFF') {
            log('Note: search_fleet_index and connectivity findings need fleet indexing enabled.');
        }
    } catch (error) {
        log(`Fleet indexing could not be read (${(error as Error).name}); search tools may not work.`);
    }

    return 0;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(USAGE);
        return;
    }

    if (argv.includes('--version') || argv.includes('-v')) {
        process.stdout.write(`${SERVER_VERSION}\n`);
        return;
    }

    if (argv.includes('--list-tools')) {
        const config = loadConfig();
        const enabled = new Set(config.enabledTools ?? ALL_TOOLS.map((tool) => tool.name));
        for (const tool of ALL_TOOLS) {
            process.stdout.write(
                `${enabled.has(tool.name) ? '[on ]' : '[off]'} ${tool.name} — ${tool.title}\n`,
            );
        }
        return;
    }

    if (argv.includes('--check')) {
        process.exitCode = await runCheck();
        return;
    }

    const { server, registration, config } = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);

    log(
        JSON.stringify({
            event: 'server_started',
            name: SERVER_NAME,
            version: SERVER_VERSION,
            transport: 'stdio',
            region: config.region,
            tools: registration.registered.length,
            toolsSkipped: registration.skipped,
            thingScope: config.thingAllow ?? 'account-wide',
        }),
    );

    const shutdown = (signal: string): void => {
        log(JSON.stringify({ event: 'server_stopping', signal }));
        void server.close().finally(() => {
            process.exit(0);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
    if (error instanceof ConfigError || error instanceof PolicyError) {
        log(`${error.name}: ${error.message}`);
        process.exit(2);
    }
    log(`Fatal: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
});
