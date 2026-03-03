# CRE-Orchestrated Disaster Relief Distribution

A SaaS disbursement platform for disaster relief charities, built on Instruxi + Chainlink CRE + Privy. Charities allocate funds into a USDC treasury, Chainlink CRE verifies disaster events and validates recipient eligibility via Instruxi Enforcer, and eligible recipients claim directly to their wallets — every disbursement producing a cryptographic TrustSync attestation.

> **Hackathon track:** Chainlink CRE
> **Stack:** Instruxi Enforcer · Instruxi Object Storage · TrustSync Attestations · Chainlink CRE · Solidity · Hardhat · Privy

---

## Architectural Decisions & Hackathon Trade-offs

This project was built under a hackathon deadline. Every decision below was **deliberate** — the alternatives are documented as the post-hackathon V2 roadmap. Reviewers should read this section before evaluating the code; none of these are missed edge cases or unknowns.

### What We Chose and Why

| Decision | What We Did | Why (Hackathon) | V2 Upgrade Path |
|---|---|---|---|
| **Roster eligibility** | Instruxi Enforcer group membership + group name suffix encodes tier (`....:N`); CRE reads this offchain | No onchain eligibility gate = no blocker if we haven't finished processing every recipient before demo. Privacy-preserving: wallet→tier mapping stays offchain | Merkle root committed onchain at `anchorRoster` time; recipient submits proof at claim time. Eliminates all trust in the CRE workflow for eligibility decisions. |
| **Pending request guard** | `_hasPendingRequest` mapping prevents a recipient from spamming `claimDisbursement` before their first callback lands | Closes the unbounded-claiming DoS vector with ~10 lines. Complete protection without requiring the Merkle redesign. | Merkle proofs make this moot — a valid proof can only be submitted once. |
| **Admin wallet** | Single EOA holds `DEFAULT_ADMIN_ROLE` | Speed. Deployer is the admin for the demo. | Gnosis Safe multisig + OpenZeppelin `TimelockController` before any real funds are at risk. README explicitly notes the deployer should transfer this role immediately post-deploy in production. |
| **CRE callback = graceful returns** | `_handleDisbursement` returns silently on cap exceeded / unconfigured tier / not-active, never reverts | A reverting CRE callback is a "poison pill" — it permanently denies the recipient because the requestId cannot be replayed. Graceful return lets the user retry after the root cause is fixed. | Same pattern; intentional by design even at V2. |
| **OPA policy check in CRE** | `POST /enforcer/auth/authorize` is Step 1 of the disbursement workflow; `eventId` is in the OPA input | Decentralized enforcement: the policy runs inside the DON, not on a centralized server. Full audit trail of every authorization decision. | Add roster-epoch scoping to OPA policy; combine with Merkle proof for defence-in-depth. |
| **Tier extraction from group name suffix** | Group named `Eligible:US-FLOOD-2026:US-CA:2` → tier 2 via regex `/:([1-9]\d*)$/` | Tier is embedded at group creation time by the admin; CRE doesn't need a separate config lookup. Regex-validated and bounded to [1–255]. | Explicit tier field in attestation; or Merkle leaf encodes tier directly. |
| **CSV-based roster ingestion** | `processRoster.ts` reads a partner-provided CSV | Controlled input for demo. CSV is a universal format partners already use. | Streaming CSV parser with schema validation; canonical field-ordering normalization before SHA-256 hashing. |
| **No batched processRoster** | One recipient processed at a time in the script | Simplest correct thing. Demo roster is small. | Worker queue + `POST /profile/multi-create` batch endpoint already in the Instruxi API. |
| **No `EventStatus.Rejected`** | CRE returning `verified=false` leaves event in `Pending`; admin can re-verify or close | Not needed for the demo flow | Add `Rejected` status + `EventRejected` event; re-verification requires admin action. |
| **Auth in CRE via `runtime.secrets()`** | `INSTRUXI_API_KEY` and `RWA_GATEWAY_JWT` loaded from CRE secrets vault at runtime | Correct pattern — secrets never appear in workflow source or config files. Enforced in this codebase now, not deferred. | No change needed; this is already the production pattern. |

### What We Explicitly Did NOT Do (and Why Each Was Out of Scope)

- **Merkle roster proofs** — the right long-term answer for onchain eligibility without exposing recipient data. Requires redesigning the claim flow (proof submission → verify → transfer) and changes the UX. This is V2.
- **Multisig + timelock** — a deployment and governance decision, not a code change. The contract architecture is compatible; it requires the deployer to transfer `DEFAULT_ADMIN_ROLE` to a Safe and configure a timelock post-deploy.
- **Batched `processRoster`** — operational scaling. Current single-recipient loop is correct; it just needs parallelism for production roster sizes.
- **Canonical roster hashing** — the `RosterAnchored` event uses SHA-256 of the raw CSV bytes. A production system would normalize field ordering and encoding before hashing to prevent hash drift across environments.
- **EventStatus.Rejected** — not in scope for hackathon demo flow; the state machine is designed to accommodate this without breaking changes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          OFFCHAIN LAYER                                 │
│                                                                         │
│  Admin Dashboard              Partner Upload         Recipient Frontend │
│  (fund treasury,              (CSV roster →          (Privy SDK wallet  │
│   register event,              Object Storage)        → SIWE → claim)   │
│   trigger roster)                   │                       │           │
│        │                            │                       │           │
│        ▼                            ▼                       │           │
│  scripts/setupGroups.ts      scripts/uploadRoster.ts        │           │
│  scripts/processRoster.ts ───────────────────────           │           │
│  scripts/onboardRecipient.ts                                │           │
│        │                                                    │           │
│        └──────────────── Instruxi Enforcer ─────────────────┘           │
│                       (register · profile · groups · authorize)         │
│                                                                         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ emit RequestSent
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          ONCHAIN LAYER                                  │
│                                                                         │
│   ReliefTreasury.sol (inherits ChainlinkCREClient)                      │
│   ┌────────────────────────────────────────────────┐                    │
│   │  registerEvent() → requestEventVerification()  │                    │
│   │  claimDisbursement() → onReport() → transfer   │                    │
│   │  Invariants: caps · no-double-pay · tier amounts│                    │
│   └────────────────────────────────────────────────┘                    │
│          │ RequestSent event              ▲ onReport(metadata, report)  │
└──────────┼────────────────────────────────┼────────────────────────────┘
           │                                │
           ▼                                │
┌──────────────────────────────────────────────────────────────────────────┐
│                      CHAINLINK CRE WORKFLOW                              │
│                                                                          │
│  workflow/main.ts — EVM Log Trigger on RequestSent                       │
│  workflow/logCallback.ts                                                 │
│                                                                          │
│  requestType = "event_verification"   requestType = "disbursement"       │
│         │                                    │                           │
│         ▼                                    ▼                           │
│  USGS + GDACS + ReliefWeb         1. POST /enforcer/auth/authorize (OPA) │
│  (2-of-3 consensus)               2. GET  /admin/groups/.../groups       │
│         │                            Extract tier from group name suffix  │
│         │                                    │                           │
│         └──── onReport(0x01 + encode(requestId, verified)) ────┘         │
│               onReport(0x02 + encode(requestId, allowed, tier))          │
│                                                                          │
│         └──── POST /api/webhooks/cre (RWA Gateway) ─────────────────┐   │
└──────────────────────────────────────────────────────────────────────┼───┘
                                                                        │
                                                                        ▼
                                                          RWA Gateway webhook
                                                          → TrustSync attestation
                                                          scripts/createAttestation.ts
```

---

## Chainlink Files

Required links per Chainlink hackathon submission rules:

| File | Description |
|------|-------------|
| [`workflow/main.ts`](workflow/main.ts) | CRE workflow entry point — EVM Log Trigger on `RequestSent` |
| [`workflow/logCallback.ts`](workflow/logCallback.ts) | CRE log handler — queries 3 disaster APIs, checks Enforcer eligibility, writes `onReport()`, notifies RWA Gateway |
| [`workflow/workflow.yaml`](workflow/workflow.yaml) | CRE CLI settings (staging + production targets) |
| [`workflow/config.staging.json`](workflow/config.staging.json) | Staging config — Sepolia, chain selector, gas limit, Instruxi URLs |
| [`workflow/config.production.json`](workflow/config.production.json) | Production config template |
| [`contracts/utils/ChainlinkCREClient.sol`](contracts/utils/ChainlinkCREClient.sol) | Abstract CRE base — `_sendRequest()` / `_validateAndFulfillRequest()` / `_fulfillRequest()` |
| [`contracts/ReliefTreasury.sol`](contracts/ReliefTreasury.sol) | Main contract — inherits `ChainlinkCREClient`, implements `onReport()` |
| [`contracts/interfaces/IReliefTreasury.sol`](contracts/interfaces/IReliefTreasury.sol) | Interface — declares `onReport()`, `fulfillRequest()`, `cancelRequest()` CRE callback signatures |
| [`deploy/001_deploy_relief_treasury.ts`](deploy/001_deploy_relief_treasury.ts) | Deploy script — deploys treasury and authorizes Chainlink Forwarder post-deploy |
| [`tasks/relief-tasks.ts`](tasks/relief-tasks.ts) | Hardhat tasks — `request-verification` emits `RequestSent` to trigger CRE, `register-event`, `activate-event` |

### CRE Integration Details

- **Trigger:** EVM Log Trigger on `RequestSent(bytes32 indexed requestId, address indexed requester, string requestType, bytes requestData)`
- **Callback:** Chainlink Forwarder calls `onReport(bytes metadata, bytes report)` on the contract
- **Report format:** `report[0]` = prefix byte; `report[1:]` = ABI-encoded payload
  - `0x01` = event verification: `abi.encode(bytes32 requestId, bool verified)`
  - `0x02` = disbursement: `abi.encode(bytes32 requestId, bool allowed, uint8 tier)`
  - `tier` is extracted from the Instruxi Enforcer group name suffix (e.g. `Eligible:US-FLOOD-2026:US-CA:2` → tier 2)
- **Forwarder address (Sepolia):** `0x15fc6ae953e024d975e77382eeec56a9101f9f88`
- **After every fulfillment:** `logCallback.ts` calls `POST /api/webhooks/cre` on the RWA Gateway, which auto-creates a TrustSync attestation as a side-effect

---

## Repository Structure

```
instruxi-disaster-relief/
│
├── contracts/
│   ├── ReliefTreasury.sol          # USDC treasury + CRE callbacks + invariants
│   ├── interfaces/
│   │   └── IReliefTreasury.sol     # Events, errors, function signatures
│   ├── mocks/
│   │   └── MockUSDC.sol            # 6-decimal ERC20 for local testing
│   └── utils/
│       └── ChainlinkCREClient.sol  # Abstract CRE request/response base
│
├── workflow/                       # Chainlink CRE workflow (TypeScript)
│   ├── main.ts                     # Entry point — EVM Log Trigger setup
│   ├── logCallback.ts              # RequestSent handler + API queries
│   ├── workflow.yaml               # CRE CLI config (staging + production)
│   ├── config.staging.json         # Staging runtime config
│   ├── config.production.json      # Production runtime config template
│   ├── package.json
│   └── tsconfig.json
│
├── scripts/                        # Instruxi API integration scripts
│   ├── instruxi.ts                 # Typed client — all Instruxi API endpoints
│   ├── gateway.ts                  # Typed client — RWA Gateway endpoints
│   ├── setupGroups.ts              # Phase 3A: create Enforcer group hierarchy
│   ├── onboardRecipient.ts         # Phase 3A: register → profile → groups wrapper
│   ├── uploadRoster.ts             # Phase 3C: CSV upload to Object Storage
│   ├── processRoster.ts            # Phase 4: ingest roster → onboard → archive
│   └── createAttestation.ts        # Phase 7: proof-of-funds + disbursement batch
│
├── deploy/
│   ├── 000_deploy_mocks.ts         # MockUSDC (localhost only)
│   └── 001_deploy_relief_treasury.ts # ReliefTreasury + authorize Forwarder
│
├── tasks/
│   └── relief-tasks.ts             # Hardhat tasks: fund, register-event, etc.
│
├── test/
│   └── ReliefTreasury.test.ts      # 34 tests — full contract coverage
│
├── rosters/
│   └── sample-roster.csv           # Example CSV for processRoster.ts
│
├── .env.example                    # All required environment variables
└── secrets.yaml.example            # CRE workflow secrets template
```

---

## End-to-End Flow

### Phase 1 — Setup Groups (run once per program)

```bash
npm run setup-groups -- --program US-FLOOD-2026 --regions "US-CA,US-TX,US-FL"
```

Creates `Admins:US-FLOOD-2026`, `Partners:US-FLOOD-2026`, `Eligible:US-FLOOD-2026:US-CA:1`, `Eligible:US-FLOOD-2026:US-CA:2`, etc. in Instruxi Enforcer. The `:1`/`:2` suffix encodes the tier. Save the returned group IDs.

### Phase 2 — Deploy Contract

```bash
cp .env.example .env   # fill in values
npx hardhat deploy --network sepolia
```

Update `workflow/config.staging.json` with the deployed `reliefTreasuryAddress` and your Instruxi `policyId`.

### Phase 3 — Fund Treasury + Register Event

> **Admin role note:** For this hackathon, Instruxi is the admin wallet. In production this should be the charity or funding organisation's wallet — the entity that controls the money and is accountable for tier amount commitments.

```bash
# Via Hardhat tasks
npx hardhat deposit-usdc --network sepolia \
  --contract 0x<TREASURY> --usdc 0x<USDC> --amount 10000000000

# Register event and atomically commit per-tier payout amounts
# Tier amounts are locked at registration — they cannot be changed after this call.
npx hardhat register-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... --cap 5000000000 \
  --tiers 1,2 --amounts 50000000,100000000

npx hardhat request-verification --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... \
  --ref '{"usgsId":"us7000abc","region":"US","minMagnitude":5.0}'
```

The `requestEventVerification` call emits `RequestSent` → CRE picks it up, queries USGS + GDACS + ReliefWeb (2-of-3), writes `onReport()` back.

### Phase 4 — Upload & Process Recipient Roster

```bash
# Partner uploads CSV to Instruxi Object Storage
npm run upload-roster -- --file rosters/sample-roster.csv \
  --program US-FLOOD-2026 --region US-CA

# Admin triggers ingestion (fetches via presigned URL, validates, onboards)
npm run process-roster -- \
  --file-id <returned-file-id> \
  --program US-FLOOD-2026 --region US-CA \
  --tier-group-ids '{"1":"groupId_standard","2":"groupId_priority"}'
```

`processRoster` runs the full pipeline: presigned URL download → CSV validation → `POST /profile/multi-create` → tier-based `POST /admin/groups/account/add-multiple` (standard tier→`:1` group, priority tier→`:2` group) → archive file.

After processing, anchor the roster hash onchain for public auditability:

```bash
# SHA-256 of the original CSV, anchored so anyone can verify tier assignments
npx hardhat anchor-roster --network sepolia \
  --contract 0x<TREASURY> \
  --rosterhash 0x<SHA256_OF_CSV> \
  --eventid 0x... \
  --program US-FLOOD-2026 \
  --region US-CA
```

This emits `RosterAnchored(rosterHash, eventId, program, region)` onchain. Anyone can SHA-256 the original CSV and compare to this event to verify that the tier assignments were not tampered with after anchoring.

### Phase 5 — Activate Event

```bash
npx hardhat activate-event --network sepolia --event-id 0x...
```

Only possible after CRE has verified the event (status `Verified`). Admin calls `activateEvent()` → status becomes `Active` → disbursements open.

### Phase 6 — Recipient Claims

Recipients call `claimDisbursement(eventId)` via the frontend (Privy SDK wallet → SIWE → Enforcer). This emits `RequestSent("disbursement", ...)` → CRE:
1. Calls `POST /enforcer/auth/authorize` (OPA policy) → must return `{ allowed: true }`
2. Calls `GET /admin/groups/account/{address}/groups` → extracts tier from group name suffix (e.g. `....:2` → tier 2)
3. Writes `onReport(0x02 + encode(requestId, allowed=true, tier=2))`
4. Contract resolves `amount = _eventTierAmounts[eventId][2]` (locked at registration) and transfers USDC

### Phase 7 — Attestations (TrustSync)

After every CRE disbursement fulfillment, `logCallback.ts` automatically calls `POST /api/webhooks/cre` on the RWA Gateway, which triggers attestation creation. For manual/scheduled proof-of-funds snapshots:

```bash
# Proof of treasury funds (after deposit)
npm run attest -- proof-of-funds \
  --treasury 0xReliefTreasury --usdc 0xUSDC \
  --balance 10000000000 --chain-id 11155111 --account 0xAdmin

# Proof of disbursement batch (after event closes)
npm run attest -- proof-of-disbursement \
  --treasury 0xReliefTreasury --usdc 0xUSDC \
  --chain-id 11155111 --account 0xAdmin \
  --auditor 0xAuditor --auditor-sig 0x... \
  --disbursements '[{"recipient":"0x..","amount":50000000,"txHash":"0x..","eventId":"0x.."}]'
```

---

## Scripts Reference

All scripts use `dotenv/config` — copy `.env.example` to `.env` and fill in values before running.

| Script | Command | Description |
|--------|---------|-------------|
| `setupGroups.ts` | `npm run setup-groups` | Create Enforcer group hierarchy for a program |
| `onboardRecipient.ts` | `npm run onboard-recipient` | Register + profile + group-assign a single wallet |
| `uploadRoster.ts` | `npm run upload-roster` | Upload CSV roster to Instruxi Object Storage |
| `processRoster.ts` | `npm run process-roster` | Full ingestion: download → validate → onboard → archive |
| `createAttestation.ts` | `npm run attest` | Create proof-of-funds or proof-of-disbursement batch |

### Instruxi API Endpoints Used

| Endpoint | Script | Purpose |
|----------|--------|---------|
| `GET /enforcer/account/exists/{address}` | onboardRecipient | Check before registering |
| `POST /enforcer/auth/account/register` | onboardRecipient | Register new Enforcer account |
| `POST /enforcer/auth/authorize` | uploadRoster, processRoster | Policy gate (partner/admin check) |
| `POST /profile/multi-create` | onboardRecipient, processRoster | Batch create profiles |
| `POST /admin/groups/create` | setupGroups | Create group hierarchy |
| `POST /admin/groups/account/add-multiple` | onboardRecipient, processRoster | Assign to eligible groups |
| `POST /enforcer/auth/authorize` | logCallback.ts (CRE) | OPA policy check at disbursement claim time |
| `GET /admin/groups/account/{addr}/groups` | logCallback.ts (CRE) | Fetch groups; extract tier from group name suffix |
| `POST /os/file/upload` | uploadRoster | Upload CSV roster |
| `POST /os/file/metadata` | uploadRoster | Tag with program/region metadata |
| `GET /storage/file/presigned-url` | processRoster | Time-limited download URL |
| `POST /storage/file/move` | processRoster | Archive processed roster |
| `POST /rwa/attestation/create` | createAttestation | Proof-of-funds / per-disbursement proof |
| `POST /rwa/attestation/publish` | createAttestation | Make attestation public |
| `POST /rwa/attestation-batches` | createAttestation | Group disbursement proofs |
| `POST /rwa/attestation-batches/{id}/link` | createAttestation | Link attestations to batch |
| `GET /rwa/attestation-batches/{id}/validate` | createAttestation | Verify batch totals |
| `GET /rwa/attestation-batches/{id}/metrics` | createAttestation | Dashboard metrics |
| `POST /api/webhooks/cre` | logCallback.ts (CRE) | Notify Gateway after fulfillment |

---

## CRE Workflow

### Setup

```bash
cd workflow
bun install    # or npm install
```

### Secrets

Copy `secrets.yaml.example` to `secrets.yaml` (one level above `workflow/`):

```yaml
INSTRUXI_API_KEY: "<your-key>"
RWA_GATEWAY_JWT: "<your-gateway-jwt>"
```

### Config

`workflow/config.staging.json`:
```json
{
  "reliefTreasuryAddress": "0x<DEPLOYED_CONTRACT>",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "gasLimit": "500000",
  "instruxi": {
    "baseUrl": "https://api.instruxi.io",
    "eligibilityGroupPrefix": "Eligible:",
    "rwGatewayUrl": "https://gateway.instruxi.io",
    "policyId": "<YOUR_INSTRUXI_POLICY_ID>"
  }
}
```

### Simulate

```bash
cre workflow simulate disaster-relief-workflow \
  --non-interactive \
  --trigger-index 0 \
  --evm-tx-hash <TX_HASH_CONTAINING_REQUEST_SENT> \
  --evm-event-index 0 \
  --target staging-settings
```

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full step-by-step guide: credentials checklist → Sepolia deploy → contract verification → CRE simulation → end-to-end scripts run → attestation.

---

## Smart Contract Development

### Prerequisites

- Node.js 20+

```bash
npm install
```

### Commands

```bash
npx hardhat compile          # Compile + generate TypeChain types
npx hardhat test             # Run 34 tests
npx hardhat node             # Local Hardhat node
npx hardhat deploy --network localhost
npx hardhat deploy --network sepolia
```

### Hardhat Tasks

```bash
# All tasks require --contract <ReliefTreasury address>

npx hardhat deposit-usdc --network sepolia \
  --contract 0x<TREASURY> --usdc 0x<USDC> --amount 1000000000

# Atomically register event + lock per-tier payout amounts
npx hardhat register-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... --cap 5000000000 \
  --tiers 1,2 --amounts 50000000,100000000

npx hardhat request-verification --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... \
  --ref '{"usgsId":"us7000abc","region":"US","minMagnitude":5.0}'

npx hardhat activate-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x...

# Anchor processed roster SHA-256 hash onchain for public auditability
npx hardhat anchor-roster --network sepolia \
  --contract 0x<TREASURY> --rosterhash 0x<SHA256> \
  --eventid 0x... --program US-FLOOD-2026 --region US-CA

npx hardhat claim-disbursement --network sepolia \
  --contract 0x<TREASURY> --eventid 0x...

npx hardhat treasury-status --network sepolia \
  --contract 0x<TREASURY> [--eventid 0x...]
```

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
# Deployment
DEPLOYER_PRIVATE_KEY=0x...
ALCHEMY_API_KEY=
CHAINLINK_FORWARDER_ADDRESS=0x15fc6ae953e024d975e77382eeec56a9101f9f88

# ReliefTreasury
ADMIN_ADDRESS=
USDC_ADDRESS=
PER_RECIPIENT_CAP=50000000       # $50 USDC (6 decimals)
PROGRAM_CAP=1000000000000        # $1,000,000 USDC

# Instruxi API (scripts/)
INSTRUXI_BASE_URL=https://api.instruxi.io
INSTRUXI_API_KEY=
INSTRUXI_ADMIN_JWT=
INSTRUXI_TENANT_ID=

# RWA Gateway (scripts/ + workflow/)
RWA_GATEWAY_URL=https://gateway.instruxi.io
RWA_GATEWAY_JWT=
```

---

## Roster CSV Format

`rosters/sample-roster.csv` shows the expected schema:

| Column | Description |
|--------|-------------|
| `phone_or_ref` | Phone number or external reference ID |
| `address` | Wallet address (`0x...`) — required for onchain eligibility |
| `regionId` | Region code matching an `Eligible:Program:Region` group |
| `eligibilityStatus` | `eligible` \| `ineligible` \| `pending` |
| `payoutTier` | `standard` \| `priority` \| `none` |
| `email` | Optional — used in Enforcer profile |
| `first_name` | Optional |
| `last_name` | Optional |

---

## Onchain Invariants

Enforced by `ReliefTreasury.sol` regardless of what the CRE workflow sends:

| Invariant | Check |
|-----------|-------|
| Event must be Active | `ev.status == EventStatus.Active` |
| No double payment | `_claimed[eventId][recipient] == false` |
| No pending request spam | `_hasPendingRequest[eventId][recipient]` gate in `claimDisbursement` |
| Tier must be configured | `_eventTierAmounts[eventId][tier] > 0` (graceful return on unconfigured tier) |
| Tier ceiling at registration | `registerEvent` enforces `amount <= perRecipientCap` per tier |
| Per-event cap | `ev.totalDisbursed + amount <= ev.perEventCap` (graceful return on exceeded) |
| Program cap | `totalDisbursed + amount <= programCap` (graceful return on exceeded) |
| Treasury balance | `usdc.balanceOf(address(this)) >= amount` (graceful return on shortfall) |

---

## Security

- `ReentrancyGuard` on all state-changing external functions
- `Pausable` with `emergencyWithdraw` for crisis response
- `AccessControl` — `DEFAULT_ADMIN_ROLE`, `DEPOSITOR_ROLE`, `PAUSER_ROLE`
- `authorizedFulfillers` mapping — only the Chainlink Forwarder (or admin-approved addresses) can call `onReport()` or `fulfillRequest()`
- CEI pattern — all state mutations before `safeTransfer`
- CRE workflow cannot bypass onchain invariants — it can only provide a `bool` result; the contract enforces all caps and guards independently

---

## What's Onchain vs. Offchain

| Onchain (Transparent, Immutable) | Offchain (Private, Policy-Gated) |
|----------------------------------|----------------------------------|
| USDC treasury balance | Recipient identity (Enforcer profiles) |
| Event verification fulfillment tx | Roster CSV (encrypted Object Storage) |
| Disbursement transactions | Group memberships + tier assignment (Enforcer) |
| TrustSync attestations + batch proofs | Policy decisions (OPA Rego) |
| Per-event tier amounts (locked at `registerEvent`) | Phone/email → wallet mapping (Privy) |
| Roster SHA-256 hashes (`RosterAnchored` events) | Roster CSV contents (encrypted Object Storage) |
| CRE workflow enforces auth (`INSTRUXI_API_KEY`, `RWA_GATEWAY_JWT` from `runtime.secrets()`) | API credentials (CRE secrets vault) |

---

## License

MIT
