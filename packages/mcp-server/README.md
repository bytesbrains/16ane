# `@16ane/mcp-server` — 16ane sandbox wallet adapter for MCP hosts

Exposes the 16ane testnet sandbox to MCP-compatible LLM hosts (Claude Desktop,
Cursor, MCP clients) as seven constrained tools: service discovery, quoting,
balance inspection and bounded purchasing. Speaks **MCP `2026-07-28`**
([spec](https://modelcontextprotocol.io/specification/2026-07-28), checked
2026-10-22) over **stdio** and **Streamable HTTP**. No runtime dependencies.

> TEST TOKENS (tANE) - NO CASH VALUE. This adapter moves simulated testnet
> tokens only. It never handles INR, redemptions or real value of any kind.

## Tools

| Tool | Effect |
| --- | --- |
| `list_services` | Lists directory services with prices and manifest signature checks. Read-only. |
| `get_quote` | Fetches a 402 quote without paying; cross-checks the origin manifest. Read-only, never signs. |
| `wallet_balance` | Vault tANE balance plus delegation accounting from chain state. Read-only. |
| `payment_status` | On-chain payment record plus verifiable receipt lookup. Read-only. |
| `purchase_service` | Pays for one service call within `max_payment` and vault policy. **Spends funds.** |
| `publish_service` | Signs and registers this agent's own service manifest. Revenue is pinned to its vault. |
| `request_refund` | Prepares a refund request from the on-chain record. Moves no funds; only the merchant can refund. |

Amounts are base-units integer strings (`"16"`). Every service description,
quote and purchase result is **untrusted merchant content**: it arrives fenced
as data (never instructions) in text output and flagged `untrusted: true` in
structured output.

## Security model

- The process holds exactly one key: the delegated **agentSigner**
  (`ANE_AGENT_PRIVATE_KEY`). There is no owner-key option anywhere; fund,
  delegate and revoke outside this server (CLI, dashboard) first.
- At startup the server verifies on-chain that the held key **is** the vault's
  delegated agentSigner and that the delegation is active, and refuses to serve
  otherwise.
- Spending is capped three deep: the call's required `max_payment`, the
  optional server-side `ANE_MCP_MAX_PAYMENT` ceiling, and the vault's on-chain
  policy (the real enforcement; prompt text never is).
- `publish_service` accepts no payee/token/network override: revenue always
  points at this vault, in tANE, on the configured network.
- The key is held in the SDK's `SecretKey` wrapper and never appears in tool
  results, errors, logs or stdio output; `test/security.test.ts` proves it
  against prompt-injection fixtures.
- Streamable HTTP binds `127.0.0.1` by default, validates `Origin`, enforces
  the `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` header/body mirrors, and
  supports an `ANE_MCP_AUTH_TOKEN` bearer token (set one whenever the endpoint
  leaves localhost).

## Configure

```bash
export ANE_RPC_URL="https://sepolia.base.org"   # or http://127.0.0.1:8545 for Anvil
export ANE_CHAIN_ID="84532"                     # or 31337 for Anvil
export ANE_VAULT_ADDRESS="0x..."                # the delegated agent vault
export ANE_AGENT_PRIVATE_KEY="0x..."            # the delegated agentSigner key
export ANE_REGISTRY_ADDRESS="0x..."             # or the four ANE_*_ADDRESS values below
# export ANE_TOKEN_ADDRESS / ANE_VAULT_FACTORY_ADDRESS / ANE_FAUCET_ADDRESS / ANE_SERVICE_DIRECTORY_ADDRESS
export ANE_API_BASE_URL="https://api.16ane.com" # service listing, publishing, receipts
export ANE_MCP_MAX_PAYMENT="16"                 # optional per-call ceiling (base units)
```

## Run with stdio (Claude Desktop, Cursor)

Command: `node --experimental-strip-types /path/to/16ane/packages/mcp-server/src/main.ts`
(or the `16ane-mcp-server` bin after `npm install`; it re-execs with the flag).

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "16ane": {
      "command": "node",
      "args": ["--experimental-strip-types", "/path/to/16ane/packages/mcp-server/src/main.ts"],
      "env": {
        "ANE_RPC_URL": "https://sepolia.base.org",
        "ANE_CHAIN_ID": "84532",
        "ANE_VAULT_ADDRESS": "0x...",
        "ANE_AGENT_PRIVATE_KEY": "0x...",
        "ANE_REGISTRY_ADDRESS": "0x...",
        "ANE_API_BASE_URL": "https://api.16ane.com",
        "ANE_MCP_MAX_PAYMENT": "16"
      }
    }
  }
}
```

Cursor uses the same shape under *Settings → MCP → Add server* (stdio type).
Any MCP client that speaks protocol version `2026-07-28` works; clients that
only speak the legacy `initialize` handshake do not (this server is modern-era
only and answers `initialize` with JSON-RPC `-32601`).

## Run with Streamable HTTP (remote)

```bash
export ANE_MCP_TRANSPORT="http" ANE_MCP_PORT="8786"
export ANE_MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export ANE_MCP_ALLOWED_ORIGINS="https://app.example.com"
node --experimental-strip-types packages/mcp-server/src/main.ts
# POST JSON-RPC to http://127.0.0.1:8786/mcp
```

Every POST needs `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`
(plus `Mcp-Name: <tool>` for `tools/call`) mirroring the body's method, and
`Authorization: Bearer <token>` when configured. Responses are single JSON
objects (the server never opens SSE streams); unknown methods answer `404`,
protocol violations `400`, notifications `202`.

## Develop

```bash
npm run test:mcp    # or: make test-mcp (from the repo root)
npm run typecheck
```

Layout: `src/protocol.ts` (MCP 2026-07-28 JSON-RPC core), `src/tools.ts`
(the seven tools), `src/backend.ts` (SDK/REST wiring behind a mockable
interface), `src/stdio.ts`, `src/http.ts`, `src/config.ts`, `src/main.ts`.
Tests mirror the sources; `test/security.test.ts` is the prompt-injection
suite from the issue's acceptance criteria.
