/**
 * Disaster Relief CRE Workflow — main.ts
 *
 * Listens for RequestSent, Disbursed, and Deposited events from ReliefTreasury
 * and dispatches to the appropriate handler:
 *
 *   trigger-index 0: RequestSent → "event_verification" → onReport(0x01 + payload)
 *                    RequestSent → "eligibility_registration" → onReport(0x02 + payload)
 *   trigger-index 1: Disbursed → proof-of-disbursement attestation (no onchain write)
 *   trigger-index 2: Deposited → proof-of-funds attestation (no onchain write)
 *
 * Simulation:
 *   cre workflow simulate disaster-relief-workflow \
 *     --non-interactive \
 *     --trigger-index 0 \
 *     --evm-tx-hash <TX_HASH> \
 *     --evm-event-index 0 \
 *     --target staging-settings
 *
 *   cre workflow simulate disaster-relief-workflow \
 *     --non-interactive \
 *     --trigger-index 1 \
 *     --evm-tx-hash <DISBURSED_TX_HASH> \
 *     --evm-event-index 0 \
 *     --target staging-settings
 *
 *   cre workflow simulate disaster-relief-workflow \
 *     --non-interactive \
 *     --trigger-index 2 \
 *     --evm-tx-hash <DEPOSITED_TX_HASH> \
 *     --evm-event-index 0 \
 *     --target staging-settings
 */

import { cre, Runner, getNetwork } from "@chainlink/cre-sdk";
import { keccak256, toHex } from "viem";
import { onRequestSent, onDisbursed, onDeposited } from "./logCallback";

// ── Config type (matches config.staging.json) ─────────────────────────────

export type WorkflowConfig = {
  reliefTreasuryAddress: string;
  chainSelectorName: string;
  gasLimit: string;
  usdcAddress: string;      // USDC contract address (for attestation input)
  chainId: number;          // EVM chain ID (11155111 for Sepolia)
  instruxi: {
    baseUrl: string;
    eligibilityGroupPrefix: string;
    rwGatewayUrl: string;   // RWA Gateway base URL for CRE webhook notifications
    policyId: string;       // OPA policy ID for disbursement authorization
  };
};

// ── Event signatures (must match ReliefTreasury.sol / IReliefTreasury.sol) ─
// event RequestSent(bytes32 indexed requestId, address indexed requester, string requestType, bytes requestData)
const REQUEST_SENT_SIGNATURE = "RequestSent(bytes32,address,string,bytes)";
// event Disbursed(bytes32 indexed eventId, address indexed recipient, uint256 amount)
const DISBURSED_SIGNATURE = "Disbursed(bytes32,address,uint256)";
// event Deposited(address indexed depositor, uint256 amount)
const DEPOSITED_SIGNATURE = "Deposited(address,uint256)";

// ── Workflow initializer ──────────────────────────────────────────────────

const initWorkflow = (config: WorkflowConfig) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });

  if (!network) {
    throw new Error(
      `[DisasterRelief] Unknown CRE network: ${config.chainSelectorName}`
    );
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const requestSentTopic = keccak256(toHex(REQUEST_SENT_SIGNATURE));
  const disbursedTopic   = keccak256(toHex(DISBURSED_SIGNATURE));
  const depositedTopic   = keccak256(toHex(DEPOSITED_SIGNATURE));

  return [
    // EVM Log Trigger: fires on every RequestSent emitted by ReliefTreasury
    cre.handler(
      evmClient.logTrigger({
        addresses: [config.reliefTreasuryAddress],
        topics: [{ values: [requestSentTopic] }],
        confidence: "CONFIDENCE_LEVEL_FINALIZED",
      }),
      onRequestSent
    ),

    // EVM Log Trigger: fires on every Disbursed — creates proof-of-disbursement attestation
    cre.handler(
      evmClient.logTrigger({
        addresses: [config.reliefTreasuryAddress],
        topics: [{ values: [disbursedTopic] }],
        confidence: "CONFIDENCE_LEVEL_FINALIZED",
      }),
      onDisbursed
    ),

    // EVM Log Trigger: fires on every Deposited — creates proof-of-funds attestation
    cre.handler(
      evmClient.logTrigger({
        addresses: [config.reliefTreasuryAddress],
        topics: [{ values: [depositedTopic] }],
        confidence: "CONFIDENCE_LEVEL_FINALIZED",
      }),
      onDeposited
    ),
  ];
};

// ── Entry point ───────────────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(initWorkflow);
}

main();
