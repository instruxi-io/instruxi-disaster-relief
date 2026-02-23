/**
 * Disaster Relief CRE Workflow — main.ts
 *
 * Listens for RequestSent events from ReliefTreasury and dispatches to the
 * appropriate handler based on requestType:
 *
 *   "event_verification" → queryDisasterAPIs() → onReport(0x01 + payload)
 *   "disbursement"       → checkEnforcerEligibility() → onReport(0x02 + payload)
 *
 * Simulation:
 *   cre workflow simulate disaster-relief-workflow \
 *     --non-interactive \
 *     --trigger-index 0 \
 *     --evm-tx-hash <TX_HASH> \
 *     --evm-event-index 0 \
 *     --target staging-settings
 */

import { cre, Runner, getNetwork } from "@chainlink/cre-sdk";
import { keccak256, toHex } from "viem";
import { onRequestSent } from "./logCallback";

// ── Config type (matches config.staging.json) ─────────────────────────────

export type WorkflowConfig = {
  reliefTreasuryAddress: string;
  chainSelectorName: string;
  gasLimit: string;
  instruxi: {
    baseUrl: string;
    eligibilityGroupPrefix: string;
    rwGatewayUrl: string;   // RWA Gateway base URL for CRE webhook notifications
  };
};

// ── RequestSent event signature (must match ChainlinkCREClient.sol) ────────
// event RequestSent(bytes32 indexed requestId, address indexed requester, string requestType, bytes requestData)
const REQUEST_SENT_SIGNATURE = "RequestSent(bytes32,address,string,bytes)";

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
  ];
};

// ── Entry point ───────────────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(initWorkflow);
}

main();
