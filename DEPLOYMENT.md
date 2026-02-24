# Deployment Guide — Instruxi Disaster Relief

Step-by-step checklist to go from zero to a live Sepolia deployment with CRE simulation evidence.

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

Open `workflow/config.staging.json` and replace the placeholder:

```json
{
  "reliefTreasuryAddress": "0x<YOUR_DEPLOYED_ADDRESS>",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "gasLimit": "500000",
  "instruxi": {
    "baseUrl": "https://api.instruxi.io",
    "eligibilityGroupPrefix": "Eligible:",
    "rwGatewayUrl": "https://gateway.instruxi.io"
  }
}
```

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
```

---

## Step 6 — Register a Disaster Event + Emit RequestSent

You need a real `RequestSent` transaction to feed into the CRE simulation.

First, compute the event ID. Use any unique string:
```bash
# With cast (Foundry):
cast keccak "US-FLOOD-2026-001"
# → 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477
```

```bash
# Register the event
npx hardhat register-event --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
  --cap 5000000000

# Request verification — this emits RequestSent (SAVE THIS TX HASH)
#
# --ref is a JSON object passed to the CRE workflow. The workflow calls three real
# public APIs (USGS, GDACS, ReliefWeb) and uses a 2-of-3 consensus rule.
#
# Option A — simplest, gets verified=true in almost any real-world condition:
#   USGS skips (no usgsId), GDACS returns true (active global red alerts), ReliefWeb returns true
npx hardhat request-verification --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477 \
  --ref '{}'
#
# Option B — more realistic demo, uses a real USGS earthquake event ID:
#   Find one at https://earthquake.usgs.gov/earthquakes/search/
#   e.g. us7000n7c5 is a recent reviewed earthquake
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

**Save the group IDs printed** — you need them for roster processing.

---

## Step 9 — Upload and Process Recipient Roster

```bash
# Upload CSV to Instruxi Object Storage
npm run upload-roster -- \
  --file rosters/sample-roster.csv \
  --program US-FLOOD-2026 \
  --region US-CA

# Process roster: download → validate → onboard → archive
npm run process-roster -- \
  --file-id <FILE_ID_FROM_UPLOAD> \
  --program US-FLOOD-2026 \
  --region US-CA \
  --eligible-group-ids <GROUP_IDS_FROM_STEP_8>
```

---

## Step 10 — Activate Event

After CRE verifies the event (status becomes `Verified`):

```bash
npx hardhat activate-event --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --eventid 0xfe3dfcfbd3a3040c4882787cfb0471a41ce91cc9e728b73d68b1b44ae8789477
```

---

## Step 11 — Proof-of-Funds Attestation

After depositing USDC into the treasury:

```bash
# First deposit USDC
npx hardhat deposit-usdc --network sepolia \
  --contract 0x<CONTRACT_ADDRESS> \
  --usdc 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  --amount 1000000000

# Create proof-of-funds attestation
npm run attest -- proof-of-funds \
  --treasury 0x<CONTRACT_ADDRESS> \
  --usdc 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  --balance 1000000000 \
  --chain-id 11155111 \
  --account 0x<ADMIN_ADDRESS>
```

---

## Step 12 — Demo Video Checklist

Record a walkthrough covering:
- [ ] Deployed contract on Sepolia Etherscan
- [ ] CRE simulation terminal output
- [ ] `npm run setup-groups` running
- [ ] `npm run upload-roster` + `process-roster` running
- [ ] `claimDisbursement` → CRE callback → USDC transfer on Etherscan
- [ ] TrustSync attestation visible in Instruxi dashboard

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
