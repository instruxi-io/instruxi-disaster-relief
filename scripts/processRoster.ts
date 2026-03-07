/**
 * processRoster.ts — Phase 4
 *
 * Admin-triggered roster ingestion pipeline. Fetches a CSV from Instruxi
 * Object Storage via presigned URL, pre-provisions each eligible recipient
 * in enforcer (user + wallet), assigns them to the correct tier group,
 * and returns the wallet→tier mapping for onchain eligibility registration.
 *
 * Pipeline:
 *   1. GET  /storage/file/storj/presigned-url — time-limited download URL
 *   2. Fetch + parse CSV                       — validate schema, split eligible/rejected
 *   3. For each eligible row:
 *      a. POST /admin/users                    — create enforcer user from email
 *      b. POST /users/{user_id}/wallets        — provision wallet (enforcer/Privy)
 *      c. POST /admin/groups/users/batch       — add to tier group
 *   4. Returns wallets[] + tiers[] ready for requestEligibilityRegistration()
 *
 * When victim later logs in via Privy with their email, Privy restores the
 * pre-provisioned wallet — same address already registered onchain.
 *
 * CSV columns (email is the primary identifier — no wallet address needed):
 *   phone_or_ref, email, regionId, eligibilityStatus, payoutTier, first_name, last_name
 *
 * payoutTier values:
 *   "standard" → tier 1 → Eligible:Program:Region:1
 *   "priority"  → tier 2 → Eligible:Program:Region:2
 *
 * Usage:
 *   npx ts-node scripts/processRoster.ts \
 *     --object-key <storj-object-key> \
 *     --program US-FLOOD-2026 \
 *     --region US-CA \
 *     --tier-group-ids '{"1":"groupUUID_standard","2":"groupUUID_priority"}' \
 *     [--bucket-name <storj-bucket>] [--archive-path processed/]
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT, INSTRUXI_TENANT_ID
 */

import "dotenv/config";
import { createHash } from "crypto";
import {
  getPresignedUrl,
  createPrivyUser,
  moveFile,
} from "./instruxi";

// ── CSV Schema ────────────────────────────────────────────────────────────

interface RosterRow {
  phone_or_ref: string;
  email: string;              // Primary identifier — wallet provisioned from this
  regionId: string;
  eligibilityStatus: string;  // "eligible" | "ineligible" | "pending"
  payoutTier: string;         // "standard" | "priority"
  first_name?: string;
  last_name?: string;
}

// ── CSV Parsing ────────────────────────────────────────────────────────────

function parseCSV(raw: string): { rows: RosterRow[]; errors: string[] } {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return { rows: [], errors: ["CSV has no data rows"] };
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const required = ["email", "regionid", "eligibilitystatus", "payouttier"];
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length > 0) {
    return { rows: [], errors: [`CSV missing required columns: ${missing.join(", ")}`] };
  }

  const rows: RosterRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    if (values.length !== headers.length) {
      errors.push(`Row ${i + 1}: column count mismatch`);
      continue;
    }

    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });

    if (!row["email"] || !row["email"].includes("@")) {
      errors.push(`Row ${i + 1}: invalid or missing email`);
      continue;
    }

    rows.push({
      phone_or_ref:      row["phone_or_ref"] ?? "",
      email:             row["email"],
      regionId:          row["regionid"],
      eligibilityStatus: row["eligibilitystatus"],
      payoutTier:        row["payouttier"],
      first_name:        row["first_name"],
      last_name:         row["last_name"],
    });
  }

  return { rows, errors };
}

// ── Processing ────────────────────────────────────────────────────────────

export interface ProcessRosterResult {
  objectKey: string;
  program: string;
  region: string;
  totalRows: number;
  eligibleCount: number;
  ineligibleCount: number;
  rejectedRows: number;
  rosterHash: string;
  // Wallet→tier mapping ready for requestEligibilityRegistration
  wallets: string[];
  tiers: number[];
  errors: string[];
  archived: boolean;
}

const PAYOUT_TIER_MAP: Record<string, number> = {
  standard: 1,
  priority:  2,
};

export async function processRoster(opts: {
  objectKey: string;
  program: string;
  region: string;
  tierGroupIds: Record<number, string>;  // tier number → enforcer group UUID
  chainId?: number;
  bucketName?: string;
  archivePath?: string;
}): Promise<ProcessRosterResult> {
  const {
    objectKey,
    program,
    region,
    tierGroupIds,
    chainId = 11155111,
    bucketName = "",
    archivePath = "processed/",
  } = opts;

  const result: ProcessRosterResult = {
    objectKey,
    program,
    region,
    totalRows: 0,
    eligibleCount: 0,
    ineligibleCount: 0,
    rejectedRows: 0,
    rosterHash: "",
    wallets: [],
    tiers: [],
    errors: [],
    archived: false,
  };

  // Step 1: Fetch CSV via presigned URL
  console.log(`[fetch] Getting presigned URL for object_key=${objectKey}...`);
  const presignedUrl = await getPresignedUrl(objectKey, 600);
  const csvRes = await fetch(presignedUrl);
  if (!csvRes.ok) throw new Error(`Failed to download CSV: ${csvRes.status}`);
  const rawCsv = await csvRes.text();
  console.log(`[fetch] ✓ Downloaded ${rawCsv.length} bytes`);

  result.rosterHash = createHash("sha256").update(rawCsv).digest("hex");
  console.log(`[hash] rosterHash: ${result.rosterHash}`);

  // Step 2: Parse CSV
  const { rows, errors: parseErrors } = parseCSV(rawCsv);
  result.errors.push(...parseErrors);
  result.totalRows = rows.length;
  result.rejectedRows = parseErrors.length;
  console.log(`[parse] ${rows.length} valid rows, ${parseErrors.length} rejected`);

  const eligibleRows = rows.filter((r) => r.eligibilityStatus.toLowerCase() === "eligible");
  const ineligibleRows = rows.filter((r) => r.eligibilityStatus.toLowerCase() !== "eligible");
  result.eligibleCount = eligibleRows.length;
  result.ineligibleCount = ineligibleRows.length;

  // Step 3: For each eligible row — create user, provision wallet, assign group
  if (eligibleRows.length > 0) {
    console.log(`\n[provision] Processing ${eligibleRows.length} eligible recipients...`);

    for (const row of eligibleRows) {
      const tier = PAYOUT_TIER_MAP[row.payoutTier?.toLowerCase() ?? ""] ?? 0;
      if (!tier) {
        result.errors.push(`${row.email}: unknown payoutTier "${row.payoutTier}"`);
        continue;
      }

      const groupId = tierGroupIds[tier];
      if (!groupId) {
        result.errors.push(`${row.email}: no group configured for tier ${tier}`);
        continue;
      }

      try {
        // Create Privy user + server wallet via RWA Gateway in one call.
        // Returns wallet address directly — no enforcer user creation needed.
        console.log(`  [privy] Creating user + wallet for ${row.email}...`);
        const { privyDid, walletAddress } = await createPrivyUser(row.email);
        console.log(`  [privy] ✓ did: ${privyDid}  address: ${walletAddress}`);

        // Collect for eligibility registration
        result.wallets.push(walletAddress);
        result.tiers.push(tier);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ Failed ${row.email}: ${msg}`);
        result.errors.push(`${row.email}: ${msg}`);
      }
    }

    console.log(`\n[provision] ✓ ${result.wallets.length}/${eligibleRows.length} recipients provisioned`);
  }

  // Step 4: Archive processed file
  if (bucketName) {
    const destKey = `${archivePath}${objectKey.split("/").pop()}_${Date.now()}.csv`;
    console.log(`[archive] Moving to ${destKey}...`);
    try {
      await moveFile(bucketName, objectKey, destKey);
      result.archived = true;
      console.log("[archive] ✓ Archived");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[archive] Warning: ${msg}`);
      result.errors.push(`Archive: ${msg}`);
    }
  }

  return result;
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const objectKey       = get("--object-key");
  const program         = get("--program");
  const region          = get("--region");
  const tierGroupIdsRaw = get("--tier-group-ids") ?? "{}";
  const chainId         = parseInt(get("--chain-id") ?? "11155111", 10);

  if (!objectKey || !program || !region) {
    console.error(
      "Usage: ts-node scripts/processRoster.ts \\\n" +
      "  --object-key <storj-key> --program <name> --region <id> \\\n" +
      "  --tier-group-ids '{\"1\":\"groupUUID_standard\",\"2\":\"groupUUID_priority\"}' \\\n" +
      "  [--chain-id 11155111] [--bucket-name <storj-bucket>] [--archive-path processed/]"
    );
    process.exit(1);
  }

  let tierGroupIds: Record<number, string> = {};
  try {
    const parsed = JSON.parse(tierGroupIdsRaw) as Record<string, string>;
    tierGroupIds = Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [parseInt(k, 10), v])
    );
  } catch {
    console.error(`Invalid --tier-group-ids JSON: ${tierGroupIdsRaw}`);
    process.exit(1);
  }

  console.log(`\nProcessing roster for ${program} / ${region}`);
  console.log("=".repeat(55));

  const result = await processRoster({
    objectKey,
    program,
    region,
    tierGroupIds,
    chainId,
    bucketName:  get("--bucket-name"),
    archivePath: get("--archive-path"),
  });

  console.log("\n" + "=".repeat(55));
  console.log("Roster Processing Summary");
  console.log("=".repeat(55));
  console.log(`Total rows:        ${result.totalRows}`);
  console.log(`Eligible:          ${result.eligibleCount}`);
  console.log(`Ineligible:        ${result.ineligibleCount}`);
  console.log(`Rejected (errors): ${result.rejectedRows}`);
  console.log(`Roster hash:       ${result.rosterHash}`);
  console.log(`Wallets:           ${result.wallets.length}`);
  console.log(`Archived:          ${result.archived}`);

  if (result.wallets.length > 0) {
    console.log("\nReady for eligibility registration:");
    console.log("  wallets:", JSON.stringify(result.wallets));
    console.log("  tiers:  ", JSON.stringify(result.tiers));
    console.log("\nNext: call requestEligibilityRegistration(eventId, wallets, tiers) on the contract");
  }

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    result.errors.forEach((e) => console.log("  -", e));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
