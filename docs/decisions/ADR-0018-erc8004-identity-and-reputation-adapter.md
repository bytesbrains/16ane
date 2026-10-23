# ADR-0018: ERC-8004 Identity and Reputation Adapter

- **Status:** Proposed (2026-10-24)
- **Date and owners:** 2026-10-24 | 16ane Protocol Maintainers
- **Related requirements:** REQ-202, REQ-001, REQ-101
- **Related epics:** E19 (ISS-022)
- **Builds on:** ADR-0007 decision 3 (ERC-8004 stays an optional P2 adapter). **Supersedes:** nothing.

## Context

ADR-0007 kept ERC-8004 optional because it was a Draft and because reputation on a free-token testnet invites Sybil wash trading. ISS-022 asks for the adapter. An agent should be able to register an ERC-8004 identity that points at its `/.well-known/agent-card.json` and its vault (`eip155:84532:<vault>`), and to attach a verified x402 `tx_hash` to feedback, with reputation clearly labelled as unverified.

## Evidence (checked 2026-10-24)

- **Specification:** `https://eips.ethereum.org/EIPS/eip-8004`. Still **Draft** (created 2025-08-13). The current text differs from the version ADR-0007 checked. `giveFeedback` takes `(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` with no pre-authorization. `agentWallet` is a reserved key, changed only by `setAgentWallet` with an EIP-712 (EOA) or ERC-1271 (contract) signature from the new wallet, and cleared on transfer. The off-chain feedback file may carry `proofOfPayment {fromAddress, toAddress, chainId, txHash}`. The spec calls payments "orthogonal" and does not define how that proof is checked.
- **Reference implementation:** `https://github.com/erc-8004/erc-8004-contracts`, CC0, head `b9e466c` (2026-08-15). The canonical v2.0.0 registries on Base Sepolia are IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e` and ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`. No ValidationRegistry address is published, and its interface is marked "still under active update".
- **Verified on-chain** (Base Sepolia block 49332716). Both addresses are ERC-1967 proxies. The implementations are `0x7274…9c02` (identity) and `0x16e0…da34` (reputation). `getVersion()` returns `"2.0.0"`, `name()` returns `"AgentIdentity"`, and the reputation registry points at the identity registry. Some details exist only in the source, not in the spec. The EIP-712 domain is `ERC8004IdentityRegistry` / `1`. The wallet typehash is `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`. A deadline may be at most 5 minutes ahead. Agent ids start at 0. `giveFeedback` refuses the agent's owner and operators (`Self-feedback not allowed`). `feedbackURI` and `feedbackHash` are emitted in `NewFeedback` but not stored.

## Decisions

1. **Use the canonical registries and deploy no 16ane registry.** The adapter is SDK-only (`packages/sdk-ts/src/erc8004/`), and the addresses are defaults that every call can override. Portability is the reason to use ERC-8004 at all, and a 16ane-only copy would defeat it. No core path depends on these registries: payments, discovery by signed manifest (ADR-0007) and settlement checks all work without them.
2. **Name the vault in metadata, not as `agentWallet`.** `AneAgentVault` has no ERC-1271, so it cannot consent to being an `agentWallet`, and adding ERC-1271 would mean a vault redeploy. The owner registers instead, writing the CAIP-10 vault id under the metadata key `16ane.vault`. The registry stores this claim without checking it. Readers check it themselves (`getAgentIdentity`): the vault must be on this chain, `AneVaultFactory.isRegisteredVault` must be true, and `vault.owner()` must equal the identity's owner. An impostor can write the claim but cannot make it verify (e2e).
3. **Registration files and feedback files are `data:` URIs by default.** The file lives on-chain, so nothing has to be hosted (the AGENTS.md self-hosting invariant) and the content is immutable. Registration takes two transactions: `register` mints the id, then `setAgentURI` writes a file whose `registrations` entry names that id. A reader can therefore tell a file written for this identity from one copied off another (`registrationBindsBack`). Callers that host their own file pass `agentURI`.
4. **The SDK refuses to publish an unverifiable payment claim, and readers verify every claim again.** A proof verifies only if all of the following hold:
   - The transaction succeeded and moved tANE from `fromAddress` to `toAddress`.
   - `toAddress` is the agent's owner, its `agentWallet`, or its verified vault.
   - The reviewer is `fromAddress` itself, or the owner or current agent signer of the 16ane vault at `fromAddress`.
   - The file's hash matches `feedbackHash`, and the file names this registry, this agent and this reviewer.

   One transaction proves at most one entry. `giveFeedbackOnChain` checks the proof before sending; `readAgentFeedback` re-checks every entry, including entries written directly to the registry.
5. **No score.** `readAgentFeedback` returns entries, each with its verification verdict and `revoked` flag, plus the constant `REPUTATION_CAVEAT`. It computes no average or rank, because a number invites being read as a guarantee.
6. **No arbitrary fetching.** Only `data:` URIs are read by default. Callers who want `https:` or `ipfs:` files supply a `fetchUri`, and every file is capped at 64 KiB. All file text is publisher-controlled and is never passed to an LLM as instructions (ADR-0007, THREAT_MODEL.md).
7. **Testing against the deployed code.** `e2e/fixtures/erc8004-registries.json` holds the v2.0.0 implementation runtime bytecode read from Base Sepolia, with its codehash. The e2e flow places that code at the canonical addresses on Anvil and initializes it (or uses the live registries when `ANVIL_FORK_URL` forks Base Sepolia). The unit tests check that every selector and event topic the SDK uses appears in that bytecode. `npm run check:erc8004-fixture` compares the fixture with what the live proxies currently run.

## Consequences and open risks

- **Third-party upgrade authority.** Both registries are UUPS proxies owned by the ERC-8004 maintainers, who can change their behaviour at any time. The SDK never routes funds through them; the worst outcome is wrong or missing identity and reputation data. `check:erc8004-fixture` detects an upgrade, but nothing runs it on a schedule yet (follow-up).
- **Sybil and wash trading remain.** A verified proof shows only that a real tANE payment happened. tANE is free, so one person can pay themselves through a second identity and review the result. Every read carries `REPUTATION_CAVEAT`. Agents and UIs must not rank, trust or authorize spending on the basis of ERC-8004 feedback.
- **The signer check uses current state.** The agent-signer check reads the vault's *current* signer. Feedback from a signer that has since been rotated out stops verifying, while the owner's feedback keeps verifying. A future version could check the signer at the payment's block (an archive read).
- **The vault is not a registry-verified wallet.** Ecosystem tools that read only `agentWallet` will see the owner EOA, not the vault. Adding ERC-1271 to the vault would remove this gap. It needs a vault redeploy and its own ADR (follow-up).
- **Log scans are bounded.** Feedback URIs are available only from events, so reads need a `fromBlock` (the agent's registration block) and use chunked `eth_getLogs` calls (10,000 blocks per call by default).
- **Out of scope:** the Validation Registry (no published address, and its interface is still changing), the Python SDK, MCP tools, and dashboard display. Any UI that later shows this data must display `REPUTATION_CAVEAT`.
- **Draft status.** The ERC may change again. The adapter targets the deployed v2.0.0 contracts rather than the spec text, and the fixture check reports when they change.

## Validation

- `packages/sdk-ts/test/erc8004.test.ts` checks:
  - selectors and topics against the deployed bytecode;
  - the `AgentWalletSet` digest against an independent `cast` encoding;
  - registration file shape and `data:` URI round-trip, including the fetch and size limits;
  - `NewFeedback` decoding, including negative values;
  - the reader's verdicts on tampered, misdirected, unreadable and hash-less files.
- `e2e/flows/erc8004-reputation.test.ts` runs against the deployed v2.0.0 bytecode and covers:
  - a vault claim that verifies, and an impostor's claim that does not;
  - feedback from the owner and from the agent signer that verifies;
  - a stranger's reuse of the proof, refused by the SDK and flagged by the reader when written directly;
  - a reused proof, flagged;
  - self-feedback, refused by the registry;
  - revocation;
  - `setAgentWallet` with an EOA signature;
  - a payment to an unrelated address that proves nothing about the agent.
