# Deployment Guide — Instruxi Disaster Relief

Step-by-step checklist to go from zero to a live Sepolia deployment with CRE simulation evidence.

> **Deployment scope:** This guide targets a Sepolia testnet deployment with a single admin wallet. These are intentional scope decisions — the contract architecture is fully compatible with a Gnosis Safe + TimelockController without code changes. See [Design Decisions](README.md#design-decisions) and [Known Limitations](README.md#known-limitations) in the README for the rationale and production upgrade path for each choice.
>
> **Four CRE pipelines:** This deployment runs four CRE triggers on a single workflow:
> - Pipeline 1 (`--trigger-index 0`): `RequestSent(event_verification)` → USGS/GDACS/ReliefWeb 2-of-3 → `onReport(0x01)`
> - Pipeline 2 (`--trigger-index 0`): `RequestSent(eligibility_registration)` → OPA batch validation → `onReport(0x02)`
> - Pipeline 3 (`--trigger-index 1`): `Disbursed` → proof-of-disbursement TrustSync attestation (no onchain write)
> - Pipeline 4 (`--trigger-index 2`): `Deposited` → proof-of-funds TrustSync attestation (no onchain write)
>
> Pipelines 3 and 4 fire automatically on every disbursement and deposit — no manual `npm run attest` needed.

---

## Pre-flight Checklist

Gather every credential before starting. Everything below blocks on this.

| Credential | Where to get it | `.env` variable |
|---|---|---|
| Deployer wallet private key | Any EVM wallet (MetaMask, cast wallet) | `DEPLOYER_PRIVATE_KEY` |
| Sepolia ETH (≥ 0.1 ETH) | [Alchemy Faucet](https://sepoliafaucet.com) or Google "Sepolia faucet" | — |
| Alchemy API key | [alchemy.com](https://alchemy.com) → Apps → Create → Sepolia | `ALCHEMY_API_KEY` |
| Etherscan API key | [etherscan.io](https://etherscan.io) → Account → API Keys | `ETHERSCAN_API_KEY` |
| Instruxi API key | Instruxi dashboard | `INSTRUXI_API_KEY` |
| Instruxi Admin JWT | `POST /enforcer/auth/authenticate-siwe` with admin wallet | `INSTRUXI_ADMIN_JWT` |
| Instruxi Tenant ID | Instruxi dashboard | `INSTRUXI_TENANT_ID` |
| RWA Gateway JWT | Instruxi dashboard or Instruxi team | `RWA_GATEWAY_JWT` |

---

## Step 1 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in every value. Key ones to pay attention to:

```bash
# Deployer
DEPLOYER_PRIVATE_KEY=0x<YOUR_KEY>
ALCHEMY_API_KEY=<YOUR_KEY>
ETHERSCAN_API_KEY=<YOUR_KEY>

# USDC on Sepolia — Circle's official testnet USDC
USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238

# Caps (defaults are fine for testnet)
PER_RECIPIENT_CAP=50000000        # $50 USDC (6 decimals)
PROGRAM_CAP=1000000000000         # $1,000,000 USDC

# Admin (leave blank to use deployer address)
ADMIN_ADDRESS=

# Chainlink Forwarder — Sepolia CRE forwarder address
CHAINLINK_FORWARDER_ADDRESS=0x15fc6ae953e024d975e77382eeec56a9101f9f88
```

> **Note on USDC:** `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` is the Circle USDC contract on
> Sepolia. You can get test USDC from the [Circle faucet](https://faucet.circle.com) or Aave testnet.

---

## Step 2 — Deploy the Contract

```bash
npm install
npx hardhat deploy --network sepolia
```

Expected output:
```
🏦  Deploying ReliefTreasury...
Using USDC at: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
Per-recipient cap: $50 USDC
Program cap:       $1000000 USDC
Admin:             0x<YOUR_ADDRESS>
✅ ReliefTreasury deployed at: 0x<CONTRACT_ADDRESS>
🔗  Authorizing Chainlink Forwarder: 0x15fc6ae953e024d975e77382eeec56a9101f9f88
✅  Forwarder authorized
```

**Save the `ReliefTreasury` address — you'll need it everywhere below.**

---

## Step 3 — Update Workflow Config

Open `workflow/config.staging.json` and fill in all placeholders:

```json
{
  "reliefTreasuryAddress": "0x<YOUR_DEPLOYED_ADDRESS>",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "gasLimit": "500000",
  "usdcAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "chainId": 11155111,
  "instruxi": {
    "baseUrl": "https://api.instruxi.io",
    "eligibilityGroupPrefix": "Eligible:",
    "rwGatewayUrl": "https://gateway.instruxi.io",
    "policyId": "<YOUR_INSTRUXI_POLICY_ID>"
  }
}
```

`policyId` is your Instruxi OPA policy ID for the `claim_disbursement` action. The CRE workflow calls `POST /enforcer/auth/authorize` with this policy before processing any disbursement.

`usdcAddress` and `chainId` are used by Pipelines 3 and 4 when creating TrustSync attestations for each `Disbursed` and `Deposited` event.

---

## Step 4 — Verify on Etherscan (recommended for judges)

Constructor arg order matches `ReliefTreasury.sol`: `(_usdc, _perRecipientCap, _programCap, admin)`

```bash
npx hardhat verify --network sepolia \
  0x<CONTRACT_ADDRESS> \
  0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  50000000 \
  1000000000000 \
  0x<ADMIN_ADDRESS>
```

---

## Step 5 — Set Up CRE Secrets

```bash
cp secrets.yaml.example secrets.yaml
```

Fill in `secrets.yaml` (one level above `workflow/` — **never commit this file**):

```yaml
INSTRUXI_API_KEY: "your-instruxi-api-key"
RWA_GATEWAY_JWT: "your-gateway-jwt"
INSTRUXI_ADMIN_JWT: "your-instruxi-admin-jwt"
```

`INSTRUXI_ADMIN_JWT` is used by Pipelines 3 and 4 (`onDisbursed` / `onDeposited`) to call `POST /rwa/attestation/create` and `POST /rwa/attestation/publish`. Obtain it via `POST /enforcer/auth/authenticate-siwe` with your admin wallet.

---

## Step 6 — Register a Disaster Event + Emit RequestSent

You need a real `RequestSent` transaction to feed into the CRE simulation.

First, compute the event ID. Use any unique string:
```bash
# With cast (Foundry):
cast keccak "US-FLOOD-2026-001"
# → 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477
```

> **Admin role note:** For this hackathon, Instruxi is the admin. In production this should be the charity or funding organisation's wallet — the entity responsible for setting tier amounts and accountable for the disbursement commitments.

```bash
# Register the event and atomically commit per-tier payout amounts.
# Amounts are LOCKED at registration — they cannot be changed after this call.
# Tier 1 = standard $50 USDC, Tier 2 = priority $100 USDC.
npx hardhat register-event --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
  --cap 5000000000 \
  --tiers 1,2 \
  --amounts 50000000,100000000

# Request verification — this emits RequestSent (SAVE THIS TX HASH)
#
# --ref is a JSON object passed to the CRE workflow. The workflow calls three real
# public APIs (USGS, GDACS, ReliefWeb) and uses a 2-of-3 consensus rule.
#
# IMPORTANT: always use a specific usgsId, gdacsId, or region in production.
# An empty ref may pass verification via unrelated global disaster activity
# (GDACS returns true for any active red alert worldwide). Only use '{}' for testing.
#
# Option A — simplest test, verified=true when any red alert is active globally:
npx hardhat request-verification --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
  --ref '{}'
#
# Option B — production use, specific USGS earthquake event:
#   Find event IDs at https://earthquake.usgs.gov/earthquakes/search/
# npx hardhat request-verification --network sepolia \
#   --contract 0x<CONTRACT_ADDRESS> \
#   --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
#   --ref '{"usgsId":"us7000n7c5","region":"US","minMagnitude":4.5}'
```

The second command prints the tx hash. **Save it — it goes into the CRE simulation.**

---

## Step 7 — Run CRE Simulation

Requires [Bun](https://bun.sh) (`brew install bun` or `curl -fsSL https://bun.sh/install | bash`).

```bash
cd workflow
bun install

cre workflow simulate disaster-relief-workflow \
  --non-interactive \
  --trigger-index 0 \
  --evm-tx-hash 0x<TX_HASH_FROM_STEP_6> \
  --evm-event-index 0 \
  --target staging-settings
```

**Save the full console output.** Chainlink hackathon requires evidence the CRE workflow executed.

---

## Step 8 — Set Up Instruxi Groups

```bash
npm run setup-groups -- --program US-FLOOD-2026 --regions "US-CA,US-TX,US-FL"
```

This creates groups with tier suffixes:
- `Eligible:US-FLOOD-2026:US-CA:1` (standard payout)
- `Eligible:US-FLOOD-2026:US-CA:2` (priority payout)
- (and similarly for each region)

**Save the group IDs printed** — you need them for roster processing.

---

## Step 9 — Upload and Process Recipient Roster

```bash
# Upload CSV to Instruxi Object Storage
npm run upload-roster -- \
  --file rosters/sample-roster.csv \
  --program US-FLOOD-2026 \
  --region US-CA

# Process roster: download → validate → assign tier groups → archive
# --tier-group-ids maps tier number to Instruxi group ID (from Step 8)
npm run process-roster -- \
  --file-id <FILE_ID_FROM_UPLOAD> \
  --program US-FLOOD-2026 \
  --region US-CA \
  --tier-group-ids '{"1":"<GROUP_ID_STANDARD>","2":"<GROUP_ID_PRIORITY>"}'
# "standard" CSV rows → tier 1 group, "priority" CSV rows → tier 2 group
```

---

## Step 9b — Anchor the Roster Hash Onchain

After processing each roster, anchor its SHA-256 hash onchain so anyone can verify that tier assignments were not changed after the fact.

```bash
# Compute SHA-256 of the original CSV file
sha256sum rosters/sample-roster.csv
# → abc123...  rosters/sample-roster.csv

# Convert to bytes32 hex (prepend 0x) and anchor onchain
npx hardhat anchor-roster --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --rosterhash 0x<SHA256_HEX> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
  --program US-FLOOD-2026 \
  --region US-CA
```

This emits `RosterAnchored(rosterHash, eventId, program, region)` onchain. Anyone can SHA-256 the original CSV and compare to this event to verify the integrity of tier assignments.

---

## Step 10 — Activate Event

After CRE verifies the event (status becomes `Verified`):

```bash
npx hardhat activate-event --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477
```

---

## Step 10b — CRE Pipeline 2: Register Eligibility Onchain

After activating the event, submit the eligible wallets (from processRoster output) to CRE for OPA validation. CRE validates each wallet and writes `_eligible[eventId][addr] = tier` onchain.

```bash
# Submit candidate eligibility batch to CRE
# --recipients is a comma-separated list of wallet addresses from processRoster output
# --tiers is the corresponding tier for each wallet (1=standard, 2=priority)
npx hardhat request-eligibility --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
  --recipients "0xAddr1,0xAddr2,0xAddr3" \
  --tiers "1,1,2"
```

This emits `RequestSent("eligibility_registration", ...)` → CRE picks it up → validates each wallet via OPA → writes back `onReport(0x02 + encode(requestId, approvedAddrs[], tiers[]))` → `EligibilitySet(eventId, recipient, tier)` emitted for each approved wallet.

**Save the CRE simulation output for this step** — it shows the eligibility pipeline running and the onchain write. Judges can verify `EligibilitySet` events on Etherscan.

---

## Step 11 — Deposit USDC

```bash
npx hardhat deposit-usdc --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --usdc 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  --amount 1000000000
```

**Pipeline 4 fires automatically.** The `Deposited` event triggers the CRE EVM Log Trigger (`--trigger-index 2`), which calls `POST /rwa/attestation/create` + `POST /rwa/attestation/publish` via the Instruxi API. No manual `npm run attest` needed.

To simulate Pipeline 4 against this deposit tx:

```bash
cd workflow
cre workflow simulate disaster-relief-workflow \
  --non-interactive \
  --trigger-index 2 \
  --evm-tx-hash 0x<DEPOSIT_TX_HASH> \
  --evm-event-index 0 \
  --target staging-settings
```

## Step 12 — Claim Disbursement

```bash
npx hardhat claim-disbursement --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477
```

**Pipeline 3 fires automatically.** The `Disbursed` event triggers the CRE EVM Log Trigger (`--trigger-index 1`), which creates and publishes a proof-of-disbursement attestation. No manual `npm run attest` needed.

To simulate Pipeline 3 against a disbursement tx:

```bash
cd workflow
cre workflow simulate disaster-relief-workflow \
  --non-interactive \
  --trigger-index 1 \
  --evm-tx-hash 0x<DISBURSED_TX_HASH> \
  --evm-event-index 0 \
  --target staging-settings
```

To verify attestations were created:

```bash
npm run query-attestations -- --treasury 0x<CONTRACT_ADDRESS>
```

---

## Step 13 — Demo Video Checklist

Record a walkthrough covering:
- [ ] Deployed contract on Sepolia Etherscan
- [ ] CRE Pipeline 1 simulation (`--trigger-index 0`): `event_verification` terminal output (USGS/GDACS/ReliefWeb 2-of-3, `EventVerified` tx on Etherscan)
- [ ] `npm run setup-groups` running (tier-suffixed groups `:1`, `:2`)
- [ ] `npm run upload-roster` + `process-roster` running
- [ ] `anchor-roster` tx visible on Etherscan (`RosterAnchored` event)
- [ ] CRE Pipeline 2 simulation (`--trigger-index 0`): `eligibility_registration` terminal output (`EligibilitySet` events on Etherscan showing CRE wrote the onchain eligibility gate)
- [ ] `deposit-usdc` tx + CRE Pipeline 4 simulation (`--trigger-index 2`): terminal output shows proof-of-funds attestation ID + published status
- [ ] `claimDisbursement` → direct USDC transfer on Etherscan (no CRE round-trip at claim time)
- [ ] CRE Pipeline 3 simulation (`--trigger-index 1`): terminal output shows proof-of-disbursement attestation ID + published status
- [ ] `npm run query-attestations -- --treasury 0x<CONTRACT_ADDRESS>` output shows attestations (replaces "TrustSync attestation visible in dashboard")

---

## Quick Reference

| Item | Value |
|---|---|
| Contract (Sepolia) | `0x<UPDATE_AFTER_DEPLOY>` |
| USDC (Sepolia) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Chainlink Forwarder (Sepolia) | `0x15fc6ae953e024d975e77382eeec56a9101f9f88` |
| CRE Chain Selector | `ethereum-testnet-sepolia` |
| Chain ID | `11155111` |
| GitHub | `https://github.com/instruxi-io/instruxi-disaster-relief` |
