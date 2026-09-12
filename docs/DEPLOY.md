# Deployment

Two transports, two very different threat profiles.

## stdio (the default, and what you probably want)

The client launches the process; there is no listening socket, no network exposure, and credentials come from the user's own AWS chain. This is how every desktop MCP client expects to run a server.

```json
{
  "mcpServers": {
    "aws-iot-core": {
      "command": "npx",
      "args": ["-y", "aws-iot-core-mcp"],
      "env": { "AWS_REGION": "us-east-1", "AWS_PROFILE": "iot-readonly" }
    }
  }
}
```

One hard rule if you are modifying the code: **stdout belongs to the protocol.** Every diagnostic in this repository goes to stderr. A single stray `console.log` corrupts the session, and the failure looks like a protocol bug rather than a log line.

## Streamable HTTP, stateless

```bash
AWS_REGION=us-east-1 npm run dev:http
# -> http://127.0.0.1:3000/mcp   plus GET /healthz
```

| Variable                            | Default     |
| ----------------------------------- | ----------- |
| `AWS_IOT_MCP_HTTP_PORT` (or `PORT`) | `3000`      |
| `AWS_IOT_MCP_HTTP_HOST`             | `127.0.0.1` |
| `AWS_IOT_MCP_HTTP_PATH`             | `/mcp`      |

Stateless means `sessionIdGenerator: undefined`: no session is stored, so there is nothing to hijack or replay, and any number of instances can sit behind a load balancer with no sticky routing. Each request gets a fresh server and transport, closed when the response ends.

### It does not authenticate

There is no auth in this entry point, deliberately — rolling our own would be worse than composing with something that already does it. It binds to localhost and expects one of:

- **API Gateway** (HTTP API) with a JWT authorizer or Lambda authorizer in front;
- **an ALB** with OIDC authentication;
- **a service mesh** or a private network where the caller is already authenticated;
- **an SSH tunnel**, for a single operator.

DNS-rebinding protection is on, with `allowedHosts` derived from the configured host and port. That stops a browser on the operator's machine from reaching a localhost server; it is not a substitute for authentication.

**Exposing this port to a network exposes read access to your IoT fleet to that network.** If the fleet data is sensitive — positions, plate numbers, customer sites — treat the endpoint as production infrastructure.

## Lambda

The stateless transport is Lambda-compatible, but `src/http.ts` is a plain Node HTTP server rather than a handler. Two options:

1. **Function URL or API Gateway + a web adapter** (for example the AWS Lambda Web Adapter layer), running `dist/http.js` unchanged. Cheapest path.
2. **A thin handler** that imports `createServer` from `dist/server.js` and drives `StreamableHTTPServerTransport` per invocation. More control, more code you own.

Either way:

- Give the function the [minimal IAM policy](iam-policy.json) as its execution role. No credentials in environment variables.
- Set `AWS_REGION` to the region holding the fleet — not necessarily the region the function runs in.
- Memory 256–512 MB is plenty; the process is I/O bound.
- Expect a cold start of roughly a second for the AWS SDK. `describeEndpoint` is called lazily and cached per process, so a session that only lists things never pays for it.
- Ship the audit log: it goes to stderr, which CloudWatch captures. `AWS_IOT_MCP_AUDIT_ARGS=off` if your log retention policy is strict about argument values.

## Containers

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV AWS_IOT_MCP_HTTP_HOST=0.0.0.0
USER node
CMD ["node", "dist/http.js"]
```

Setting `HTTP_HOST` to `0.0.0.0` is what makes the port reachable from outside the container — which means everything in "it does not authenticate" now applies. On ECS/Fargate, use a task role rather than credentials, and keep the service in a private subnet with the authenticating proxy in front.

`GET /healthz` returns `{"status":"ok"}` and makes no AWS call, so it is safe as a load-balancer health check.

## Operational notes

- **Region mismatch is the most common failure.** IoT Core is regional; the wrong region looks exactly like an empty account. Run `--check` and read the region it prints.
- **Fleet indexing costs money** and is off by default. Without it, `search_fleet_index` cannot answer and `assess_fleet_health` cannot see connectivity. `describe_indexing_configuration` tells you what is on.
- **Throttling.** The health sweep is deliberately sequential; fanning out gets you throttled. If you see `ThrottlingException`, lower `AWS_IOT_MCP_MAX_FLEET_SAMPLE` rather than retrying harder.
- **Narrow the scope in shared deployments.** `AWS_IOT_MCP_THING_ALLOW=gw-*` plus `AWS_IOT_MCP_TOOLS` is how you give one team a server that can only see its own devices. IAM resource ARNs are the stronger version of the same control.
