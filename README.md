# CRE-Orchestrated Disaster Relief Distribution

A transparent disbursement platform for humanitarian aid organizations, built on Instruxi + Chainlink CRE + Privy. Any relief org worldwide can deploy this, fund a USDC treasury, and run tamper-proof payouts with every step publicly auditable onchain.

Chainlink CRE runs four pipelines: disaster event verification (2-of-3 external API consensus against live global disaster databases), recipient eligibility registration (OPA policy validation), proof-of-disbursement attestation (TrustSync record created via Instruxi RWA Gateway on every payout), and proof-of-funds attestation (TrustSync record on every deposit). Once CRE writes eligibility onchain, eligible recipients claim directly.

---

## Why This Exists

Disaster relief is plagued by three interlinked problems: funds diverted before reaching victims, no way to verify that a disaster is real before disbursing, and no public record of who received what. Traditional aid organizations operate as black boxes. Donors cannot see the money move. Recipients have no recourse against arbitrary eligibility decisions.

This platform is designed for adoption by NGOs, UN agencies, and government aid programs that want to commit to transparency. The key properties:

- **Disaster verification is not admin-controlled.** CRE queries real live data (GDACS global disaster alerts, NASA EONET, USGS earthquake catalog) and 2-of-3 APIs must confirm the event before the contract transitions to Active. No admin can open disbursements for a fake event.
- **Eligibility is not admin-controlled - when `policyId` is set.** The Chainlink DON runs OPA policy validation on each recipient wallet and writes eligibility onchain. The admin cannot directly approve a recipient or bypass OPA. **Warning:** if `policyId` is left empty in `workflow/config.staging.json`, CRE skips OPA validation and approves all candidates submitted by the admin. This is the default for staging; set a real policy ID for production.
- **Every financial movement is cryptographically attested.** Deposits and disbursements automatically produce TrustSync attestations. Auditors can query the public attestation record without needing admin access.
- **The roster is anchored, not stored.** The SHA-256 of the recipient CSV is committed onchain at processing time. Anyone can hash the original file and verify it was not tampered with after the fact.

---

## Architecture

```
+-------------------------------------------------------------------------+
|                          OFFCHAIN LAYER                                 |
|                                                                         |
|  Admin / Funding Org          Partner Upload         Recipient Frontend |
|  (fund treasury,              (CSV roster ->          (Privy SDK wallet |
|   register event,              Object Storage)        -> SIWE -> claim) |
|   trigger CRE pipelines)            |                       |           |
|        |                            |                       |           |
|        v                            v                       |           |
|  scripts/setupGroups.ts      scripts/uploadRoster.ts        |           |
|  scripts/processRoster.ts ← POST /privy/server-wallet        |           |
|                               (RWA Gateway - provisions      |           |
|                                Privy wallet per recipient)   |           |
|        |                                                     |           |
|        +-------------- Instruxi Enforcer -------------------+           |
|                  (register · profile · groups · authorize)              |
|                                                                         |
+-----------------------------------+-------------------------------------+
                                    | emit RequestSent
                                    v
+-------------------------------------------------------------------------+
|                          ONCHAIN LAYER                                  |
|                                                                         |
|   ReliefTreasury.sol (implements IReceiver)                             |
|   +--------------------------------------------------------------------+|
|   |  Pipeline 1: registerEvent() -> requestEventVerification()         ||
|   |  Pipeline 2: requestEligibilityRegistration(addrs[], tiers[])      ||
|   |  Claim:      claimDisbursement() -> reads _eligible -> transfer    ||
|   |  Invariants: caps · no-double-pay · eligibility gate               ||
|   +--------------------------------------------------------------------+|
|          | RequestSent event              ^ onReport(metadata, report)  |
+----------+--------------------------------+-----------------------------++
           |                                |
           v                                |
+--------------------------------------------------------------------------+
|                      CHAINLINK CRE WORKFLOW                              |
|                                                                          |
|  workflow/main.ts  ── EVM Log Trigger on RequestSent                     |
|  workflow/logCallback.ts                                                 |
|                                                                          |
|  requestType = "event_verification"   requestType = "eligibility_registration"
|         |                                    |                           |
|         v                                    v                           |
|  USGS + GDACS + NASA EONET        For each candidate wallet:             |
|  (2-of-3 consensus on real        POST /enforcer/auth/authorize (OPA)   |
|   live disaster databases)        Only approved wallets → onReport      |
|         |                                    |                           |
|         +── onReport(0x01 + encode(requestId, verified)) ──────────────+|
|              onReport(0x02 + encode(requestId, addrs[], tiers[]))        |
|                                                                          |
|         +──── POST /api/webhooks/cre (RWA Gateway) ──────────────+     |
+--------------------------------------------------------------------------+
                                                                    |
                                                                    v
                                                      RWA Gateway webhook
                                                      → TrustSync attestation
                                                      (auto on every fulfillment)
```

---

## CRE Pipelines

Four CRE EVM Log Triggers on a single workflow (`workflow/main.ts`):

| Pipeline | `--trigger-index` | Trigger Event | Handler | Onchain Write |
|----------|:-----------------:|---------------|---------|:-------------:|
| 1 - Event Verification | 0 | `RequestSent(requestType="event_verification")` | 2-of-3 consensus: USGS + GDACS + EONET | `onReport(0x01 + encode(requestId, verified))` |
| 2 - Eligibility Registration | 0 | `RequestSent(requestType="eligibility_registration")` | OPA batch validation per wallet | `onReport(0x02 + encode(requestId, addrs[], tiers[]))` |
| 3 - Proof-of-Disbursement | 1 | `Disbursed(eventId, recipient, amount)` | TrustSync attestation create + publish | None (offchain side-effect) |
| 4 - Proof-of-Funds | 2 | `Deposited(depositor, amount)` | TrustSync attestation create + publish | None (offchain side-effect) |

### Report format

- `onReport` entry point is the standard Chainlink CRE `IReceiver` interface
- `report[0]` = prefix byte routing: `0x01` = event verification, `0x02` = eligibility
- `0x01` payload: `abi.encode(bytes32 requestId, bool verified)` - contract auto-activates on `verified=true`
- `0x02` payload: `abi.encode(bytes32 requestId, address[] approvedRecipients, uint8[] tiers)`
- **Forwarder address (Sepolia):** `0x15fc6ae953e024d975e77382eeec56a9101f9f88`

### Disaster Verification - Real Live Data

Pipeline 1 queries three real public APIs. No hardcoded values. CRE runs this inside the Chainlink DON:

| Source | API | What it checks |
|--------|-----|----------------|
| **USGS** | `earthquake.usgs.gov/fdsnws/event/1/query` | Looks up a specific earthquake by USGS event ID. Requires `usgsId` in `externalRef`. Confirms it is reviewed and above the minimum magnitude threshold. |
| **GDACS** | `gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Red` | Queries GDACS global red-alert disaster database. Match by specific `gdacsId`, or by `region` (ISO alpha-3), or any active red alert if no filter is provided. |
| **NASA EONET** | `eonet.gsfc.nasa.gov/api/v3/events?status=open` | Queries NASA Earth Observatory open natural events. Confirms ongoing natural disaster activity. |

The `externalRef` JSON passed to `requestEventVerification` controls how specific the check is:

```jsonc
// Match a specific GDACS event (most precise):
{"gdacsId": "1474477", "region": "MMR"}

// Match any active disaster in a country:
{"region": "BGD"}

// No filter - confirms global disaster activity (for testing only):
{}
```

Find real GDACS event IDs at [gdacs.org](https://www.gdacs.org) → click any red alert → copy the `eventid` from the URL. For earthquakes, find USGS event IDs at [earthquake.usgs.gov/earthquakes/search](https://earthquake.usgs.gov/earthquakes/search/).

---

## Design Decisions

### CRE as the Onchain Eligibility Writer

No one except the Chainlink Forwarder (controlled by the DON running the CRE workflow) can write eligibility state to the contract.

The admin provides a candidate wallet batch by calling `requestEligibilityRegistration(eventId, addresses[], tiers[])`. This emits `RequestSent`. CRE picks it up, runs each wallet through the OPA policy (`POST /enforcer/auth/authorize`), and writes back only approved recipients via `onReport(0x02 + abi.encode(requestId, approvedAddrs[], tiers[]))`. The contract stores `_eligible[eventId][addr] = tier` for each approved recipient.

Recipients call `claimDisbursement(eventId)`. The contract checks `_eligible[eventId][msg.sender]` onchain and pays. No CRE round-trip at claim time. Eligibility is a permanent onchain fact.

**Known limitation:** The contract trusts the CRE/Enforcer pipeline for eligibility. A compromised Instruxi API could approve an ineligible recipient. Cap checks and the double-payment guard limit blast radius.

**V2:** Merkle root committed onchain at `anchorRoster` time. Recipient submits a Merkle proof at claim time. Eligibility verified entirely onchain with no offchain trust.

### CRE Auto-Activates Events

When CRE returns `verified=true` (2-of-3 consensus), `_handleEventVerification` transitions the event from `Pending` directly to `Active` in a single transaction. Both `EventVerified` and `EventActivated` are emitted in the same tx. There is no separate manual activation step. The admin cannot intercept that transition.

### Eligibility Is Write-Once

Once CRE writes a tier assignment for a recipient, subsequent CRE batches cannot overwrite it. First-write-wins prevents a second batch from downgrading or revoking a tier already committed onchain.

### Per-Event Claim Window

Each event has a claim window set at registration (`claimWindowDays`, 1 to 365). When CRE activates the event, `claimDeadline` is stamped as `block.timestamp + claimWindowSeconds`. An admin cannot close an Active event before that deadline.

### Eligibility Is Private; The Gate Is Onchain

Recipient wallet-to-eligibility mappings are personally identifiable data. Instruxi Enforcer keeps that mapping encrypted and access-controlled. What _is_ onchain: `EligibilitySet(eventId, recipient, tier)` events, written by CRE. The full roster CSV is never onchain. The SHA-256 of the roster CSV is anchored via `anchorRoster()` - anyone can hash the original file and compare.

### OPA Policy Inside the DON

The OPA policy check runs inside the Chainlink DON as part of the CRE `eligibility_registration` workflow. 5xx responses throw so the DON retries rather than writing a permanent partial denial. Only a definitive `200 { allow: false }` is treated as a policy denial for a specific wallet.

### Disbursement is Synchronous

Because eligibility is written onchain by CRE before any recipient claims, `claimDisbursement` is a simple synchronous check-and-transfer. No async CRE request/callback cycle at claim time. No poison-pill reverts, no pending request spam, no permanent denial from transient API errors at claim time.

### OPA `policyId` - Staging vs Production

`workflow/config.staging.json` has a `policyId` field in the `instruxi` object. When this is empty, Pipeline 2 skips OPA and approves all candidate wallets submitted by the admin. This is intentional for staging (you may not have a real Rego policy written yet). For production, populate `policyId` with your configured Instruxi OPA policy ID - only then does CRE enforce policy-gated eligibility.

> **Security:** Deploying to production with an empty `policyId` means eligibility is entirely admin-controlled. Set a real policy ID before going live.

### Workflow ID Pinning (Optional Production Hardening)

The contract has a `setExpectedWorkflowId(bytes32)` function (admin-only). When set to a non-zero value, `onReport()` reads the first 32 bytes of the CRE `metadata` parameter and verifies they match the expected workflow ID. This rejects any `onReport` call that didn't originate from your specific CRE workflow. Disabled by default (`bytes32(0)`). To enable, call it after you have a stable deployed workflow ID from the CRE CLI.

### `injectEligibility.ts` - Admin Testing Bypass

`scripts/injectEligibility.ts` is an admin helper for testing the claim flow without running the full CRE simulation. It:
1. Calls `requestEligibilityRegistration(eventId, [recipient], [tier])` to get a `requestId`
2. Temporarily grants the deployer the fulfiller role via `setFulfillerAuthorization`
3. Encodes and calls `onReport` directly with a `0x02` prefix eligibility payload
4. Revokes fulfiller authorization

This bypasses CRE Pipelines 1 and 2 entirely. Use it to make a test wallet (e.g. MetaMask) eligible without waiting for CRE simulation. **Never use in production.** Production eligibility must come from the CRE DON via `authorizedFulfillers[chainlinkForwarder]`.

```bash
npx ts-node --project tsconfig.json scripts/injectEligibility.ts \
  --event-id 0x<EVENT_ID_BYTES32> \
  --recipient 0x<WALLET_ADDRESS> \
  --tier 1
```

### Event ID Encoding

The `register-event` Hardhat task and the `requestEventVerification` task both accept a human-readable string (e.g. `"MMR-EQ-2025-M77"`) and hash it with `keccak256(toUtf8Bytes(str))` to produce a `bytes32`. The frontend does the same. Always pass the raw string consistently - if you paste a raw `0x` bytes32 anywhere, ensure it came from the same keccak256 hash (not a raw UTF-8 encoding).

### CRE WASM Runtime Constraints

The CRE workflow runs inside a Javy WASM sandbox. Browser/Node.js globals are not available:
- **`btoa` is not available.** `logCallback.ts` includes a `toBase64()` helper that uses `TextEncoder` + `hexToBase64` from the CRE SDK instead. If you add new HTTP calls that need base64 encoding, use `toBase64()`.
- **`fetch` is not available.** Use `cre.capabilities.HTTPClient.sendRequest()`.
- **`setTimeout`/`setInterval` are not available.** All I/O must be synchronous.

### Attestation Nonce Format

Pipelines 3 and 4 encode the recipient/depositor address inside the EIP-712 attestation nonce:
- Pipeline 3 (disbursement): `cre-disbursement-0x{address}-{timestamp}`
- Pipeline 4 (deposit): `cre-deposit-0x{address}-{timestamp}`

`scripts/queryAttestations.ts` extracts the account by regex-matching `/(0x[0-9a-fA-F]{40})/` on the nonce. If you change the nonce format in `logCallback.ts`, update `queryAttestations.ts` to match.

### Instruxi API - User IDs vs Wallet Addresses

The Instruxi Enforcer API uses two distinct identifier types. **They are not interchangeable:**
- **Wallet address** (`0x...`): used for registration (`POST /auth/register`) and OPA checks
- **UUID user ID**: returned from registration, required for group operations (`POST /admin/groups/{gid}/users/{uid}`)

To get the UUID for a wallet address: `GET /admin/users/resolve?account_address=0x...`. All group-assignment operations in `processRoster.ts` and `setupGroups.ts` go through this resolution step.

---

## Participants

| Role | Who | What they control |
|------|-----|-------------------|
| Admin | Funding organization or charity | Deploys contract, registers events, anchors rosters, submits eligibility batches, manages treasury |
| Partner | Aid organization or data collector | Uploads recipient CSV rosters to Object Storage |
| CRE (Chainlink DON) | Chainlink Forwarder (automated) | Verifies disaster events against live data, validates recipient eligibility via OPA, writes onchain |
| Recipient | Disaster-affected individual | Claims disbursement from the frontend after CRE writes eligibility |

The admin cannot approve recipients directly or bypass OPA. They set tier amounts at event registration - those amounts are locked and cannot be changed.

---

## Onchain Invariants

Enforced by `ReliefTreasury.sol` regardless of what the CRE workflow sends:

| Invariant | Check |
|-----------|-------|
| Event must be Active | `ev.status == EventStatus.Active` |
| CRE-written eligibility required | `_eligible[eventId][recipient] > 0` - reverts `NotEligible` |
| Eligibility is write-once | First-write-wins; subsequent CRE batches cannot overwrite |
| No double payment | `_claimed[eventId][recipient] == false` |
| Tier must be configured | `_eventTierAmounts[eventId][tier] > 0` |
| Per-event cap | `ev.totalDisbursed + amount <= ev.perEventCap` |
| Program cap | `totalDisbursed + amount <= programCap` |
| Treasury balance | `usdc.balanceOf(address(this)) >= amount` |
| Claim window before close | `closeEvent` reverts `ClaimWindowNotExpired` until `block.timestamp >= claimDeadline` |
| No eligibility after close | `requestEligibilityRegistration` reverts on Closed events |

---

## Known Limitations

| Limitation | Impact | V2 Path |
|---|---|---|
| Eligibility trust | `_eligible` trusts CRE/Enforcer OPA pipeline | Onchain Merkle proof at claim time |
| Eligibility batch size | Large rosters hit calldata/gas limits | Split batches; CRE multi-call pattern |
| Single admin key | One compromised key can drain treasury | Gnosis Safe + TimelockController |
| Raw CSV hashing | Hash differs across OS line endings | Canonical normalization before SHA-256 |
| No `EventStatus.Rejected` | Failed verification leaves event in `Pending`; admin closes manually | `Rejected` status + `EventRejected` event |
| Sequential `processRoster` | Large rosters require sequential processing | Worker queue + batch API endpoints |
| Privy embedded wallet signing | Email/Google login users cannot sign claim transactions until the Privy app's recovery method is configured in the Privy dashboard | See below |

### Privy Embedded Wallet - Recovery Method Required

Recipients who sign in with **email or Google** get a Privy embedded wallet. Privy's embedded wallets use a 2-of-3 threshold key system. To sign a transaction, Privy must reconstruct the key using a recovery share. **Until the Privy app is configured with a recovery method, signing fails with "Recovery method not supported" and recipients cannot claim.**

**Fix (app owner):** Log into [privy.io/dashboard](https://privy.io/dashboard) → select this app → **Embedded Wallets → Recovery → enable "Privy-managed recovery"**. With Privy-managed recovery, Privy holds the recovery share server-side - no user action required. All email/Google users can then sign transactions immediately.

**Workaround (testing without dashboard access):** Have testers sign in using **Connect Wallet → MetaMask** instead of email/Google. MetaMask handles signing directly and has no recovery method dependency. To register a MetaMask address as eligible, run:

```bash
npx ts-node --project tsconfig.json scripts/injectEligibility.ts --event-id 0x<EVENT_ID> --recipient 0x<METAMASK_ADDRESS> --tier 1
```

This script is an admin-only helper that bypasses CRE and writes eligibility directly onchain. It is not a substitute for the full CRE pipeline in production.

---

## What's Onchain vs. Offchain

| Onchain (Transparent, Immutable) | Offchain (Private, Policy-Gated) |
|----------------------------------|----------------------------------|
| USDC treasury balance | Recipient identity (Enforcer profiles) |
| Event verification fulfillment tx + result | Roster CSV (encrypted Object Storage) |
| `EligibilitySet(eventId, recipient, tier)` events | Full roster data + wallet-PII mapping |
| Disbursement transactions | OPA Rego policy decisions |
| TrustSync attestations | Phone/email → wallet mapping (Privy) |
| Per-event tier amounts (locked at registration) | API credentials (CRE secrets vault) |
| Roster SHA-256 hashes (`RosterAnchored` events) | |
| Cap enforcement + double-payment guard | |

---

## Security

### Enforced Onchain (Cannot Be Bypassed by Any Offchain Component)

| Guard | Mechanism |
|---|---|
| No payout unless event is Active | `ev.status == EventStatus.Active` checked before every transfer |
| No payout without CRE-written eligibility | `_eligible[eventId][recipient] > 0` - set exclusively by Chainlink Forwarder |
| Eligibility cannot be revised | First-write-wins guard |
| Auto-activation only via CRE | No manual `activateEvent`; CRE controls `Pending → Active` |
| Claim window before close | Admin cannot close Active event before registered claim window |
| No double payment | `_claimed[eventId][recipient]` write-once flag |
| Per-event + program caps | Both checked before every transfer |
| Reentrancy | `nonReentrant` on all state-changing external functions |
| Fulfiller whitelist | Only `authorizedFulfillers` addresses can call `onReport()` |
| CEI pattern | All state mutations precede `safeTransfer` |

### Trust Chain

```
ReliefTreasury.sol
  └── authorizedFulfillers (Chainlink Forwarder)
        └── Chainlink DON
              └── CRE workflow (logCallback.ts)
                    ├── USGS / GDACS / NASA EONET (event verification)
                    └── Instruxi API - OPA policy (eligibility)
```

---

## Repository Structure

```
instruxi-disaster-relief/
│
├── contracts/
│   ├── ReliefTreasury.sol          # USDC treasury + IReceiver callbacks + invariants
│   └── interfaces/
│       ├── IReceiver.sol           # Standard Chainlink CRE receiver interface
│       ├── IReliefTreasury.sol     # Events, errors, function signatures
│       └── mocks/MockUSDC.sol      # 6-decimal ERC20 for local testing
│
├── workflow/                       # Chainlink CRE workflow (TypeScript + Bun)
│   ├── main.ts                     # Entry point - four EVM Log Trigger registrations
│   ├── logCallback.ts              # All four pipeline handlers
│   ├── workflow.yaml               # CRE CLI config (staging + production targets)
│   ├── config.staging.json         # Staging runtime config
│   ├── config.production.json      # Production config template
│   └── package.json
│
├── scripts/                        # Instruxi API integration
│   ├── instruxi.ts                 # Typed client - Enforcer + RWA Gateway endpoints
│   ├── setupGroups.ts              # Create Enforcer group hierarchy (run once per program)
│   ├── onboardRecipient.ts         # Register → profile → groups (single recipient)
│   ├── uploadRoster.ts             # Upload CSV to Instruxi Object Storage
│   ├── processRoster.ts            # Ingest roster → provision wallets → archive
│   ├── createAttestation.ts        # Manual attestation (auditor-signed batch)
│   ├── queryAttestations.ts        # Query public TrustSync attestations
│   └── injectEligibility.ts        # Admin bypass - write eligibility onchain without CRE (testing only)
│
├── deploy/
│   ├── 000_deploy_mocks.ts         # MockUSDC (localhost only)
│   └── 001_deploy_relief_treasury.ts
│
├── tasks/
│   └── relief-tasks.ts             # Hardhat tasks (all operational commands)
│
├── test/
│   └── ReliefTreasury.test.ts      # 39 tests - full contract coverage
│
├── rosters/
│   └── sample-roster.csv
│
├── project.yaml                    # CRE CLI project settings (RPC endpoints)
├── secrets.yaml                    # CRE secrets mapping (never commit - see .gitignore)
├── .env.example
└── DEPLOYMENT.md                   # Step-by-step setup and execution guide
```

---

## Chainlink Files

| File | Description |
|------|-------------|
| [`workflow/main.ts`](workflow/main.ts) | CRE workflow entry point - four EVM Log Trigger registrations |
| [`workflow/logCallback.ts`](workflow/logCallback.ts) | All pipeline handlers: 2-of-3 disaster API consensus, OPA eligibility batch, TrustSync attestations |
| [`workflow/workflow.yaml`](workflow/workflow.yaml) | CRE CLI settings (staging + production targets) |
| [`workflow/config.staging.json`](workflow/config.staging.json) | Staging runtime config - Sepolia, chain selector, gas limit, Instruxi URLs |
| [`contracts/interfaces/IReceiver.sol`](contracts/interfaces/IReceiver.sol) | Standard Chainlink CRE receiver interface - `onReport()` entry point |
| [`contracts/ReliefTreasury.sol`](contracts/ReliefTreasury.sol) | Main contract - implements `IReceiver`, routes `onReport()` via prefix byte |
| [`contracts/interfaces/IReliefTreasury.sol`](contracts/interfaces/IReliefTreasury.sol) | Interface - all events, errors, and function signatures |
| [`deploy/001_deploy_relief_treasury.ts`](deploy/001_deploy_relief_treasury.ts) | Deploy script - deploys treasury and authorizes Chainlink Forwarder |
| [`tasks/relief-tasks.ts`](tasks/relief-tasks.ts) | Hardhat tasks - `request-verification` and `request-eligibility` emit `RequestSent` to trigger CRE |

---

## Smart Contract Development

```bash
npm install
npx hardhat compile
npx hardhat test              # 39 tests
npx hardhat deploy --network sepolia
```

> **Hardhat auto-loads `.env`:** `hardhat.config.ts` uses `import "dotenv/config"`, so all tasks read `.env` automatically. No need to prefix commands with env vars.

### Hardhat Tasks

| Task | Description |
|------|-------------|
| `register-event` | Register a disaster event and lock per-tier payout amounts. Accepts event name string (hashed to `bytes32` with `keccak256`) or raw `0x` bytes32. |
| `request-verification` | Emit `RequestSent(event_verification)` - triggers CRE Pipeline 1. |
| `request-eligibility` | Submit candidate batch - emits `RequestSent(eligibility_registration)` to trigger CRE Pipeline 2. |
| `claim-disbursement` | Claim from deployer wallet (or any wallet whose private key is in `DEPLOYER_PRIVATE_KEY`). Checks eligibility before attempting. |
| `anchor-roster` | Anchor SHA-256 of the recipient CSV onchain. Anyone can re-hash the file and verify integrity. |
| `deposit-usdc` | Approve + deposit USDC into the treasury. |
| `treasury-status` | Print treasury balances and optional per-event status. |

> **There is no `activate-event` task.** Events transition from `Pending` to `Active` automatically inside `onReport()` when CRE Pipeline 1 returns `verified=true`. Both `EventVerified` and `EventActivated` are emitted in the same transaction. There is no manual activation step.

---

## Environment Variables

> **JWT expiry:** `INSTRUXI_ADMIN_JWT` and `RWA_GATEWAY_JWT` are Privy session tokens that **expire after 1 hour**. Any time a script returns a `401`, refresh the token: open your Privy-connected app in a browser, open DevTools → Application → Local Storage, copy the `privy:token` value, and update both JWT vars in `.env`. Scripts that run longer than 1 hour (large rosters) will need a fresh token mid-run.

> **`CRE_ETH_PRIVATE_KEY` requires the `0x` prefix.** The CRE CLI validates key format strictly. Copy `DEPLOYER_PRIVATE_KEY` exactly including the `0x` prefix.

```bash
# Deployment
DEPLOYER_PRIVATE_KEY=0x...
CRE_ETH_PRIVATE_KEY=0x...          # Same key with 0x prefix - used by CRE CLI
ALCHEMY_API_KEY=
ETHERSCAN_API_KEY=

# ReliefTreasury constructor params
USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
PROGRAM_CAP=1000000000000           # $1,000,000 USDC (6 decimals)
ADMIN_ADDRESS=                      # Leave blank to use deployer address
CHAINLINK_FORWARDER_ADDRESS=0x15fc6ae953e024d975e77382eeec56a9101f9f88

# Instruxi API
INSTRUXI_BASE_URL=https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer
INSTRUXI_API_KEY=
INSTRUXI_ADMIN_JWT=                 # Privy JWT - expires every hour, refresh from browser
INSTRUXI_TENANT_ID=

# RWA Gateway
RWA_GATEWAY_URL=https://rwa-gateway-staging.instruxi.dev
RWA_GATEWAY_JWT=                    # Same Privy JWT as INSTRUXI_ADMIN_JWT

# Deployed contract (fill after deploy)
RELIEF_TREASURY_ADDRESS=
```

---

## Roster CSV Format

| Column | Description |
|--------|-------------|
| `phone_or_ref` | Phone number or external reference ID |
| `email` | **Primary identifier** - wallet is provisioned from this via RWA Gateway + Privy |
| `regionId` | Region code matching an `Eligible:Program:Region` group |
| `eligibilityStatus` | `eligible` \| `ineligible` \| `pending` |
| `payoutTier` | `standard` \| `priority` |
| `first_name` | Optional |
| `last_name` | Optional |

No wallet address is needed in the CSV. `processRoster` calls `POST /api/privy/server-wallet/create-user` on the RWA Gateway for each eligible row, which provisions a Privy-backed wallet and returns the address. When the recipient later logs in via Privy with their email, Privy restores the pre-provisioned wallet - the same address already registered onchain.

---

## Deployed Contracts (Sepolia)

| Item | Address |
|------|---------|
| ReliefTreasury | `0x5e588C93FAcb105fCf8b391D534D61064236EbC7` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Chainlink Forwarder | `0x15fc6ae953e024d975e77382eeec56a9101f9f88` |

---

## License

MIT
