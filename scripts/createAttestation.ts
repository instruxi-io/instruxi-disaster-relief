/**
 * createAttestation.ts — Phase 7: TrustSync Transparency
 *
 * Creates TrustSync attestations via the RWA Gateway (rwa-gateway.instruxi.dev).
 *
 * Prerequisites (obtain from Instruxi dashboard / manager):
 *   1. INSTRUXI_ADMIN_JWT — Bearer token for rwa-gateway authentication
 *   2. RWA_GATEWAY_URL   — https://rwa-gateway.instruxi.dev
 *   3. contract_deployment_id — ID of ReliefTreasury in the RWA gateway contract registry
 *   4. EIP-712 nonce — GET /api/attestations/nonce before each attestation
 *   5. EIP-712 signature — signed by the admin wallet over the attestation data + nonce
 *
 * Usage — proof of funds:
 *   npx ts-node scripts/createAttestation.ts proof-of-funds \
 *     --treasury 0xReliefTreasury \
 *     --usdc 0xUSDC \
 *     --balance 50000000000 \
 *     --chain-id 11155111 \
 *     --contract-deployment-id <id> \
 *     --nonce <uuid> \
 *     --signature 0x...
 *
 * Required env vars:
 *   RWA_GATEWAY_URL, INSTRUXI_ADMIN_JWT
 */

import "dotenv/config";
import {
  createAttestation,
  publishAttestation,
  type CreateAttestationInput,
} from "./instruxi";

// ── Proof of Funds ────────────────────────────────────────────────────────

export interface ProofOfFundsInput {
  accountAddress: string;         // Admin/treasury operator address
  treasuryAddress: string;        // ReliefTreasury contract address
  usdcAddress: string;            // USDC token contract address
  balanceRaw: number;             // Raw USDC balance (6 decimals, e.g. 50000000000 = $50,000)
  chainId: number;
  contractDeploymentId: number;   // RWA Gateway contract deployment ID
  nonce: string;                  // Server nonce from GET /api/attestations/nonce
  signature: string;              // EIP-712 signature from admin wallet
}

export interface ProofOfFundsResult {
  attestationId: string | number;
  balance: number;
  published: boolean;
}

/**
 * Create and publish a proof-of-funds attestation for the current treasury balance.
 * Called after deposits or on a schedule to keep donor-facing data current.
 */
export async function proofOfFunds(
  input: ProofOfFundsInput
): Promise<ProofOfFundsResult> {
  console.log(`\n[proof-of-funds] Treasury: ${input.treasuryAddress}`);
  console.log(`[proof-of-funds] Balance: ${input.balanceRaw / 1e6} USDC`);

  const attestationData = JSON.stringify({
    chain_id: input.chainId,
    contract_address: input.treasuryAddress,
    nav_contract_address: input.usdcAddress,
    decimals: 6,
    amount: String(input.balanceRaw),
    valid_from: new Date().toISOString(),
    valid_to: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const attestationInput: CreateAttestationInput = {
    contract_deployment_id: input.contractDeploymentId,
    attestation_type: "net_asset_value",
    attestor_name: "Instruxi Relief Treasury",
    attestor_wallet_address: input.accountAddress,
    attestation_data: attestationData,
    nonce: input.nonce,
    signature: input.signature,
    active: true,
  };

  const createRes = await createAttestation(attestationInput);
  const attestationId = createRes.data?.id ?? "";
  if (!attestationId) throw new Error("createAttestation returned no id");
  console.log(`[proof-of-funds] ✓ Created attestation id=${attestationId}`);

  await publishAttestation(attestationId);
  console.log(`[proof-of-funds] ✓ Published`);

  return { attestationId, balance: input.balanceRaw, published: true };
}

// ── Proof of Disbursement ─────────────────────────────────────────────────

export interface DisbursementRecord {
  recipient: string;       // Wallet address
  amount: number;          // USDC amount (6 decimals)
  txHash: string;          // Onchain disbursement tx hash
  eventId: string;         // Relief event ID (bytes32 hex)
}

export interface ProofOfDisbursementInput {
  accountAddress: string;
  treasuryAddress: string;
  usdcAddress: string;
  chainId: number;
  disbursements: DisbursementRecord[];
  contractDeploymentId: number;
  nonce: string;
  signature: string;
}

export interface ProofOfDisbursementResult {
  attestationIds: (string | number)[];
  totalAmount: number;
}

/**
 * Create proof-of-disbursement attestations (one per disbursement).
 * Note: batch grouping is handled within the RWA Gateway; individual
 * attestations are created here with proof_of_reserve type.
 */
export async function proofOfDisbursement(
  input: ProofOfDisbursementInput
): Promise<ProofOfDisbursementResult> {
  const { disbursements } = input;
  console.log(`\n[proof-of-disbursement] Creating ${disbursements.length} attestations...`);

  const totalAmount = disbursements.reduce((sum, d) => sum + d.amount, 0);
  const attestationIds: (string | number)[] = [];

  for (const d of disbursements) {
    const attestationData = JSON.stringify({
      chain_id: input.chainId,
      contract_address: input.treasuryAddress,
      por_contract_address: input.usdcAddress,
      decimals: 6,
      amount: String(d.amount),
      recipient: d.recipient,
      tx_hash: d.txHash,
      event_id: d.eventId,
      valid_from: new Date().toISOString(),
      valid_to: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const res = await createAttestation({
      contract_deployment_id: input.contractDeploymentId,
      attestation_type: "proof_of_reserve",
      attestor_name: "Instruxi Relief Treasury",
      attestor_wallet_address: input.accountAddress,
      attestation_data: attestationData,
      nonce: input.nonce,
      signature: input.signature,
      active: true,
    });

    const id = res.data?.id ?? "";
    if (!id) throw new Error(`createAttestation returned no id for recipient ${d.recipient}`);
    attestationIds.push(id);
    console.log(`  ✓ ${d.recipient} → $${d.amount / 1e6} USDC (attestation ${id})`);
  }

  console.log(`[proof-of-disbursement] ✓ ${attestationIds.length} attestations created`);
  return { attestationIds, totalAmount };
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = rest;
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  if (command === "proof-of-funds") {
    const treasury    = get("--treasury");
    const usdc        = get("--usdc");
    const balance     = get("--balance");
    const chainId     = get("--chain-id");
    const account     = get("--account");
    const deployId    = get("--contract-deployment-id");
    const nonce       = get("--nonce");
    const signature   = get("--signature");

    if (!treasury || !usdc || !balance || !chainId || !account || !deployId || !nonce || !signature) {
      console.error(
        "Usage: ts-node scripts/createAttestation.ts proof-of-funds \\\n" +
        "  --treasury <0x...> --usdc <0x...> --balance <raw> \\\n" +
        "  --chain-id <int> --account <0x...> \\\n" +
        "  --contract-deployment-id <int> --nonce <uuid> --signature <0x...>"
      );
      process.exit(1);
    }

    const result = await proofOfFunds({
      accountAddress:        account,
      treasuryAddress:       treasury,
      usdcAddress:           usdc,
      balanceRaw:            Number(balance),
      chainId:               Number(chainId),
      contractDeploymentId:  Number(deployId),
      nonce,
      signature,
    });
    console.log("\nResult:", JSON.stringify(result, null, 2));

  } else if (command === "proof-of-disbursement") {
    const treasury         = get("--treasury");
    const usdc             = get("--usdc");
    const chainId          = get("--chain-id");
    const account          = get("--account");
    const deployId         = get("--contract-deployment-id");
    const nonce            = get("--nonce");
    const signature        = get("--signature");
    const disbursementsRaw = get("--disbursements");

    if (!treasury || !usdc || !chainId || !account || !deployId || !nonce || !signature || !disbursementsRaw) {
      console.error(
        "Usage: ts-node scripts/createAttestation.ts proof-of-disbursement \\\n" +
        "  --treasury <0x...> --usdc <0x...> --chain-id <int> \\\n" +
        "  --account <0x...> --contract-deployment-id <int> \\\n" +
        "  --nonce <uuid> --signature <0x...> \\\n" +
        "  --disbursements '[{\"recipient\":\"0x..\",\"amount\":50000000,\"txHash\":\"0x..\",\"eventId\":\"0x..\"}]'"
      );
      process.exit(1);
    }

    const disbursements: DisbursementRecord[] = JSON.parse(disbursementsRaw);

    const result = await proofOfDisbursement({
      accountAddress:       account,
      treasuryAddress:      treasury,
      usdcAddress:          usdc,
      chainId:              Number(chainId),
      disbursements,
      contractDeploymentId: Number(deployId),
      nonce,
      signature,
    });
    console.log("\nResult:", JSON.stringify(result, null, 2));

  } else {
    console.error("Usage: ts-node scripts/createAttestation.ts <proof-of-funds|proof-of-disbursement> [options]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
