/**
 * uploadRoster.ts — Phase 3C
 *
 * Uploads a CSV recipient roster to Instruxi Object Storage.
 * Enforcer policy-gates the upload: only Partners:ProgramX members can upload.
 *
 * Pipeline:
 *   1. POST /auth/authorize            — verify caller has partner permission
 *   2. POST /storage/file/storj/upload — multipart CSV upload
 *
 * CSV schema:
 *   phone_or_ref, email, regionId, eligibilityStatus, payoutTier, first_name, last_name
 *
 * NOTE: email is the primary identifier. No wallet address needed — wallets are
 * pre-provisioned via enforcer/Privy during processRoster. When a victim logs in
 * with their email via Privy, their pre-provisioned wallet is restored automatically.
 *
 * Usage:
 *   npx ts-node scripts/uploadRoster.ts \
 *     --file ./rosters/us-flood-2026-001.csv \
 *     --program US-FLOOD-2026 \
 *     --region US-CA \
 *     --policy-id <enforcer-policy-id> \
 *     [--storage-policy-id <object-storage-policy-id>]
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT, INSTRUXI_TENANT_ID
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { authorize, uploadFile } from "./instruxi";

export interface UploadRosterResult {
  fileId: string;
  objectKey: string;   // Storj object key — pass to processRoster as --object-key
  program: string;
  region: string;
  fileName: string;
  uploadedAt: string;
}

export async function uploadRoster(opts: {
  filePath: string;
  program: string;
  region: string;
  policyId?: string;
  storagePolicyId?: string;
  callerAddress?: string;
}): Promise<UploadRosterResult> {
  const { filePath, program, region, policyId, storagePolicyId } = opts;

  // Step 1: Authorize upload (partner gate)
  if (policyId && opts.callerAddress) {
    console.log(`[authorize] Checking partner permission for ${opts.callerAddress}...`);
    const res = await authorize(policyId, {
      action: "upload_roster",
      program,
      subject: opts.callerAddress,
    });
    if (!res.allow) {
      throw new Error(`Unauthorized: caller ${opts.callerAddress} is not permitted to upload rosters for ${program}`);
    }
    console.log("[authorize] ✓ Permitted");
  }

  // Step 2: Read and upload file
  const buffer = readFileSync(filePath);
  const fileName = `${program}_${region}_${Date.now()}.csv`;
  console.log(`[upload] Uploading ${fileName} (${buffer.length} bytes)...`);

  const { file_id: fileId, object_key: objectKey } = await uploadFile(buffer, fileName, "text/csv", program, storagePolicyId);
  console.log(`[upload] ✓ file_id: ${fileId}  object_key: ${objectKey}`);

  const uploadedAt = new Date().toISOString();
  return { fileId, objectKey, program, region, fileName, uploadedAt };
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const filePath = get("--file");
  const program  = get("--program");
  const region   = get("--region");

  if (!filePath || !program || !region) {
    console.error(
      "Usage: ts-node scripts/uploadRoster.ts \\\n" +
      "  --file <path> --program <name> --region <id> \\\n" +
      "  [--policy-id <enforcer-policy-id>] [--storage-policy-id <id>]"
    );
    process.exit(1);
  }

  const result = await uploadRoster({
    filePath,
    program,
    region,
    policyId:        get("--policy-id"),
    storagePolicyId: get("--storage-policy-id"),
    callerAddress:   get("--caller"),
  });

  console.log("\nUpload complete:");
  console.log(JSON.stringify(result, null, 2));
  console.log("\nNext step: run processRoster.ts with --object-key", result.objectKey);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
