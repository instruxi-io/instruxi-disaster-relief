# CRE-Orchestrated Disaster Relief Distribution

A SaaS disbursement platform for disaster relief charities, built on Instruxi + Chainlink CRE + Privy. Charities allocate funds into a USDC treasury, Chainlink CRE verifies disaster events and validates recipient eligibility via Instruxi Enforcer, and eligible recipients claim directly to their wallets — every disbursement producing a cryptographic TrustSync attestation.

> **Hackathon track:** Chainlink CRE
> **Stack:** Instruxi Enforcer · Instruxi Object Storage · TrustSync Attestations · Chainlink CRE · Solidity · Hardhat · Privy

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
│   │  Invariants: caps · no-double-pay · eligibility│                    │
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
│  USGS + GDACS + ReliefWeb         Instruxi Enforcer                      │
│  (2-of-3 consensus)               GET /admin/groups/account/{addr}/groups│
│         │                                    │                           │
│         └──── onReport(0x01 + encode(requestId, verified)) ────┘         │
│               onReport(0x02 + encode(requestId, eligible))               │
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
| [`workflow/config.staging.json`](workflow/config.staging.json) | Staging config — Sepolia, gas limit, Instruxi URLs |
| [`workflow/config.production.json`](workflow/config.production.json) | Production config template |
| [`contracts/utils/ChainlinkCREClient.sol`](contracts/utils/ChainlinkCREClient.sol) | Abstract CRE base — `_sendRequest()` / `_validateAndFulfillRequest()` / `_fulfillRequest()` |
| [`contracts/ReliefTreasury.sol`](contracts/ReliefTreasury.sol) | Main contract — inherits `ChainlinkCREClient`, implements `onReport()` |

### CRE Integration Details

- **Trigger:** EVM Log Trigger on `RequestSent(bytes32 indexed requestId, address indexed requester, string requestType, bytes requestData)`
- **Callback:** Chainlink Forwarder calls `onReport(bytes metadata, bytes report)` on the contract
- **Report format:** `report[0]` = prefix byte; `report[1:]` = `abi.encode(bytes32 requestId, bool result)`
  - `0x01` = event verification result
  - `0x02` = disbursement eligibility result
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
│   └── ReliefTreasury.test.ts      # 29 tests — full contract coverage
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

Creates `Admins:US-FLOOD-2026`, `Partners:US-FLOOD-2026`, `Eligible:US-FLOOD-2026:US-CA`, etc. in Instruxi Enforcer. Save the returned group IDs.

### Phase 2 — Deploy Contract

```bash
cp .env.example .env   # fill in values
npx hardhat deploy --network sepolia
```

Update `workflow/config.staging.json` with the deployed `reliefTreasuryAddress`.

### Phase 3 — Fund Treasury + Register Event

```bash
# Via Hardhat tasks
npx hardhat deposit-usdc --network sepolia \
  --contract 0x<TREASURY> --usdc 0x<USDC> --amount 10000000000

npx hardhat register-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... --cap 5000000000

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
  --eligible-group-ids "groupId1,groupId2"
```

`processRoster` runs the full pipeline: presigned URL download → CSV validation → `POST /profile/multi-create` → `POST /admin/groups/account/add-multiple` → archive file.

### Phase 5 — Activate Event

```bash
npx hardhat activate-event --network sepolia --event-id 0x...
```

Only possible after CRE has verified the event (status `Verified`). Admin calls `activateEvent()` → status becomes `Active` → disbursements open.

### Phase 6 — Recipient Claims

Recipients call `claimDisbursement(eventId)` via the frontend (Privy SDK wallet → SIWE → Enforcer). This emits `RequestSent("disbursement", ...)` → CRE checks `GET /admin/groups/account/{address}/groups` → if eligible group found, writes `onReport()` → contract transfers USDC.

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
| `GET /admin/groups/account/{addr}/groups` | logCallback.ts (CRE) | Eligibility check at claim time |
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
    "rwGatewayUrl": "https://gateway.instruxi.io"
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

## Smart Contract Development

### Prerequisites

- Node.js 20+

```bash
npm install
```

### Commands

```bash
npx hardhat compile          # Compile + generate TypeChain types
npx hardhat test             # Run 29 tests
npx hardhat node             # Local Hardhat node
npx hardhat deploy --network localhost
npx hardhat deploy --network sepolia
```

### Hardhat Tasks

```bash
# All tasks require --contract <ReliefTreasury address>

npx hardhat deposit-usdc --network sepolia \
  --contract 0x<TREASURY> --usdc 0x<USDC> --amount 1000000000

npx hardhat register-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... --cap 100000000

npx hardhat request-verification --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... \
  --ref '{"usgsId":"us7000abc","region":"US","minMagnitude":5.0}'

npx hardhat activate-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x...

npx hardhat set-eligibility --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... --recipient 0x... --eligible true

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
| Recipient must be eligible | `_eligibility[eventId][recipient] == true` |
| Per-recipient cap | `amount <= perRecipientCap` |
| Per-event cap | `ev.totalDisbursed + amount <= ev.perEventCap` |
| Program cap | `totalDisbursed + amount <= programCap` |
| Treasury balance | `usdc.balanceOf(address(this)) >= amount` |

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
| Disbursement transactions | Group memberships (Enforcer) |
| TrustSync attestations + batch proofs | Policy decisions (OPA Rego) |
| Wallet → eligible mapping (per event) | Phone/email → wallet mapping (Privy) |

---

## License

MIT
