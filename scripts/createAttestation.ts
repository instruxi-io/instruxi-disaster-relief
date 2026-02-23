/**
 * createAttestation.ts — Phase 7: TrustSync Transparency
 *
 * Two attestation flows (from playbook):
 *
 *   proofOfFunds(...)
 *     Creates a single attestation for the current treasury USDC balance.
 *     POST /rwa/attestation/create → POST /rwa/attestation/publish
 *     Use after deposit or periodic snapshots so donors can verify reserves.
 *
 *   proofOfDisbursement(...)
 *     Creates individual attestations for each disbursement, then groups
 *     them into an audited batch.
 *     POST /rwa/attestation/create (×N) →
 *     POST /rwa/attestation-batches →
 *     POST /rwa/attestation-batches/{id}/link →
 *     GET  /rwa/attestation-batches/{id}/validate →
 *     GET  /rwa/attestation-batches/{id}/metrics
 *
 * Usage — proof of funds:
 *   npx ts-node scripts/createAttestation.ts proof-of-funds \
 *     --treasury 0xReliefTreasury \
 *     --usdc 0xUSDC \
 *     --balance 50000000000 \
 *     --chain-id 11155111 \
 *     --account 0xAdminAddress
 *
 * Usage — proof of disbursement batch:
 *   npx ts-node scripts/createAttestation.ts proof-of-disbursement \
 *     --treasury 0xReliefTreasury \
 *     --usdc 0xUSDC \
 *     --chain-id 11155111 \
 *     --account 0xAdminAddress \
 *     --auditor 0xAuditorAddress \
 *     --auditor-sig 0x... \
 *     --disbursements '[{"recipient":"0x..","amount":50000000},...]'
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT
 */

import "dotenv/config";
import {
  createAttestation,
  publishAttestation,
  createAttestationBatch,
  linkAttestationsToBatch,
  validateAttestationBatch,
  getAttestationBatchMetrics,
  type CreateAttestationInput,
} from "./instruxi";

// ── Proof of Funds ────────────────────────────────────────────────────────

export interface ProofOfFundsInput {
  accountAddress: string;         // Admin/treasury operator address
  treasuryAddress: string;        // ReliefTreasury contract address
  usdcAddress: string;            // USDC token contract address
  balanceRaw: number;             // Raw USDC balance (6 decimals, e.g. 50000000000 = $50,000)
  chainId: number;
}

export interface ProofOfFundsResult {
  attestationId: string;
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

  const attestationInput: CreateAttestationInput = {
    account_address:                    input.accountAddress,
    asset_contract_address:             input.treasuryAddress,
    fractional_amount:                  input.balanceRaw,
    fractional_decimals:                6,
    fractional_token_contract_address:  input.usdcAddress,
    fractional_unit:                    "USDC",
    token_id:                           0,
    chain_id:                           input.chainId,
    public:                             true,
    active:                             true,
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
  auditorAddress: string;
  auditorSignature: string;        // Auditor's ECDSA signature over the batch
}

export interface ProofOfDisbursementResult {
  batchId: string;
  attestationIds: string[];
  totalAmount: number;
  valid: boolean;
  metrics: Record<string, unknown>;
}

/**
 * Create individual disbursement attestations, group into a batch,
 * link them, validate totals, and return metrics.
 * Called after a disbursement event is closed or on a schedule.
 */
export async function proofOfDisbursement(
  input: ProofOfDisbursementInput
): Promise<ProofOfDisbursementResult> {
  const { disbursements } = input;
  console.log(`\n[proof-of-disbursement] Creating ${disbursements.length} attestations...`);

  const totalAmount = disbursements.reduce((sum, d) => sum + d.amount, 0);
  const attestationIds: string[] = [];

  // Step 1: Individual attestation per disbursement
  for (const d of disbursements) {
    const res = await createAttestation({
      account_address:                    input.accountAddress,
      asset_contract_address:             input.treasuryAddress,
      fractional_amount:                  d.amount,
      fractional_decimals:                6,
      fractional_token_contract_address:  input.usdcAddress,
      fractional_unit:                    "USDC",
      token_id:                           0,
      chain_id:                           input.chainId,
      active:                             true,
      public:                             false,  // batch publish below
    });
    const id = res.data?.id ?? "";
    if (!id) throw new Error(`createAttestation returned no id for recipient ${d.recipient}`);
    attestationIds.push(id);
    console.log(`  ✓ ${d.recipient} → $${d.amount / 1e6} USDC (attestation ${id})`);
  }

  // Step 2: Create attestation batch
  console.log(`\n[proof-of-disbursement] Creating batch (total: $${totalAmount / 1e6} USDC)...`);
  const batchRes = await createAttestationBatch({
    asset_contract_address:             input.treasuryAddress,
    fractional_token_contract_address:  input.usdcAddress,
    total_amount:                       totalAmount,
    audit_timestamp:                    new Date().toISOString(),
    auditor_account_address:            input.auditorAddress,
    auditor_signature:                  input.auditorSignature,
    chain_id:                           input.chainId,
    active:                             true,
  });
  const batchId = batchRes.data?.id ?? "";
  if (!batchId) throw new Error("createAttestationBatch returned no id");
  console.log(`[proof-of-disbursement] ✓ Batch created id=${batchId}`);

  // Step 3: Link attestations to batch
  await linkAttestationsToBatch(batchId);
  console.log(`[proof-of-disbursement] ✓ Linked ${attestationIds.length} attestations to batch`);

  // Step 4: Validate totals
  const validateRes = await validateAttestationBatch(batchId);
  const valid = validateRes.data?.valid ?? false;
  console.log(`[proof-of-disbursement] ✓ Validation: ${valid ? "PASSED" : "FAILED"}`);
  if (!valid) {
    console.warn("[proof-of-disbursement] Warning: batch validation failed — totals may not match");
  }

  // Step 5: Fetch metrics for dashboard
  const metricsRes = await getAttestationBatchMetrics(batchId);
  const metrics = (metricsRes.data ?? {}) as Record<string, unknown>;
  console.log(`[proof-of-disbursement] Metrics:`, JSON.stringify(metrics, null, 2));

  return { batchId, attestationIds, totalAmount, valid, metrics };
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
    const treasury = get("--treasury");
    const usdc     = get("--usdc");
    const balance  = get("--balance");
    const chainId  = get("--chain-id");
    const account  = get("--account");

    if (!treasury || !usdc || !balance || !chainId || !account) {
      console.error(
        "Usage: ts-node scripts/createAttestation.ts proof-of-funds \\\n" +
        "  --treasury <0x...> --usdc <0x...> --balance <raw> \\\n" +
        "  --chain-id <int> --account <0x...>"
      );
      process.exit(1);
    }

    const result = await proofOfFunds({
      accountAddress:  account,
      treasuryAddress: treasury,
      usdcAddress:     usdc,
      balanceRaw:      Number(balance),
      chainId:         Number(chainId),
    });
    console.log("\nResult:", JSON.stringify(result, null, 2));

  } else if (command === "proof-of-disbursement") {
    const treasury      = get("--treasury");
    const usdc          = get("--usdc");
    const chainId       = get("--chain-id");
    const account       = get("--account");
    const auditor       = get("--auditor");
    const auditorSig    = get("--auditor-sig");
    const disbursementsRaw = get("--disbursements");

    if (!treasury || !usdc || !chainId || !account || !auditor || !auditorSig || !disbursementsRaw) {
      console.error(
        "Usage: ts-node scripts/createAttestation.ts proof-of-disbursement \\\n" +
        "  --treasury <0x...> --usdc <0x...> --chain-id <int> \\\n" +
        "  --account <0x...> --auditor <0x...> --auditor-sig <0x...> \\\n" +
        "  --disbursements '[{\"recipient\":\"0x..\",\"amount\":50000000,\"txHash\":\"0x..\",\"eventId\":\"0x..\"}]'"
      );
      process.exit(1);
    }

    const disbursements: DisbursementRecord[] = JSON.parse(disbursementsRaw);

    const result = await proofOfDisbursement({
      accountAddress:  account,
      treasuryAddress: treasury,
      usdcAddress:     usdc,
      chainId:         Number(chainId),
      disbursements,
      auditorAddress:  auditor,
      auditorSignature: auditorSig,
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
