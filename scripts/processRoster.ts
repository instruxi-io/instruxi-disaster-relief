/**
 * processRoster.ts — Phase 4
 *
 * Admin-triggered roster ingestion pipeline. Fetches a CSV from Instruxi
 * Object Storage via presigned URL, validates schema, and onboards each
 * eligible recipient into the correct tier-based Enforcer group.
 *
 * Pipeline:
 *   1. POST /auth/authorize             — verify admin permission
 *   2. GET  /storage/file/storj/presigned-url — time-limited download URL
 *   3. Fetch + parse CSV               — validate schema, split eligible/rejected
 *   4. For each eligible: GET /admin/users/resolve + POST /admin/groups/users/batch
 *   5. POST /storage/file/storj/move   — archive processed file
 *
 * NOTE — Enforcer account registration is NOT performed here.
 * registerAccount() requires an ECDSA signature per wallet, which is impractical
 * for batch processing without a service key. Recipients must be registered in
 * Enforcer before this script runs — either via the frontend self-registration
 * flow (Privy SIWE) or individually via `npm run onboard-recipient`.
 * If a wallet is not registered in Enforcer, OPA will deny it during the CRE
 * eligibility_registration pipeline (logCallback.ts checkRecipientEligibility).
 *
 * CSV columns:
 *   phone_or_ref, address, regionId, eligibilityStatus, payoutTier, email, first_name, last_name
 *
 * payoutTier values map to Enforcer groups:
 *   "standard" → tier 1 → Eligible:Program:Region:1
 *   "priority"  → tier 2 → Eligible:Program:Region:2
 *
 * Usage:
 *   npx ts-node scripts/processRoster.ts \
 *     --object-key <storj-object-key> \
 *     --program US-FLOOD-2026 \
 *     --region US-CA \
 *     --tier-group-ids '{"1":"groupUUID_standard","2":"groupUUID_priority"}' \
 *     --policy-id <enforcer-admin-policy-id> \
 *     --caller-address 0xAdminAddress \
 *     [--bucket-name <storj-bucket>] [--archive-path processed/]
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT, INSTRUXI_TENANT_ID
 */

import "dotenv/config";
import { createHash } from "crypto";
import {
  authorize,
  getPresignedUrl,
  resolveUser,
  addUserToGroups,
  moveFile,
} from "./instruxi";

// ── CSV Schema ────────────────────────────────────────────────────────────

interface RosterRow {
  phone_or_ref: string;
  address: string;             // Wallet address (required for onchain eligibility)
  regionId: string;
  eligibilityStatus: string;   // "eligible" | "ineligible" | "pending"
  payoutTier: string;          // e.g. "standard", "priority"
  email?: string;
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
  const required = ["phone_or_ref", "address", "regionid", "eligibilitystatus", "payouttier"];
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

    if (!row["address"] || !row["address"].startsWith("0x")) {
      errors.push(`Row ${i + 1}: invalid or missing wallet address`);
      continue;
    }

    rows.push({
      phone_or_ref:      row["phone_or_ref"],
      address:           row["address"],
      regionId:          row["regionid"],
      eligibilityStatus: row["eligibilitystatus"],
      payoutTier:        row["payouttier"],
      email:             row["email"],
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
  rosterHash: string;   // SHA-256 of raw CSV (integrity check)
  errors: string[];
  archived: boolean;
}

// Maps payoutTier CSV values to onchain tier numbers
const PAYOUT_TIER_MAP: Record<string, number> = {
  standard: 1,
  priority:  2,
};

export async function processRoster(opts: {
  objectKey: string;            // Storj object key (returned by uploadFile)
  program: string;
  region: string;
  tierGroupIds: Record<number, string>;   // tier number → Enforcer group UUID
  policyId?: string;
  callerAddress?: string;
  bucketName?: string;          // Storj bucket name (for archive move)
  archivePath?: string;
}): Promise<ProcessRosterResult> {
  const {
    objectKey,
    program,
    region,
    tierGroupIds,
    policyId,
    callerAddress,
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
    errors: [],
    archived: false,
  };

  // Step 1: Admin authorization gate
  if (policyId && callerAddress) {
    console.log(`[authorize] Checking admin permission for ${callerAddress}...`);
    const res = await authorize(policyId, {
      action: "process_roster",
      program,
      user_id: callerAddress,
    });
    if (!res.allow) {
      throw new Error(`Unauthorized: ${callerAddress} cannot process rosters for ${program}`);
    }
    console.log("[authorize] ✓ Admin confirmed");
  }

  // Step 2: Fetch CSV via presigned URL
  console.log(`[fetch] Getting presigned URL for object_key=${objectKey}...`);
  const presignedUrl = await getPresignedUrl(objectKey, 600); // 10 min
  console.log("[fetch] ✓ Got presigned URL, downloading...");

  const csvRes = await fetch(presignedUrl);
  if (!csvRes.ok) {
    throw new Error(`Failed to download CSV: ${csvRes.status}`);
  }
  const rawCsv = await csvRes.text();
  console.log(`[fetch] ✓ Downloaded ${rawCsv.length} bytes`);

  // Compute integrity hash
  result.rosterHash = createHash("sha256").update(rawCsv).digest("hex");
  console.log(`[hash] rosterHash: ${result.rosterHash}`);

  // Step 3: Parse CSV
  const { rows, errors: parseErrors } = parseCSV(rawCsv);
  result.errors.push(...parseErrors);
  result.totalRows = rows.length;
  result.rejectedRows = parseErrors.length;
  console.log(`[parse] ${rows.length} valid rows, ${parseErrors.length} rejected`);

  const eligibleRows = rows.filter((r) => r.eligibilityStatus.toLowerCase() === "eligible");
  const ineligibleRows = rows.filter((r) => r.eligibilityStatus.toLowerCase() !== "eligible");
  result.eligibleCount = eligibleRows.length;
  result.ineligibleCount = ineligibleRows.length;

  if (eligibleRows.length === 0) {
    console.log("[process] No eligible rows — skipping group assignment");
  } else {
    // Step 4: Resolve each wallet to UUID and assign to tier group
    if (Object.keys(tierGroupIds).length > 0) {
      console.log(`[groups] Resolving and assigning ${eligibleRows.length} recipients...`);
      let groupedCount = 0;

      for (const row of eligibleRows) {
        const tier = PAYOUT_TIER_MAP[row.payoutTier?.toLowerCase() ?? ""] ?? 0;
        if (!tier) {
          result.errors.push(`${row.address}: unknown payoutTier "${row.payoutTier}"`);
          continue;
        }
        const groupId = tierGroupIds[tier];
        if (!groupId) {
          result.errors.push(`${row.address}: no group configured for tier ${tier}`);
          continue;
        }
        try {
          // Resolve wallet address → enforcer-v2 UUID
          const user = await resolveUser(row.address);
          if (!user?.id) {
            result.errors.push(`${row.address}: not registered in enforcer (run onboard-recipient first)`);
            continue;
          }
          await addUserToGroups(user.id, [groupId]);
          groupedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Group assign ${row.address}: ${msg}`);
        }
      }
      console.log(`[groups] ✓ Assigned ${groupedCount}/${eligibleRows.length} recipients`);
    }
  }

  // Step 5: Archive processed file
  if (bucketName) {
    const destKey = `${archivePath}${objectKey.split("/").pop()}_${Date.now()}.csv`;
    console.log(`[archive] Moving to ${destKey}...`);
    try {
      await moveFile(bucketName, objectKey, destKey);
      result.archived = true;
      console.log("[archive] ✓ File archived");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[archive] Warning: ${msg}`);
      result.errors.push(`Archive: ${msg}`);
    }
  } else {
    console.log("[archive] Skipped — no --bucket-name provided");
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

  if (!objectKey || !program || !region) {
    console.error(
      "Usage: ts-node scripts/processRoster.ts \\\n" +
      "  --object-key <storj-key> --program <name> --region <id> \\\n" +
      "  --tier-group-ids '{\"1\":\"groupUUID_standard\",\"2\":\"groupUUID_priority\"}' \\\n" +
      "  [--policy-id <id>] [--caller-address <0x...>] \\\n" +
      "  [--bucket-name <storj-bucket>] [--archive-path processed/]"
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
    policyId:      get("--policy-id"),
    callerAddress: get("--caller-address"),
    bucketName:    get("--bucket-name"),
    archivePath:   get("--archive-path"),
  });

  console.log("\n" + "=".repeat(55));
  console.log("Roster Processing Summary");
  console.log("=".repeat(55));
  console.log(`Total rows:        ${result.totalRows}`);
  console.log(`Eligible:          ${result.eligibleCount}`);
  console.log(`Ineligible:        ${result.ineligibleCount}`);
  console.log(`Rejected (errors): ${result.rejectedRows}`);
  console.log(`Roster hash:       ${result.rosterHash}`);
  console.log(`Archived:          ${result.archived}`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    result.errors.forEach((e) => console.log("  -", e));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
