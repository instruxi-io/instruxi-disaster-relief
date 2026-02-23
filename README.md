# CRE-Orchestrated Disaster Relief Distribution

A Chainlink CRE (Compute Runtime Environment) hackathon project that automates disaster-relief USDC disbursements using onchain invariant enforcement, 2-of-3 oracle consensus, and Instruxi Enforcer identity verification.

---

## Overview

`ReliefTreasury` is a Solidity smart contract that holds USDC and disburses it to verified disaster victims via a pull model. No funds move without two independent checks:

1. **Event Pipeline** — CRE queries USGS Earthquake, GDACS, and ReliefWeb (2-of-3 rule) to confirm a disaster event is real before marking it `Active`.
2. **Eligibility Pipeline** — When a recipient claims, CRE queries the [Instruxi Enforcer](https://instruxi.io) API to confirm the wallet is in an eligible group before releasing funds.

All monetary invariants (no double-pay, per-event cap, program cap, eligibility mapping) are enforced **onchain**. The CRE workflow cannot bypass them.

---

## Architecture

```
Admin                     Recipient
  │                           │
  ▼                           ▼
registerEvent()         claimDisbursement()
  │                           │
  ├─ requestEventVerification() ──► emit RequestSent("event_verification", ...)
  │                           │
  │                           └──► emit RequestSent("disbursement", ...)
  │                                          │
  └──────────────────────────────────────────┤
                                             ▼
                              Chainlink CRE EVM Log Trigger
                              workflow/main.ts + logCallback.ts
                                             │
                         ┌───────────────────┴──────────────────────┐
                         │  event_verification                       │  disbursement
                         ▼                                           ▼
              USGS + GDACS + ReliefWeb              Instruxi Enforcer
              (2-of-3 consensus)                    GET /admin/groups/account/{addr}/groups
                         │                                           │
                         └────────────────── onReport() ────────────┘
                                                  │
                                            ReliefTreasury
                                         (enforces invariants,
                                          transfers USDC)
```

---

## Chainlink Files

| File | Description |
|------|-------------|
| [`workflow/main.ts`](workflow/main.ts) | CRE workflow entry point — registers the EVM Log Trigger on `RequestSent` events |
| [`workflow/logCallback.ts`](workflow/logCallback.ts) | CRE log handler — decodes event, queries external APIs, calls `onReport()` |
| [`workflow/workflow.yaml`](workflow/workflow.yaml) | CRE CLI settings (staging + production targets) |
| [`workflow/config.staging.json`](workflow/config.staging.json) | Staging config (Sepolia, gas limit, Instruxi base URL) |
| [`contracts/utils/ChainlinkCREClient.sol`](contracts/utils/ChainlinkCREClient.sol) | Abstract base — `_sendRequest()` / `_validateAndFulfillRequest()` / `_fulfillRequest()` pattern |
| [`contracts/ReliefTreasury.sol`](contracts/ReliefTreasury.sol) | Main contract — inherits `ChainlinkCREClient`, implements `onReport()` |

### CRE Integration Details

- **Trigger**: EVM Log Trigger on `RequestSent(bytes32 requestId, address requester, string requestType, bytes requestData)` emitted by `ReliefTreasury`
- **Callback**: CRE Forwarder calls `onReport(bytes metadata, bytes report)` on the contract
- **Report encoding**: `report[0]` = prefix byte (`0x01` = event verification, `0x02` = disbursement); `report[1:]` = `abi.encode(bytes32 requestId, bool result)`
- **Forwarder address** (Sepolia): `0x15fc6ae953e024d975e77382eeec56a9101f9f88`

---

## Contracts

```
contracts/
├── ReliefTreasury.sol          # Main treasury contract
├── interfaces/
│   └── IReliefTreasury.sol     # Interface (events, errors, functions)
├── mocks/
│   └── MockUSDC.sol            # 6-decimal ERC20 for local testing
└── utils/
    └── ChainlinkCREClient.sol  # CRE request/response base contract
```

### Key Functions

| Function | Access | Description |
|----------|--------|-------------|
| `registerEvent(bytes32, uint256)` | `DEFAULT_ADMIN_ROLE` | Register a disaster event |
| `requestEventVerification(bytes32, string)` | `DEFAULT_ADMIN_ROLE` | Emit `RequestSent` for CRE to verify via USGS/GDACS/ReliefWeb |
| `activateEvent(bytes32)` | `DEFAULT_ADMIN_ROLE` | Activate a CRE-verified event |
| `batchSetEligibility(bytes32, address[], bool)` | authorized fulfiller | Set recipient eligibility |
| `claimDisbursement(bytes32)` | recipient | Emit `RequestSent` for CRE to check Instruxi Enforcer |
| `onReport(bytes, bytes)` | authorized fulfiller (CRE Forwarder) | CRE write-back entry point |
| `fulfillRequest(bytes32, bytes)` | authorized fulfiller | Direct fulfillment (testing/non-Forwarder) |

### Event Status Flow

```
Unregistered → Pending → Verified → Active → Closed
                  ↑          ↑          ↑
           registerEvent  CRE verifies  activateEvent
```

---

## CRE Workflow

The workflow lives in the `workflow/` directory and is built with `@chainlink/cre-sdk`.

### Setup

```bash
cd workflow
bun install    # or npm install
```

### Configuration

Edit `workflow/config.staging.json`:
```json
{
  "reliefTreasuryAddress": "0x<DEPLOYED_CONTRACT>",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "gasLimit": "500000",
  "instruxi": {
    "baseUrl": "https://api.instruxi.io",
    "eligibilityGroupPrefix": "Eligible:"
  }
}
```

Create `secrets.yaml` (not committed):
```yaml
INSTRUXI_API_KEY: "<your-key>"
```

### Simulate

After deploying the contract and sending a `RequestSent` transaction:

```bash
cre workflow simulate disaster-relief-workflow \
  --non-interactive \
  --trigger-index 0 \
  --evm-tx-hash <TX_HASH_CONTAINING_REQUEST_SENT> \
  --evm-event-index 0 \
  --target staging-settings
```

### External Data Sources

| Source | API | Request Type |
|--------|-----|--------------|
| [USGS Earthquake Catalog](https://earthquake.usgs.gov/fdsnws/event/1/) | `GET /query?format=geojson&eventid={id}` | `event_verification` |
| [GDACS](https://www.gdacs.org/gdacsapi/api/events/) | `GET /geteventlist/SEARCH?alertlevel=Red` | `event_verification` |
| [ReliefWeb](https://api.reliefweb.int/v1/disasters) | `GET /disasters?appname=instruxi-disaster-relief` | `event_verification` |
| [Instruxi Enforcer](https://instruxi.io) | `GET /admin/groups/account/{address}/groups` | `disbursement` |

Verification requires **2-of-3** sources to confirm.

---

## Smart Contract Development

### Prerequisites

- Node.js 20+
- `npm install` in the project root

### Commands

```bash
# Compile
npx hardhat compile

# Test (29 tests)
npx hardhat test

# Deploy to local node
npx hardhat node
npx hardhat deploy --network localhost

# Deploy to Sepolia
PRIVATE_KEY=... ALCHEMY_API_KEY=... ADMIN_ADDRESS=... \
  CHAINLINK_FORWARDER_ADDRESS=0x15fc6ae953e024d975e77382eeec56a9101f9f88 \
  npx hardhat deploy --network sepolia
```

### Environment Variables

Copy `.env.example` to `.env`:

```
ALCHEMY_API_KEY=
PRIVATE_KEY=
ADMIN_ADDRESS=
USDC_ADDRESS=
PER_RECIPIENT_CAP=50000000
PROGRAM_CAP=1000000000000
CHAINLINK_FORWARDER_ADDRESS=0x15fc6ae953e024d975e77382eeec56a9101f9f88
```

---

## Onchain Invariants

The contract enforces these invariants regardless of what the CRE workflow sends:

- No payout unless `EventStatus == Active`
- No payout if recipient has already claimed (`_claimed[eventId][recipient]`)
- Recipient must be in `_eligibility[eventId][recipient]` mapping
- Payout amount cannot exceed `perRecipientCap`
- Cumulative event payout cannot exceed `perEventCap`
- Cumulative program payout cannot exceed `programCap`
- Treasury must hold sufficient USDC balance

---

## Security

- `ReentrancyGuard` on all state-changing external functions
- `Pausable` for emergency stop
- `AccessControl` with `DEFAULT_ADMIN_ROLE`, `DEPOSITOR_ROLE`, `PAUSER_ROLE`
- `authorizedFulfillers` mapping — only the Chainlink Forwarder (and admin-added addresses) can call `onReport()` or `fulfillRequest()`
- CEI pattern: all state mutations happen before `safeTransfer`

---

## License

MIT
