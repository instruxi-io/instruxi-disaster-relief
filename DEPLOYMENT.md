# Runbook - End-to-End Setup and Execution

This guide walks a new operator through every step to deploy the platform, run a real disaster event through the CRE verification pipeline, process a recipient roster, and execute a claim - from zero to a fully attested disbursement.

> **What you'll need from Instruxi:** An API key, tenant ID, and access to the RWA Gateway. Contact the Instruxi team if you don't have these.

---

## Prerequisites

### Tools

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| Bun | Latest | `curl -fsSL https://bun.sh/install \| bash` |
| CRE CLI | 1.3.0+ | Download from [Chainlink CRE releases](https://github.com/smartcontractkit/cre-cli/releases) and add to PATH |
| Git | Any | - |

Verify:
```bash
node --version     # v20+
bun --version      # 1.x+
cre version        # 1.3.0+
```

### Accounts and Credentials

Gather everything before starting - each step blocks on having these ready.

| Credential | How to get it | Used in |
|---|---|---|
| **EVM wallet + private key** | MetaMask, cast, or any EVM keygen | `.env` as `DEPLOYER_PRIVATE_KEY` |
| **Sepolia ETH (≥ 0.1)** | [Google Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) or [Alchemy faucet](https://sepoliafaucet.com) | Gas for deployment + transactions |
| **Sepolia USDC** | [Circle testnet faucet](https://faucet.circle.com) - select Sepolia, request USDC | Fund treasury for disbursements |
| **Alchemy API key** | [alchemy.com](https://alchemy.com) → Create App → Ethereum Sepolia | `.env` as `ALCHEMY_API_KEY` |
| **Etherscan API key** | [etherscan.io](https://etherscan.io) → My Account → API Keys | Contract verification (optional but recommended) |
| **Instruxi API key** | Instruxi team | `.env` as `INSTRUXI_API_KEY` |
| **Instruxi Tenant ID** | Instruxi team | `.env` as `INSTRUXI_TENANT_ID` |
| **Instruxi Admin JWT** | Log into your Instruxi-connected app (Privy), copy the JWT from browser DevTools → Application → Local Storage. Expires every hour - refresh before running scripts. | `.env` as `INSTRUXI_ADMIN_JWT` and `RWA_GATEWAY_JWT` |
| **CRE account** | `cre login` (you'll be prompted) | CRE simulation |

---

## Step 1 - Clone and Install

```bash
git clone https://github.com/instruxi-io/instruxi-disaster-relief
cd instruxi-disaster-relief
npm install
```

Install the CRE workflow dependencies (requires Bun):
```bash
cd workflow
bun install      # runs bunx cre-setup internally - downloads Javy runtime
cd ..
```

---

## Step 2 - Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```bash
# ── Deployment ──────────────────────────────────────────────────────
DEPLOYER_PRIVATE_KEY=0x<YOUR_PRIVATE_KEY>
CRE_ETH_PRIVATE_KEY=0x<SAME_KEY_WITH_0x_PREFIX>
ALCHEMY_API_KEY=<YOUR_ALCHEMY_KEY>
ETHERSCAN_API_KEY=<YOUR_ETHERSCAN_KEY>

# ── ReliefTreasury constructor ───────────────────────────────────────
USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
PROGRAM_CAP=1000000000000            # $1,000,000 USDC total cap
ADMIN_ADDRESS=                       # Leave blank to use deployer address
CHAINLINK_FORWARDER_ADDRESS=0x15fc6ae953e024d975e77382eeec56a9101f9f88

# ── Instruxi API ─────────────────────────────────────────────────────
INSTRUXI_BASE_URL=https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer
INSTRUXI_API_KEY=<YOUR_INSTRUXI_API_KEY>
INSTRUXI_ADMIN_JWT=<YOUR_PRIVY_JWT>
INSTRUXI_TENANT_ID=<YOUR_TENANT_ID>

# ── RWA Gateway ──────────────────────────────────────────────────────
RWA_GATEWAY_URL=https://rwa-gateway-staging.instruxi.dev
RWA_GATEWAY_JWT=<SAME_PRIVY_JWT_AS_INSTRUXI_ADMIN_JWT>

# ── Deployed contract (fill in after Step 4) ─────────────────────────
RELIEF_TREASURY_ADDRESS=
```

> **JWT expiry:** `INSTRUXI_ADMIN_JWT` and `RWA_GATEWAY_JWT` are Privy session tokens that expire after 1 hour. Any time you see a 401 error from an Instruxi API call, refresh the token from your browser and update both values in `.env`.

---

## Step 3 - Configure CRE Project Files

The CRE CLI needs two files at the project root (alongside `workflow/`).

### `project.yaml`

Already present. Verify it matches:

```yaml
staging-settings:
  rpcs:
    - chain-name: ethereum-testnet-sepolia
      url: "https://eth-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>"

production-settings:
  rpcs:
    - chain-name: ethereum-testnet-sepolia
      url: "https://eth-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>"
```

### `secrets.yaml`

Already present. Maps CRE secret names to `.env` variable names:

```yaml
secretsNames:
  INSTRUXI_API_KEY:
    - INSTRUXI_API_KEY
  INSTRUXI_ADMIN_JWT:
    - INSTRUXI_ADMIN_JWT
```

> **Never commit `secrets.yaml` or `.env`.** Both are in `.gitignore`.

Log into the CRE CLI if you haven't:
```bash
cre login
```

---

## Step 4 - Deploy the Contract

```bash
npx hardhat deploy --network sepolia
```

Expected output:
```
🏦  Deploying ReliefTreasury...
✅ ReliefTreasury deployed at: 0x<CONTRACT_ADDRESS>
🔗  Authorizing Chainlink Forwarder: 0x15fc6ae953e024d975e77382eeec56a9101f9f88
✅  Forwarder authorized
```

**Update `.env`:**
```bash
RELIEF_TREASURY_ADDRESS=0x<CONTRACT_ADDRESS>
```

**Update `workflow/config.staging.json`:**
```json
{
  "reliefTreasuryAddress": "0x<CONTRACT_ADDRESS>",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "gasLimit": "500000",
  "usdcAddress": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "chainId": 11155111,
  "instruxi": {
    "baseUrl": "https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer",
    "eligibilityGroupPrefix": "Eligible:",
    "rwGatewayUrl": "https://rwa-gateway-staging.instruxi.dev",
    "policyId": "",
    "contractDeploymentId": 0
  }
}
```

Leave `policyId` empty unless you have a configured Instruxi OPA policy. **When empty, all candidates submitted by the admin are approved by CRE - OPA validation is skipped entirely, and eligibility is effectively admin-controlled.** This is acceptable for staging. For production, populate `policyId` with your Instruxi OPA policy ID before going live.

### Register the contract in the RWA Gateway

CRE Pipelines 3 and 4 create TrustSync attestations via the RWA Gateway. The gateway requires both the `ReliefTreasury` and the USDC token to be registered in its contract registry first. Run these two commands, then update `contractDeploymentId` in `workflow/config.staging.json` with the `id` returned from the first call.

```bash
# Register ReliefTreasury - note the "id" in the response
curl -X POST "$RWA_GATEWAY_URL/api/admin/contracts" \
  -H "Authorization: Bearer $RWA_GATEWAY_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "contract_address": "0x<CONTRACT_ADDRESS>",
    "contract_name": "ReliefTreasury",
    "chain_id": 11155111,
    "contract_type": "VAULT",
    "deployer_address": "0x<ADMIN_ADDRESS>",
    "description": "Disaster Relief USDC Treasury",
    "status": "active",
    "source_verified": true,
    "verification_url": "https://sepolia.etherscan.io/address/0x<CONTRACT_ADDRESS>#code"
  }'

# Register Sepolia USDC (required for attestation type "net_asset_value")
curl -X POST "$RWA_GATEWAY_URL/api/admin/contracts" \
  -H "Authorization: Bearer $RWA_GATEWAY_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "contract_address": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    "contract_name": "Sepolia USDC",
    "chain_id": 11155111,
    "contract_type": "ERC20",
    "description": "Circle USDC on Sepolia testnet",
    "status": "active"
  }'
```

Update `workflow/config.staging.json`:
```json
"contractDeploymentId": <id from ReliefTreasury registration response>
```

Optionally verify on Etherscan:
```bash
npx hardhat verify --network sepolia \
  0x<CONTRACT_ADDRESS> \
  0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  1000000000000 \
  0x<ADMIN_ADDRESS>
```

---

## Step 5 - Set Up Instruxi Groups

Create the Enforcer group hierarchy for your program. Groups encode the tier number in their name suffix (`:1` = standard, `:2` = priority).

```bash
npm run setup-groups -- --program MMR-EQ-2025 --regions "MMR-YGN,MMR-MDY"
```

Expected output:
```
✅ Created group: Admins:MMR-EQ-2025          (id: <ADMIN_GROUP_ID>)
✅ Created group: Partners:MMR-EQ-2025        (id: <PARTNER_GROUP_ID>)
✅ Created group: Eligible:MMR-EQ-2025:MMR-YGN:1  (id: <TIER1_YGN_ID>)
✅ Created group: Eligible:MMR-EQ-2025:MMR-YGN:2  (id: <TIER2_YGN_ID>)
✅ Created group: Eligible:MMR-EQ-2025:MMR-MDY:1  (id: <TIER1_MDY_ID>)
✅ Created group: Eligible:MMR-EQ-2025:MMR-MDY:2  (id: <TIER2_MDY_ID>)
```

**Save these group IDs** - you'll need the tier group IDs in Step 9.

---

## Step 6 - Fund the Treasury

Get Circle testnet USDC from the [Circle faucet](https://faucet.circle.com) (select Ethereum Sepolia). Then deposit into the treasury:

```bash
npx hardhat deposit-usdc --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --usdc 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
  --amount 10000000000
# 10000000000 = $10,000 USDC (6 decimals)
```

> **Note:** `hardhat.config.ts` uses `import "dotenv/config"`, so Hardhat automatically loads your `.env` before any task runs. No need to prefix commands with env vars - just ensure `.env` is populated.

**Save the deposit transaction hash** - you'll need it for CRE Pipeline 4 (proof-of-funds attestation) in Step 14.

---

## Step 7 - Choose a Real Disaster Event

For the demo to meaningfully verify against real live data, use an actual disaster event that appears in the GDACS red-alert database.

### How to find a GDACS event ID

1. Go to [gdacs.org](https://www.gdacs.org)
2. Click any red alert event
3. The URL will contain `eventid=XXXXXXX` - that number is your `gdacsId`
4. Click **Details** on the event page to confirm the event type and affected country

### Current example - Myanmar M7.7 Earthquake

| Field | Value |
|-------|-------|
| Event name | Earthquake in Myanmar |
| GDACS event ID | `1474477` |
| Date | March 28, 2025 |
| Magnitude | M7.7 (Depth: 10km) |
| Countries | Myanmar |
| ISO3 | `MMR` |
| GDACS report | https://www.gdacs.org/report.aspx?eventid=1474477&eventtype=EQ |

This event is confirmed in the GDACS red-alert database and will return a match when the CRE workflow queries GDACS with `gdacsId: "1474477"`.

---

## Step 8 - Register the Event Onchain

Compute the event ID. Use any unique human-readable string - it gets hashed to `bytes32` via `keccak256`. The hardhat tasks, scripts, and frontend all use the same keccak256 hash, so you can pass the human-readable string anywhere and it will resolve to the same onchain ID.

```bash
# With Node:
node -e "const {ethers}=require('ethers'); console.log(ethers.keccak256(ethers.toUtf8Bytes('MMR-EQ-2025-M77')))"
# → 0x<EVENT_ID>
```

Register the event and lock per-tier payout amounts atomically. **Tier amounts cannot be changed after this call.**

```bash
npx hardhat register-event --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --eventid "MMR-EQ-2025-M77" \
  --cap 5000000000 \
  --tiers 1,2 \
  --amounts 50000000,100000000 \
  --claimwindow 90
# cap: $5,000 per-event max
# tier 1 (standard): $50 USDC per recipient
# tier 2 (priority): $100 USDC per recipient
# claimwindow: 90 days after CRE activates the event
```

Expected output:
```
Registering event 0x<EVENT_ID>:
  Per-event cap:  $5000 USDC
  Claim window:   90 days from activation
  Tier 1: $50 USDC
  Tier 2: $100 USDC
✅ Event registered. Tx: 0x<TX_HASH>
```

---

## Step 9 - CRE Pipeline 1: Verify the Disaster Event

Request verification. The `--ref` JSON is passed to the CRE workflow and used to query the external APIs:

```bash
npx hardhat request-verification --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --eventid "MMR-EQ-2025-M77" \
  --ref '{"gdacsId":"1474477","region":"MMR"}'
```

Expected output:
```
Requesting verification for event 0x<EVENT_ID>...
✅ Verification requested.
   requestId: 0x<REQUEST_ID>
   Tx: 0x<TX_HASH>
```

**Save the `Tx:` hash** - it goes into the CRE simulation.

### Run CRE Pipeline 1 Simulation

```bash
cre workflow simulate workflow \
  --trigger-index 0 \
  --evm-tx-hash 0x<TX_HASH_FROM_ABOVE> \
  --evm-event-index 0 \
  --broadcast \
  --non-interactive \
  --target staging-settings \
  -R .
```

Expected logs:
```
[USGS] No usgsId provided - skipping
[GDACS] GET https://www.gdacs.org/gdacsapi/...
[GDACS] Event 1474477 found: true
[EONET] GET https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=5
[EONET] 5 open natural event(s) → true
[Consensus] USGS=false GDACS=true EONET=true → 2/3
[Result] verified=true
[Write] ✓ tx=0x<ONCHAIN_TX>
```

> **2-of-3 achieved:** GDACS confirmed the specific Myanmar earthquake. EONET confirmed ongoing global natural events. The contract auto-transitions the event from `Pending` to `Active` in the same transaction.

Verify the event is now Active:
```bash
npx hardhat treasury-status --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --eventid "MMR-EQ-2025-M77"
# Expected: Status: Active
```

---

## Step 10 - Upload and Process Recipient Roster

### Prepare the CSV

Edit `rosters/sample-roster.csv` to reflect your actual recipients:

```csv
phone_or_ref,email,regionId,eligibilityStatus,payoutTier,first_name,last_name
+9519100001,victim1@example.com,MMR-YGN,eligible,standard,Aung,Myint
+9519100002,victim2@example.com,MMR-YGN,eligible,priority,Su,Kyi
+9519100003,victim3@example.com,MMR-MDY,eligible,standard,Kyaw,Zin
+9519100004,victim4@example.com,MMR-YGN,ineligible,none,Htun,Oo
```

> **Email must be real and deliverable.** The RWA Gateway provisions a Privy embedded wallet tied to this email address. When the recipient later logs in with this email via your frontend, Privy restores their pre-provisioned wallet - the exact address already registered onchain.

### Upload to Object Storage

```bash
npm run upload-roster -- \
  --file rosters/sample-roster.csv \
  --program MMR-EQ-2025 \
  --region MMR-YGN
```

Expected:
```
✅ Uploaded: object_key=MMR-EQ-2025/MMR-YGN/sample-roster.csv
```

**Save the `object_key`.**

### Process the Roster

```bash
npm run process-roster -- \
  --object-key "MMR-EQ-2025/MMR-YGN/sample-roster.csv" \
  --program MMR-EQ-2025 \
  --region MMR-YGN \
  --tier-group-ids '{"1":"<TIER1_GROUP_ID>","2":"<TIER2_GROUP_ID>"}'
```

For each eligible row, `processRoster`:
1. Calls `POST /api/privy/server-wallet/create-user` on the RWA Gateway → provisions a Privy-backed wallet, gets the wallet address back
2. Assigns the user to the appropriate Enforcer tier group
3. Collects all wallet addresses and their tiers

Expected:
```
Processing row 1: victim1@example.com
  [privy] ✓ did: did:privy:...  address: 0xAbCd...
  [group] ✓ assigned to tier 1 group
Processing row 2: victim2@example.com
  [privy] ✓ did: did:privy:...  address: 0xEfGh...
  [group] ✓ assigned to tier 2 group
...
✅ Processed 3 eligible recipients
Eligible wallets:  0xAbCd..., 0xEfGh..., 0xIjKl...
Tiers:             1, 2, 1
```

**Save the wallet addresses and tiers** - they go into Step 11.

### Anchor the Roster Hash Onchain

Compute the SHA-256 of the CSV file and anchor it onchain so anyone can verify tier assignments were not changed after processing:

```bash
# On Linux/Mac:
sha256sum rosters/sample-roster.csv
# → abc123def456...  rosters/sample-roster.csv

# On Windows (PowerShell):
# (Get-FileHash rosters/sample-roster.csv -Algorithm SHA256).Hash.ToLower()

npx hardhat anchor-roster --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --rosterhash 0x<SHA256_HEX> \
  --eventid "MMR-EQ-2025-M77" \
  --program MMR-EQ-2025 \
  --region MMR-YGN
```

This emits `RosterAnchored(rosterHash, eventId, program, region)` onchain. Anyone can SHA-256 the original CSV and compare to verify integrity.

---

## Step 11 - CRE Pipeline 2: Register Eligibility Onchain

Submit the eligible wallet addresses (from `processRoster` output) to CRE for OPA validation. CRE validates each wallet and writes `_eligible[eventId][addr] = tier` onchain.

```bash
npx hardhat request-eligibility --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --eventid "MMR-EQ-2025-M77" \
  --recipients "0xAbCd...,0xEfGh...,0xIjKl..." \
  --tiers "1,2,1"
```

Expected:
```
✅ Eligibility registration requested. CRE will validate via OPA and write onchain.
   requestId: 0x<REQUEST_ID>
   Tx: 0x<TX_HASH>
```

**Save the `Tx:` hash.**

### Run CRE Pipeline 2 Simulation

```bash
cre workflow simulate workflow \
  --trigger-index 0 \
  --evm-tx-hash 0x<TX_HASH_FROM_ABOVE> \
  --evm-event-index 0 \
  --broadcast \
  --non-interactive \
  --target staging-settings \
  -R .
```

Expected logs:
```
[Step 1] eventId=0x... candidates=3
[Step 2] OPA-validating 3 candidates...
[Result] approved=3/3
[Write] ✓ tx=0x<ONCHAIN_TX>
```

The contract emits `EligibilitySet(eventId, recipient, tier)` for each approved wallet. Verify on Etherscan - look for these events on your contract.

Verify eligibility for a specific address:
```bash
node -e "
const {ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/<KEY>');
const c=new ethers.Contract('$RELIEF_TREASURY_ADDRESS', ['function getEligibilityTier(bytes32,address) view returns (uint8)'], p);
c.getEligibilityTier(ethers.keccak256(ethers.toUtf8Bytes('MMR-EQ-2025-M77')),'0xAbCd...').then(t=>console.log('tier:',Number(t)));
"
```

---

## Step 12 - Claim Disbursement

Recipients claim via the frontend (Privy login → SIWE → `claimDisbursement` contract call). For direct testing, use the Hardhat task with the eligible wallet's private key.

```bash
DEPLOYER_PRIVATE_KEY=<RECIPIENT_PRIVATE_KEY> \
npx hardhat claim-disbursement --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --eventid "MMR-EQ-2025-M77"
```

Expected:
```
Claiming disbursement for event 0x... (tier 1)...
✅ Disbursement complete: $50 USDC transferred.
   Tx: 0x<TX_HASH>
```

**Save the `Tx:` hash** - it goes into the Pipeline 3 simulation.

### Frontend Claim - Privy Embedded Wallet Limitation

> **Important:** The frontend uses Privy embedded wallets (provisioned server-side via `processRoster`). Privy embedded wallets use a 2-of-3 threshold key system - signing requires a recovery method to be configured. If recovery is **not** set up in your Privy dashboard, the claim button will show a loading spinner that never resolves, and the browser console will log `"Recovery method not supported"`.
>
> **Fix (dashboard):** Log in to [privy.io/dashboard](https://privy.io/dashboard) → your app → **Embedded Wallets** → **Recovery** → enable **Privy-managed recovery**. Recipients must then complete recovery setup on first login.
>
> **Testing workaround (no dashboard access):** Use MetaMask as a non-provisioned test wallet:
> 1. Connect MetaMask (or any injected wallet) via the "Connect Wallet" button on the frontend - this logs in without creating a Privy embedded wallet
> 2. The wallet's address won't be in the eligible set from `processRoster`. Use `injectEligibility.ts` to write eligibility directly onchain for this address:
>
> ```bash
> npx ts-node --project tsconfig.json scripts/injectEligibility.ts \
>   --event-id 0x<EVENT_ID_BYTES32> \
>   --recipient 0x<METAMASK_ADDRESS> \
>   --tier 1
> ```
>
> This bypasses CRE Pipeline 2 by calling `requestEligibilityRegistration`, temporarily authorizing the deployer as a fulfiller, calling `onReport` directly with the eligibility payload, then revoking the authorization. Only use this for testing - production eligibility must go through CRE Pipeline 2.

### Configure the Frontend

Before using the frontend, set up its environment:

```bash
cp frontend/.env.example frontend/.env
```

Open `frontend/.env` and fill in all values:

```bash
# From privy.io/dashboard (or ask the Instruxi team for the shared app ID)
VITE_PRIVY_APP_ID=your_privy_app_id

# Instruxi enforcer URL (usually left as-is)
VITE_ENFORCER_URL=https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer

# From Step 4 deployment output
VITE_TREASURY_ADDRESS=0x<CONTRACT_ADDRESS>

# Alchemy Sepolia RPC - use this instead of public endpoints (more reliable)
VITE_SEPOLIA_RPC=https://eth-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>

# Optional: pre-fill event ID in the UI (bytes32 hex from Step 8)
VITE_DEFAULT_EVENT_ID=0x<EVENT_ID>
```

Start the frontend:

```bash
cd frontend
npm install
npm run dev
# Runs at http://localhost:5173
```

---

## Step 13 - CRE Pipeline 3: Proof-of-Disbursement Attestation

This runs automatically on the DON in production. For the simulation, trigger it against the disbursement transaction:

```bash
cre workflow simulate workflow \
  --trigger-index 1 \
  --evm-tx-hash 0x<CLAIM_TX_HASH> \
  --evm-event-index 1 \
  --broadcast \
  --non-interactive \
  --target staging-settings \
  -R .
```

> **`--evm-event-index 1`:** The claim transaction emits a USDC `Transfer` event first (index 0), then the `Disbursed` event (index 1). Pipeline 3 listens for `Disbursed` - use index 1, not 0.

Expected logs:
```
[Attestation] Creating proof-of-disbursement...
[Attestation] ✓ id=<ATTESTATION_ID>
[Attestation] Publishing...
[Attestation] ✓ published
```

---

## Step 14 - CRE Pipeline 4: Proof-of-Funds Attestation

Trigger against the deposit transaction from Step 6 (save that tx hash when you fund the treasury):

```bash
cre workflow simulate workflow \
  --trigger-index 2 \
  --evm-tx-hash 0x<DEPOSIT_TX_HASH> \
  --evm-event-index 0 \
  --broadcast \
  --non-interactive \
  --target staging-settings \
  -R .
```

---

## Step 15 - Query Attestations

Verify all attestations were created and published:

```bash
npm run query-attestations -- --treasury $RELIEF_TREASURY_ADDRESS
```

Expected (one block per attestation):
```
Querying TrustSync attestations for treasury: 0x<CONTRACT>
────────────────────────────────────────────────────────────────────────
Found 2 attestation(s):

  ID:          42
  Type:        proof-of-disbursement
  Account:     0xAbCd...
  Amount:      50.000000 USDC
  Active:      true
  Public:      true
  Chain ID:    11155111
  Created:     2025-03-28T12:00:00.000Z
  ────────────────────────────────────────────────────────────────────────
  ID:          41
  Type:        proof-of-funds
  Account:     0x<DEPLOYER>
  Amount:      10000.000000 USDC
  Active:      true
  Public:      true
  Chain ID:    11155111
  Created:     2025-03-28T11:00:00.000Z
  ────────────────────────────────────────────────────────────────────────
```

---

## Step 16 - Check Final Treasury Status

```bash
npx hardhat treasury-status --network sepolia \
  --contract $RELIEF_TREASURY_ADDRESS \
  --eventid "MMR-EQ-2025-M77"
```

Expected:
```
==================================================
ReliefTreasury Status
==================================================
Available Funds:   $9950 USDC
Total Deposited:   $10000 USDC
Total Disbursed:   $50 USDC
──────────────────────────────────────────────────
Event 0x...
  Status:          Active
  Per-event cap:   $5000
  Disbursed:       $50
  Tier amounts:
    Tier 1: $50 USDC
    Tier 2: $100 USDC
==================================================
```

---

## Troubleshooting

### "Must be authenticated!" from Hardhat tasks

`hardhat.config.ts` uses `import "dotenv/config"` and automatically loads `.env` before any task runs. If you see an authentication error, verify that:
1. Your `.env` file exists and contains `DEPLOYER_PRIVATE_KEY` and `ALCHEMY_API_KEY`
2. You are in the project root (not `workflow/` or `frontend/`) when running `npx hardhat` commands

### Privy claim: "Recovery method not supported" / claim button stuck

Privy embedded wallets require a recovery method to sign transactions. If recovery was never configured in your Privy dashboard, the claim button will spin indefinitely and the console will show `"Recovery method not supported"`.

**Dashboard fix:** Log in to [privy.io/dashboard](https://privy.io/dashboard) → your app → **Embedded Wallets** → **Recovery** → enable **Privy-managed recovery**.

**Testing workaround:** Use MetaMask (click "Connect Wallet" on the frontend) instead of the Privy embedded wallet. Then use `injectEligibility.ts` to make the MetaMask address eligible - see Step 12 for the full command.

> **Why this happens:** The `processRoster` script provisions Privy server-side wallets tied to recipient emails. These are embedded wallets - they don't have a recovery shard set up until the user completes recovery setup on first login. The "Connect Wallet" path uses an injected wallet (MetaMask/Rabby) which signs normally.

### JWT expired (401 from Instruxi API)

`INSTRUXI_ADMIN_JWT` and `RWA_GATEWAY_JWT` are Privy session tokens - they expire after 1 hour. Refresh by:
1. Opening your Instruxi-connected app in a browser
2. Logging in (or refreshing the page to get a new token)
3. Opening DevTools → Application → Local Storage → find the `privy:token` entry
4. Updating both JWT values in `.env`

### `cre workflow simulate` hangs on trigger selection

Add `--non-interactive` to the command. Without it, the CLI shows an interactive prompt that can't be dismissed from a non-TTY.

### CRE `--evm-event-index` required error

When running with `--non-interactive`, both `--evm-tx-hash` and `--evm-event-index` are required for EVM triggers. The correct index depends on the pipeline:

| Pipeline | Trigger | Event index |
|---|---|---|
| Pipeline 1 (event verification) | `RequestSent` | 0 |
| Pipeline 2 (eligibility registration) | `RequestSent` | 0 |
| Pipeline 3 (proof-of-disbursement) | `Disbursed` | **1** (USDC Transfer is index 0) |
| Pipeline 4 (proof-of-funds) | `Deposited` | 0 |

### GDACS event not found

The GDACS red-alert list returns the most recent 20 red-alert events. If the event you're using has aged out of the top 20, use a more recent event from [gdacs.org](https://www.gdacs.org). The `--region` filter alone (without `gdacsId`) will match any currently active event in that country.

### processRoster: "no wallet in response"

The RWA Gateway uses Privy to provision wallets. If an email address is not real or Privy cannot create a wallet for it (e.g., disposable email domains), the wallet provisioning step will fail. Use real, deliverable email addresses for recipient onboarding.

### Event status shows "Pending" after CRE simulation

Check the simulation output for `verified=false`. This means fewer than 2 of the 3 APIs confirmed the event:
- **GDACS not matching:** Verify your `gdacsId` appears at gdacs.org/default.aspx. Try `"region": "MMR"` without `gdacsId` to match any active event in the country.
- **EONET returning 0:** Rare; retry. NASA EONET occasionally has maintenance windows.
Each `requestEventVerification` call creates a new `requestId` - you can call it multiple times until you get a `verified=true` result.

---

## Demo Checklist

For recording a demo video:

- [ ] Contract visible on [Sepolia Etherscan](https://sepolia.etherscan.io)
- [ ] Pipeline 1 simulation output showing real GDACS event match + `verified=true`
- [ ] `EventVerified` + `EventActivated` transactions visible on Etherscan (same tx)
- [ ] `processRoster` output showing wallet provisioning per recipient
- [ ] `RosterAnchored` event on Etherscan (anyone can verify CSV integrity)
- [ ] Pipeline 2 simulation output showing OPA validation + `EligibilitySet` events on Etherscan
- [ ] `claimDisbursement` transaction - direct USDC transfer visible on Etherscan (no CRE at claim time)
- [ ] Pipeline 3 simulation output showing proof-of-disbursement attestation ID
- [ ] Pipeline 4 simulation output showing proof-of-funds attestation ID
- [ ] `npm run query-attestations` output listing all published attestations

---

## Quick Reference

| Item | Value |
|---|---|
| USDC (Sepolia) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Chainlink Forwarder (Sepolia) | `0x15fc6ae953e024d975e77382eeec56a9101f9f88` |
| CRE Chain selector name | `ethereum-testnet-sepolia` |
| Chain ID | `11155111` |
| GDACS Red Alerts | https://www.gdacs.org |
| USGS Earthquake Search | https://earthquake.usgs.gov/earthquakes/search/ |
| NASA EONET | https://eonet.gsfc.nasa.gov |
| Circle USDC Faucet | https://faucet.circle.com |
| Sepolia ETH Faucet | https://cloud.google.com/application/web3/faucet/ethereum/sepolia |
