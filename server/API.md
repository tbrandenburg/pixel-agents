# Server Interface — Entry Point for Agents/Tools

This is the single entry point for understanding the Pixel Agents server interface.
It intentionally does not restate anything defined elsewhere — follow the links.

## 1. The protocol (almost everything lives here)

**→ [`core/asyncapi.yaml`](../core/asyncapi.yaml)** is the canonical, machine-readable
contract for all real-time traffic over `/ws`: every `ServerMessage` (server → client)
and `ClientMessage` (client → server) variant, discriminated by `type`, with
`additionalProperties: false`. It is CI-drift-checked against the generated
`core/src/messages.ts`, so it can never go stale relative to the code.

Read the spec, not this file, for message shapes, fields, or payloads.

## 2. HTTP routes (thin wrapper around the protocol, not covered by AsyncAPI)

Defined in [`server/src/httpServer.ts`](src/httpServer.ts) — read that file directly
for exact behavior; this table is just a map of what exists and why:

| Method | Path                     | Auth                                                                                    | Purpose                                     |
| ------ | ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/health`            | none                                                                                    | Liveness: `{ status, uptime, pid }`         |
| POST   | `/api/hooks/:providerId` | `Authorization: Bearer <token>` (always)                                                | Hook event ingress (see `HookProvider`)     |
| GET    | `/ws`                    | Bearer token if `embedded: true` (VS Code); none in standalone (binds `127.0.0.1` only) | Upgrades to the AsyncAPI-specified protocol |
| GET    | `/*`                     | none                                                                                    | Static SPA (standalone build only)          |

The `POST /api/hooks/:providerId` body is provider-specific and typed by
`HookProvider.normalizeHookEvent` in [`core/src/provider.ts`](../core/src/provider.ts) —
not duplicated as a JSON Schema here to avoid a second source of truth.

## 3. Discovery & auth

The running server writes `~/.pixel-agents/server.json`:

```json
{ "port": 3100, "pid": 12345, "authToken": "..." }
```

Read this file to find the port and token; do not guess or hardcode either.

## 4. Example

```bash
# health check
curl http://127.0.0.1:$(jq -r .port ~/.pixel-agents/server.json)/api/health

# WebSocket connect (standalone, no auth)
wscat -c ws://127.0.0.1:$(jq -r .port ~/.pixel-agents/server.json)/ws
```
