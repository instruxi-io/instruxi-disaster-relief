/**
 * processRoster.ts — Phase 4
 *
 * Admin-triggered roster ingestion pipeline. Fetches a CSV from Instruxi
 * Object Storage via presigned URL, validates schema, onboards each eligible
 * recipient into the correct tier-based Enforcer group, and archives the file.
 *
 * Pipeline (matches playbook steps 18-25):
 *   1. POST /enforcer/auth/authorize        — verify admin permission
 *   2. GET  /storage/file/presigned-url     — get time-limited download URL
 *   3. Fetch + parse CSV                    — validate schema, split eligible/rejected
 *   4. POST /profile/multi-create           — batch create profiles
 *   5. POST /admin/groups/account/add-multiple — assign eligible recipients to tier group
 *   6. POST /storage/file/move              — archive processed file
 *
 * CSV columns (from playbook):
 *   phone_or_ref, regionId, eligibilityStatus, payoutTier
 *
 * payoutTier values map to Enforcer groups:
 *   "standard" → tier 1 → Eligible:Program:Region:1
 *   "priority"  → tier 2 → Eligible:Program:Region:2
 *
 * Usage:
 *   npx ts-node scripts/processRoster.ts \
 *     --file-id <instruxi-file-id> \
 *     --program US-FLOOD-2026 \
 *     --region US-CA \
 *     --tier-group-ids '{"1":"groupId_standard","2":"groupId_priority"}' \
 *     --policy-id <enforcer-admin-policy-id> \
 *     --caller-address 0xAdminAddress \
 *     [--archive-path processed/]
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT, INSTRUXI_TENANT_ID
 */

import "dotenv/config";
import { createHash } from "crypto";
import {
  authorize,
  getPresignedUrl,
  multiCreateProfiles,
  addAccountToGroups,
  moveFile,
  type RawAccount,
} from "./instruxi";

// ── CSV Schema ────────────────────────────────────────────────────────────

interface RosterRow {
  phone_or_ref: string;        // Phone number or external reference ID
  address: string;             // Wallet address (required for onchain eligibility)
  regionId: string;            // ISO/program region code
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
  fileId: string;
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
  fileId: string;
  program: string;
  region: string;
  tierGroupIds: Record<number, string>;   // tier number → Enforcer group ID
  policyId?: string;
  callerAddress?: string;
  archivePath?: string;
}): Promise<ProcessRosterResult> {
  const {
    fileId,
    program,
    region,
    tierGroupIds,
    policyId,
    callerAddress,
    archivePath = "processed/",
  } = opts;

  const result: ProcessRosterResult = {
    fileId,
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
      subject: callerAddress,
    });
    const allowed = !!(res.data?.["allowed"] ?? (res as any).allowed);
    if (!allowed) {
      throw new Error(`Unauthorized: ${callerAddress} cannot process rosters for ${program}`);
    }
    console.log("[authorize] ✓ Admin confirmed");
  }

  // Step 2: Fetch CSV via presigned URL
  console.log(`[fetch] Getting presigned URL for file_id=${fileId}...`);
  const presignedUrl = await getPresignedUrl(fileId, 600); // 10 min
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
    console.log("[process] No eligible rows — skipping onboarding");
  } else {
    // Step 4: Batch create profiles
    console.log(`[profiles] Creating ${eligibleRows.length} profiles...`);
    const accounts: RawAccount[] = eligibleRows.map((r) => ({
      account_address: r.address,
      email:           r.email,
      first_name:      r.first_name,
      last_name:       r.last_name,
      phone_number:    r.phone_or_ref.startsWith("+") ? r.phone_or_ref : undefined,
    }));

    try {
      await multiCreateProfiles(accounts);
      console.log(`[profiles] ✓ Created ${accounts.length} profiles`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[profiles] Error: ${msg}`);
      result.errors.push(`Profile batch create: ${msg}`);
    }

    // Step 5: Assign eligible recipients to their tier-specific group
    if (Object.keys(tierGroupIds).length > 0) {
      console.log(`[groups] Assigning ${eligibleRows.length} recipients to tier groups...`);
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
          await addAccountToGroups(row.address, [groupId]);
          groupedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Group assign ${row.address}: ${msg}`);
        }
      }
      console.log(`[groups] ✓ Assigned ${groupedCount}/${eligibleRows.length} recipients`);
    }
  }

  // Step 6: Archive processed file
  console.log(`[archive] Moving file to ${archivePath}...`);
  try {
    await moveFile(fileId, `${archivePath}${fileId}_${Date.now()}.csv`);
    result.archived = true;
    console.log("[archive] ✓ File archived");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[archive] Warning: ${msg}`);
    result.errors.push(`Archive: ${msg}`);
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

  const fileId         = get("--file-id");
  const program        = get("--program");
  const region         = get("--region");
  const tierGroupIdsRaw = get("--tier-group-ids") ?? "{}";

  if (!fileId || !program || !region) {
    console.error(
      "Usage: ts-node scripts/processRoster.ts \\\n" +
      "  --file-id <id> --program <name> --region <id> \\\n" +
      "  --tier-group-ids '{\"1\":\"groupId_standard\",\"2\":\"groupId_priority\"}' \\\n" +
      "  [--policy-id <id>] [--caller-address <0x...>] [--archive-path processed/]"
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
    fileId,
    program,
    region,
    tierGroupIds,
    policyId:      get("--policy-id"),
    callerAddress: get("--caller-address"),
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
