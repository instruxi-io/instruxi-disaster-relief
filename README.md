# CRE-Orchestrated Disaster Relief Distribution

A SaaS disbursement platform for disaster relief charities, built on Instruxi + Chainlink CRE + Privy. Charities allocate funds into a USDC treasury. Chainlink CRE runs two onchain-write pipelines: disaster event verification (2-of-3 external API consensus) and recipient eligibility registration (OPA policy validation). Once CRE writes eligibility onchain, eligible recipients claim directly , every action producing a cryptographic TrustSync attestation.

> **Hackathon track:** Chainlink CRE
> **Stack:** Instruxi Enforcer · Instruxi Object Storage · TrustSync Attestations · Chainlink CRE · Solidity · Hardhat · Privy

---

## Design Decisions

This project makes specific architectural choices around privacy, decentralization, and correctness. Each decision below is documented with its technical reasoning and the production upgrade path. Some are sound by design and would remain in V2. Others are explicit scope decisions tied to this build. **None of these are unknowns or missed edge cases.**

---

### CRE as the Onchain Eligibility Writer

The central design principle: **no one except the Chainlink Forwarder (controlled by the DON running the CRE workflow) can write eligibility state to the contract.**

The admin provides a candidate wallet batch , outputs of `processRoster` , by calling `requestEligibilityRegistration(eventId, addresses[], tiers[])`. This emits `RequestSent`. The CRE workflow picks it up, runs each wallet through the OPA policy (`POST /enforcer/auth/authorize`), and writes back only the approved recipients via `onReport(0x02 + abi.encode(requestId, approvedAddrs[], tiers[]))`. The contract stores `_eligible[eventId][addr] = tier` for each approved recipient.

Recipients then call `claimDisbursement(eventId)` , the contract checks `_eligible[eventId][msg.sender]` onchain and pays immediately. No CRE round-trip at claim time. Eligibility is a permanent onchain fact; the disbursement is a simple check-and-transfer.

This makes CRE the **trusted writer of the onchain eligibility gate**, not just an API gateway. The sequence is:
1. CRE verifies the disaster event → writes `EventVerified` status onchain
2. CRE validates the recipient batch → writes `_eligible` mapping onchain
3. Recipients claim directly against CRE-written onchain state

**Known limitation:** The onchain contract trusts the CRE/Enforcer pipeline for eligibility. A compromised Instruxi API could approve an ineligible recipient. Cap checks and the double-payment guard limit blast radius but do not close this trust assumption.

**V2:** Merkle root committed onchain at `anchorRoster` time. Recipient submits a Merkle proof at claim time. Eligibility and tier verified entirely onchain with no offchain trust.

---

### Eligibility Is Private; The Gate Is Onchain

Recipient wallet-to-eligibility mappings are personally identifiable data. Storing the full roster onchain would be a GDPR problem and a privacy failure. Instruxi Enforcer keeps that mapping encrypted and access-controlled.

What _is_ onchain: the `EligibilitySet(eventId, recipient, tier)` events , written by CRE after OPA validates each wallet. The full roster CSV is never onchain. The SHA-256 hash of the roster CSV is anchored via `anchorRoster()` , anyone can hash the original CSV and compare to the `RosterAnchored` event to verify that tier assignments weren't modified after processing.

Tier is encoded in the Enforcer group name suffix at group creation time (e.g. `Eligible:US-FLOOD-2026:US-CA:2` → tier 2). The CRE workflow uses this when assigning groups via `processRoster`, and the claim validates against the onchain `_eligible` mapping , not against the group name at claim time.

---

### OPA Policy Inside the DON

The OPA policy check , `POST /enforcer/auth/authorize` with `{ action: "claim_disbursement", recipient, eventId }` , runs inside the Chainlink DON as part of the CRE eligibility_registration workflow, not on a centralized application server. The `eventId` is included so the policy can scope decisions to a specific event, preventing cross-event eligibility abuse.

5xx responses and 401/403 auth errors throw so the DON retries rather than writing a permanent partial denial of the batch. A misconfigured or expired API key surfaces as a retryable error. Only a 200 `{ allowed: false }` is treated as a definitive policy denial for a specific wallet.

---

### Disbursement is Synchronous , No Async Race

Because eligibility is written onchain by CRE before any recipient claims, `claimDisbursement` is a simple synchronous function: check `_eligible`, check caps, transfer. There is no async CRE request/callback cycle at claim time.

This eliminates the entire class of async callback risks: no poison-pill reverts (callback can't revert because there is no callback), no pending request spam (no in-flight requests to spam), no permanent denial due to transient API errors at claim time. The disbursement is as trustless as any ERC20 transfer , the eligibility condition was already validated by the DON.

**V2:** The current design is already close to the Merkle proof architecture. Replacing `_eligible[eventId][addr]` with a Merkle root and adding `claimDisbursement(bytes32 eventId, bytes32[] proof, uint8 tier)` eliminates offchain trust entirely.

---

### Roster Hash Anchoring

`anchorRoster()` takes the SHA-256 of the raw CSV bytes as a `bytes32` and emits `RosterAnchored(rosterHash, eventId, program, region)`. Anyone can hash the original CSV and compare to this event.

**Known limitation:** SHA-256 of raw bytes is sensitive to line ending differences (CRLF vs. LF). A Windows machine and a Linux CI pipeline produce different hashes for the same logical file. For a controlled demo environment this is acceptable.

**V2:** Normalize to LF and sort fields canonically before hashing, or hash a JSON representation with fixed field ordering.

---

### Single Admin Wallet

A single EOA holds `DEFAULT_ADMIN_ROLE`. This controls event registration, activation, closure, emergency withdrawal, fulfiller authorization, and eligibility registration requests. There is no multisig and no timelock.

This is an explicit scope decision. There is no technical justification for a single admin key in a contract holding real funds.

**Production requirement:** Transfer `DEFAULT_ADMIN_ROLE` to a Gnosis Safe multisig immediately post-deploy. Wrap `registerEvent`, `activateEvent`, `closeEvent`, `requestEligibilityRegistration`, and `emergencyWithdraw` behind an OpenZeppelin `TimelockController`. The contract architecture is fully compatible , no code changes required.

---

## Known Limitations

Explicitly identified and out of scope for this build. The contract is designed to accommodate each upgrade without breaking changes.

| Limitation | Impact | V2 Path |
|---|---|---|
| Eligibility trust | `_eligible` trusts CRE/Enforcer OPA pipeline | Onchain Merkle proof at claim time |
| Eligibility batch size | Large rosters hit calldata/gas limits | Split batches; CRE multi-call pattern |
| Single admin key | One compromised key can drain treasury | Gnosis Safe + TimelockController |
| Raw CSV hashing | Hash differs across OS line endings | Canonical normalization before SHA-256 |
| No `EventStatus.Rejected` | Failed verification leaves event in `Pending`; admin closes manually | `Rejected` status + `EventRejected` event |
| Sequential `processRoster` | Large rosters require sequential processing | Worker queue + batch API endpoints |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          OFFCHAIN LAYER                                 │
│                                                                         │
│  Admin Dashboard              Partner Upload         Recipient Frontend │
│  (fund treasury,              (CSV roster →          (Privy SDK wallet  │
│   register event,              Object Storage)        → SIWE → claim)   │
│   trigger CRE)                      │                       │           │
│        │                            │                       │           │
│        ▼                            ▼                       │           │
│  scripts/setupGroups.ts      scripts/uploadRoster.ts        │           │
│  scripts/processRoster.ts ────────────────────────          │           │
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
│   ReliefTreasury.sol (implements IReceiver)                      │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │  Pipeline 1: registerEvent() → requestEventVerification()      │    │
│   │  Pipeline 2: requestEligibilityRegistration(addrs[], tiers[])  │    │
│   │  Claim:      claimDisbursement() → reads _eligible → transfer  │    │
│   │  Invariants: caps · no-double-pay · eligibility gate           │    │
│   └────────────────────────────────────────────────────────────────┘    │
│          │ RequestSent event              ▲ onReport(metadata, report)  │
└──────────┼────────────────────────────────┼────────────────────────────┘
           │                                │
           ▼                                │
┌──────────────────────────────────────────────────────────────────────────┐
│                      CHAINLINK CRE WORKFLOW                              │
│                                                                          │
│  workflow/main.ts , EVM Log Trigger on RequestSent                       │
│  workflow/logCallback.ts                                                 │
│                                                                          │
│  requestType = "event_verification"   requestType = "eligibility_registration"
│         │                                    │                           │
│         ▼                                    ▼                           │
│  USGS + GDACS + ReliefWeb         For each candidate wallet:             │
│  (2-of-3 consensus)               POST /enforcer/auth/authorize (OPA)   │
│         │                         Only approved wallets → onReport       │
│         │                                    │                           │
│         └── onReport(0x01 + encode(requestId, verified)) ──┘             │
│              onReport(0x02 + encode(requestId, addrs[], tiers[]))         │
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
| [`workflow/main.ts`](workflow/main.ts) | CRE workflow entry point , EVM Log Trigger on `RequestSent` |
| [`workflow/logCallback.ts`](workflow/logCallback.ts) | CRE log handler , 2-of-3 disaster API consensus + OPA eligibility batch validation + `onReport()` |
| [`workflow/workflow.yaml`](workflow/workflow.yaml) | CRE CLI settings (staging + production targets) |
| [`workflow/config.staging.json`](workflow/config.staging.json) | Staging config , Sepolia, chain selector, gas limit, Instruxi URLs |
| [`workflow/config.production.json`](workflow/config.production.json) | Production config template |
| [`contracts/utils/ChainlinkCREClient.sol`](contracts/utils/ChainlinkCREClient.sol) | Abstract CRE base , `_sendRequest()` / `_validateAndFulfillRequest()` / `_fulfillRequest()` |
| [`contracts/ReliefTreasury.sol`](contracts/ReliefTreasury.sol) | Main contract , inherits `ChainlinkCREClient`, implements `onReport()` |
| [`contracts/interfaces/IReliefTreasury.sol`](contracts/interfaces/IReliefTreasury.sol) | Interface , declares `onReport()`, `fulfillRequest()`, `cancelRequest()` CRE callback signatures |
| [`deploy/001_deploy_relief_treasury.ts`](deploy/001_deploy_relief_treasury.ts) | Deploy script , deploys treasury and authorizes Chainlink Forwarder post-deploy |
| [`tasks/relief-tasks.ts`](tasks/relief-tasks.ts) | Hardhat tasks , `request-verification`, `register-event`, `activate-event`, `request-eligibility` |

### CRE Integration Details

Four CRE EVM Log Triggers on a single workflow (`workflow/main.ts`):

| Pipeline | `--trigger-index` | Trigger Event | Handler | Onchain Write |
|----------|:-----------------:|---------------|---------|:-------------:|
| 1 , Event Verification | 0 | `RequestSent(requestType="event_verification")` | `onRequestSent` → 2-of-3 consensus | `onReport(0x01 + encode(requestId, verified))` |
| 2 , Eligibility Registration | 0 | `RequestSent(requestType="eligibility_registration")` | `onRequestSent` → OPA batch | `onReport(0x02 + encode(requestId, addrs[], tiers[]))` |
| 3 , Proof-of-Disbursement | 1 | `Disbursed(eventId, recipient, amount)` | `onDisbursed` → attestation create + publish | None (pure offchain side-effect) |
| 4 , Proof-of-Funds | 2 | `Deposited(depositor, amount)` | `onDeposited` → attestation create + publish | None (pure offchain side-effect) |

- **Pipelines 1 & 2 callback:** Chainlink Forwarder calls `onReport(bytes metadata, bytes report)` on the contract
- **Report format:** `report[0]` = prefix byte; `report[1:]` = ABI-encoded payload
  - `0x01` = event verification: `abi.encode(bytes32 requestId, bool verified)`
  - `0x02` = eligibility registration: `abi.encode(bytes32 requestId, address[] approvedRecipients, uint8[] tiers)`
  - Only OPA-approved recipients are included in the `0x02` payload
- **Pipelines 3 & 4:** No onchain write. Fire `POST /rwa/attestation/create` + `POST /rwa/attestation/publish` directly via Instruxi API on every `Disbursed` / `Deposited` event , zero admin action required
- **Forwarder address (Sepolia):** `0x15fc6ae953e024d975e77382eeec56a9101f9f88`
- **After Pipelines 1 & 2 fulfillment:** `logCallback.ts` calls `POST /api/webhooks/cre` on the RWA Gateway, which auto-creates a TrustSync attestation as a side-effect
- **Verify attestations:** `npm run query-attestations -- --treasury 0x<CONTRACT_ADDRESS>`

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
│   ├── main.ts                     # Entry point , EVM Log Trigger setup
│   ├── logCallback.ts              # RequestSent handler + API queries
│   ├── workflow.yaml               # CRE CLI config (staging + production)
│   ├── config.staging.json         # Staging runtime config
│   ├── config.production.json      # Production runtime config template
│   ├── package.json
│   └── tsconfig.json
│
├── scripts/                        # Instruxi API integration scripts
│   ├── instruxi.ts                 # Typed client , all Instruxi API endpoints
│   ├── gateway.ts                  # Typed client , RWA Gateway endpoints
│   ├── setupGroups.ts              # Phase 1: create Enforcer group hierarchy
│   ├── onboardRecipient.ts         # Phase 3: register → profile → groups wrapper
│   ├── uploadRoster.ts             # Phase 4A: CSV upload to Object Storage
│   ├── processRoster.ts            # Phase 4B: ingest roster → onboard → archive
│   ├── createAttestation.ts        # Phase 7: manual proof-of-funds + disbursement batch
│   └── queryAttestations.ts        # Phase 7: query auto-created attestations (CRE 3 & 4)
│
├── deploy/
│   ├── 000_deploy_mocks.ts         # MockUSDC (localhost only)
│   └── 001_deploy_relief_treasury.ts # ReliefTreasury + authorize Forwarder
│
├── tasks/
│   └── relief-tasks.ts             # Hardhat tasks: fund, register-event, etc.
│
├── test/
│   └── ReliefTreasury.test.ts      # 37 tests , full contract coverage
│
├── rosters/
│   └── sample-roster.csv           # Example CSV for processRoster.ts
│
├── .env.example                    # All required environment variables
└── secrets.yaml.example            # CRE workflow secrets template
```

---

## End-to-End Flow

### Phase 1 , Setup Groups (run once per program)

```bash
npm run setup-groups -- --program US-FLOOD-2026 --regions "US-CA,US-TX,US-FL"
```

Creates `Admins:US-FLOOD-2026`, `Partners:US-FLOOD-2026`, `Eligible:US-FLOOD-2026:US-CA:1`, `Eligible:US-FLOOD-2026:US-CA:2`, etc. in Instruxi Enforcer. The `:1`/`:2` suffix encodes the tier. Save the returned group IDs.

### Phase 2 , Deploy Contract

```bash
cp .env.example .env   # fill in values
npx hardhat deploy --network sepolia
```

Update `workflow/config.staging.json` with the deployed `reliefTreasuryAddress` and your Instruxi `policyId`.

### Phase 3 , Fund Treasury + Register Event

> **Admin role note:** For this hackathon, Instruxi is the admin wallet. In production this should be the charity or funding organisation's wallet , the entity that controls the money and is accountable for tier amount commitments.

```bash
# Via Hardhat tasks
npx hardhat deposit-usdc --network sepolia \
  --contract 0x<TREASURY> --usdc 0x<USDC> --amount 10000000000

# Register event and atomically commit per-tier payout amounts
# Tier amounts are locked at registration , they cannot be changed after this call.
npx hardhat register-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... --cap 5000000000 \
  --tiers 1,2 --amounts 50000000,100000000

# CRE Pipeline 1: verify the disaster event via 3 external APIs
npx hardhat request-verification --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... \
  --ref '{"usgsId":"us7000abc","region":"US","minMagnitude":5.0}'
```

The `requestEventVerification` call emits `RequestSent` → CRE picks it up, queries USGS + GDACS + ReliefWeb (2-of-3), writes `onReport(0x01 + encode(requestId, verified))` back → `EventVerified` emitted onchain.

### Phase 4 , Upload & Process Recipient Roster

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

`processRoster` runs the full pipeline: presigned URL download → CSV validation → `POST /profile/multi-create` → tier-based `POST /admin/groups/account/add-multiple` (standard tier → `:1` group, priority tier → `:2` group) → archive file.

After processing, anchor the roster hash onchain for public auditability:

```bash
npx hardhat anchor-roster --network sepolia \
  --contract 0x<TREASURY> \
  --rosterhash 0x<SHA256_OF_CSV> \
  --eventid 0x... \
  --program US-FLOOD-2026 \
  --region US-CA
```

This emits `RosterAnchored(rosterHash, eventId, program, region)` onchain. Anyone can SHA-256 the original CSV and compare to verify tier assignments were not tampered with.

### Phase 5 , Activate Event

```bash
npx hardhat activate-event --network sepolia --contract 0x<TREASURY> --eventid 0x...
```

Only possible after CRE has verified the event (status `Verified`). Admin calls `activateEvent()` → status becomes `Active`.

### Phase 5b , CRE Pipeline 2: Register Eligibility Onchain

```bash
# Admin submits the eligible wallets (from processRoster output) to CRE for OPA validation.
# CRE validates each wallet via OPA and writes _eligible[eventId][addr] = tier onchain.
npx hardhat request-eligibility --network sepolia \
  --contract 0x<TREASURY> \
  --eventid 0x... \
  --recipients "0xAddr1,0xAddr2,0xAddr3" \
  --tiers "1,1,2"
```

`requestEligibilityRegistration(eventId, addresses[], tiers[])` emits `RequestSent` → CRE picks it up, calls OPA for each wallet, writes back only approved recipients via `onReport(0x02 + encode(requestId, approvedAddrs[], tiers[]))` → `EligibilitySet(eventId, recipient, tier)` emitted for each approved wallet.

### Phase 6 , Recipient Claims

Recipients call `claimDisbursement(eventId)` via the frontend (Privy SDK wallet → SIWE → contract). The contract:
1. Checks `ev.status == Active`
2. Checks `_claimed[eventId][msg.sender] == false`
3. Reads `tier = _eligible[eventId][msg.sender]` , reverts `NotEligible` if 0
4. Resolves `amount = _eventTierAmounts[eventId][tier]` (locked at registration)
5. Checks all caps, transfers USDC, emits `Disbursed`

No CRE round-trip. Eligibility is onchain state written by the DON.

### Phase 7 , Attestations (TrustSync)

**Automatic (Pipelines 3 & 4):** Every `Disbursed` and `Deposited` event automatically triggers a TrustSync attestation via CRE. No admin action required. The CRE workflow calls `POST /rwa/attestation/create` + `POST /rwa/attestation/publish` directly.

```bash
# Verify attestations were created
npm run query-attestations -- --treasury 0x<CONTRACT_ADDRESS>
```

**After every CRE Pipelines 1 & 2 fulfillment:** `logCallback.ts` automatically calls `POST /api/webhooks/cre` on the RWA Gateway, which triggers attestation creation as a side-effect.

**Manual / scheduled proof-of-disbursement batches** (for auditor-signed batch proofs , distinct from per-disbursement auto-attestations):

```bash
npm run attest -- proof-of-disbursement \
  --treasury 0xReliefTreasury --usdc 0xUSDC \
  --chain-id 11155111 --account 0xAdmin \
  --auditor 0xAuditor --auditor-sig 0x... \
  --disbursements '[{"recipient":"0x..","amount":50000000,"txHash":"0x..","eventId":"0x.."}]'
```

---

## Scripts Reference

All scripts use `dotenv/config` , copy `.env.example` to `.env` and fill in values before running.

| Script | Command | Description |
|--------|---------|-------------|
| `setupGroups.ts` | `npm run setup-groups` | Create Enforcer group hierarchy for a program |
| `onboardRecipient.ts` | `npm run onboard-recipient` | Register + profile + group-assign a single wallet |
| `uploadRoster.ts` | `npm run upload-roster` | Upload CSV roster to Instruxi Object Storage |
| `processRoster.ts` | `npm run process-roster` | Full ingestion: download → validate → onboard → archive |
| `createAttestation.ts` | `npm run attest` | Manual proof-of-funds or auditor-signed disbursement batch |
| `queryAttestations.ts` | `npm run query-attestations` | Query TrustSync attestations for a treasury (replaces dashboard) |

### Instruxi API Endpoints Used

| Endpoint | Script | Purpose |
|----------|--------|---------|
| `GET /enforcer/account/exists/{address}` | onboardRecipient | Check before registering |
| `POST /enforcer/auth/account/register` | onboardRecipient | Register new Enforcer account |
| `POST /enforcer/auth/authorize` | uploadRoster, processRoster | Policy gate (partner/admin check) |
| `POST /profile/multi-create` | onboardRecipient, processRoster | Batch create profiles |
| `POST /admin/groups/create` | setupGroups | Create group hierarchy |
| `POST /admin/groups/account/add-multiple` | onboardRecipient, processRoster | Assign to eligible groups |
| `POST /enforcer/auth/authorize` | logCallback.ts (CRE) | OPA policy check per-wallet during eligibility_registration |
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

> **Deployment scope:** This guide targets a Sepolia testnet deployment with a single admin wallet. These are intentional scope decisions , the contract architecture is fully compatible with a Gnosis Safe + TimelockController without code changes. See [Design Decisions](#design-decisions) and [Known Limitations](#known-limitations) for the rationale and production upgrade path for each choice.

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
npx hardhat test             # Run 37 tests
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

# CRE Pipeline 1: request disaster event verification
npx hardhat request-verification --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... \
  --ref '{"usgsId":"us7000abc","region":"US","minMagnitude":5.0}'

npx hardhat activate-event --network sepolia \
  --contract 0x<TREASURY> --eventid 0x...

# CRE Pipeline 2: submit candidate eligibility batch to CRE for OPA validation
npx hardhat request-eligibility --network sepolia \
  --contract 0x<TREASURY> --eventid 0x... \
  --recipients "0xAddr1,0xAddr2" --tiers "1,2"

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
| `address` | Wallet address (`0x...`) , required for onchain eligibility |
| `regionId` | Region code matching an `Eligible:Program:Region` group |
| `eligibilityStatus` | `eligible` \| `ineligible` \| `pending` |
| `payoutTier` | `standard` \| `priority` \| `none` |
| `email` | Optional , used in Enforcer profile |
| `first_name` | Optional |
| `last_name` | Optional |

---

## Onchain Invariants

Enforced by `ReliefTreasury.sol` regardless of what the CRE workflow sends:

| Invariant | Check |
|-----------|-------|
| Event must be Active | `ev.status == EventStatus.Active` |
| CRE-written eligibility required | `_eligible[eventId][recipient] > 0` , reverts `NotEligible` |
| No double payment | `_claimed[eventId][recipient] == false` |
| Tier must be configured | `_eventTierAmounts[eventId][tier] > 0` |
| Tier ceiling at registration | `registerEvent` enforces `amount <= perRecipientCap` per tier |
| Per-event cap | `ev.totalDisbursed + amount <= ev.perEventCap` |
| Program cap | `totalDisbursed + amount <= programCap` |
| Treasury balance | `usdc.balanceOf(address(this)) >= amount` |

---

## Security

### Enforced Onchain (Cannot Be Bypassed by Any Offchain Component)

| Guard | Mechanism |
|---|---|
| No payout unless event is Active | `ev.status == EventStatus.Active` checked before every transfer |
| No payout without CRE-written eligibility | `_eligible[eventId][recipient] > 0` , set exclusively by Chainlink Forwarder |
| No double payment | `_claimed[eventId][recipient]` write-once flag |
| Per-event cap | `ev.totalDisbursed + amount <= ev.perEventCap` |
| Program cap | `totalDisbursed + amount <= programCap` |
| Tier must be registered | `_eventTierAmounts[eventId][tier] > 0` |
| Tier ceiling at registration | Each tier amount bounded by `perRecipientCap` at `registerEvent` time |
| Reentrancy | `nonReentrant` on all state-changing external functions |
| Fulfiller whitelist | Only addresses in `authorizedFulfillers` can call `onReport()` |
| CEI pattern | All state mutations precede `safeTransfer` |

### Trust Model

The contract trusts the Chainlink Forwarder address in `authorizedFulfillers`. That Forwarder is controlled by the Chainlink DON, which runs the CRE workflow. The CRE workflow calls the Instruxi API.

```
ReliefTreasury.sol
  └── authorizedFulfillers (Chainlink Forwarder)
        └── Chainlink DON
              └── CRE workflow (logCallback.ts)
                    └── Instruxi API (OPA policy)
```

What this means:

- **The contract cannot be over-transferred.** All financial enforcement runs onchain independently. CRE writes eligibility state; the contract enforces caps, tiers, and double-claim guard.
- **The contract can be told to approve an ineligible recipient** if the Instruxi OPA policy is misconfigured or the API is compromised. Cap checks and the double-payment guard bound the damage per event and per program.
- **Admin key compromise is the highest-risk vector.** A compromised `DEFAULT_ADMIN_ROLE` key can pause the contract and drain via `emergencyWithdraw`, and can submit fraudulent eligibility batches to CRE. See [Known Limitations](#known-limitations) for the production mitigation.

---

## What's Onchain vs. Offchain

| Onchain (Transparent, Immutable) | Offchain (Private, Policy-Gated) |
|----------------------------------|----------------------------------|
| USDC treasury balance | Recipient identity (Enforcer profiles) |
| Event verification fulfillment tx | Roster CSV (encrypted Object Storage) |
| `EligibilitySet(eventId, recipient, tier)` events | Full roster data + wallet-PII mapping (Enforcer) |
| Disbursement transactions | Policy decisions (OPA Rego) |
| TrustSync attestations + batch proofs | Phone/email → wallet mapping (Privy) |
| Per-event tier amounts (locked at `registerEvent`) | Roster CSV contents (encrypted Object Storage) |
| Roster SHA-256 hashes (`RosterAnchored` events) | API credentials (`INSTRUXI_API_KEY`, `RWA_GATEWAY_JWT` , CRE secrets vault) |
| Cap enforcement + double-payment guard + eligibility gate | |

---

## License

MIT
