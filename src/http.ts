/**
 * Streamable-HTTP entry point, stateless.
 *
 * Stateless matters for two reasons. Operationally it makes the server
 * deployable behind API Gateway or on Lambda/Fargate with no sticky sessions
 * and no shared memory. Security-wise it means there is no server-side session
 * an attacker can hijack or replay: each request carries its own transport,
 * which is closed when the response ends.
 *
 * This entry point does NOT implement authentication. It binds to localhost by
 * default and expects to sit behind something that authenticates — API Gateway,
 * an ALB with OIDC, or a service mesh. `docs/DEPLOY.md` spells that out; the
 * README refuses to pretend otherwise.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { loadConfig } from './config.js';
import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';

function log(line: string): void {
    process.stderr.write(`${line}\n`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
    });
    res.end(payload);
}

/** Reads a JSON body with a hard size cap, so one request cannot exhaust memory. */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error(`Request body exceeds ${maxBytes} bytes.`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(error as Error);
            }
        });
        req.on('error', reject);
    });
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function main(): Promise<void> {
    const config = loadConfig();
    const { registration } = createServer({ config });
    const allowedHosts = [`${config.http.host}:${config.http.port}`, `localhost:${config.http.port}`];

    const httpServer = createHttpServer((req, res) => {
        void (async () => {
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

            if (url.pathname === '/healthz') {
                send(res, 200, { status: 'ok', name: SERVER_NAME, version: SERVER_VERSION });
                return;
            }

            if (url.pathname !== config.http.path) {
                send(res, 404, { error: 'not_found', path: url.pathname });
                return;
            }

            // A fresh server and transport per request: nothing is shared, so a
            // malformed or hostile request cannot affect the next one.
            const { server } = createServer({ config });
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
                enableDnsRebindingProtection: true,
                allowedHosts,
            });

            res.on('close', () => {
                void transport.close();
                void server.close();
            });

            try {
                const body = req.method === 'POST' ? await readJsonBody(req, MAX_BODY_BYTES) : undefined;
                await server.connect(transport);
                await transport.handleRequest(req, res, body);
            } catch (error) {
                log(JSON.stringify({ event: 'request_failed', message: (error as Error).message }));
                if (!res.headersSent) {
                    send(res, 400, { error: 'bad_request', message: (error as Error).message });
                }
            }
        })();
    });

    httpServer.listen(config.http.port, config.http.host, () => {
        log(
            JSON.stringify({
                event: 'server_started',
                name: SERVER_NAME,
                version: SERVER_VERSION,
                transport: 'streamable-http',
                stateless: true,
                url: `http://${config.http.host}:${config.http.port}${config.http.path}`,
                region: config.region,
                tools: registration.registered.length,
            }),
        );
    });

    const shutdown = (signal: string): void => {
        log(JSON.stringify({ event: 'server_stopping', signal }));
        httpServer.close(() => process.exit(0));
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
    log(`Fatal: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
});
