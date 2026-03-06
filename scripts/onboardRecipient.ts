/**
 * onboardRecipient.ts — Phase 3A (onboardRecipient wrapper)
 *
 * Chains enforcer-v2 calls to onboard a single recipient:
 *
 *   1. POST /auth/register           — register account (idempotent: catches 409)
 *   2. GET  /admin/users/resolve     — resolve wallet → UUID (needed for groups)
 *   3. POST /admin/groups/users/batch — assign to eligible groups
 *
 * Use for individual recipients. For batch ingestion, processRoster.ts handles
 * group assignment — but account registration must be done separately (this
 * script or frontend SIWE) before processRoster runs.
 *
 * Usage (single recipient):
 *   npx ts-node scripts/onboardRecipient.ts \
 *     --address 0xABC... \
 *     --email victim@example.com \
 *     --signature 0x... \
 *     --group-ids "groupId1,groupId2" \
 *     [--first-name Jane] [--last-name Doe] [--phone +15551234567]
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT, INSTRUXI_TENANT_ID
 *
 * Note on signature:
 *   The Enforcer registration requires an ECDSA signature of the account_address.
 *   For backend / service-key registration, sign with your admin/service private key.
 *   Message format: verify with your Enforcer instance (typically EIP-191 personal_sign).
 *
 * Note on group IDs:
 *   Group IDs are enforcer-v2 UUIDs returned by setupGroups.ts.
 *   User IDs used for group assignment are also UUIDs (resolved from wallet address).
 */

import "dotenv/config";
import {
  registerAccount,
  resolveUser,
  addUserToGroups,
} from "./instruxi";

export interface OnboardInput {
  address: string;
  email: string;
  signature: string;
  groupIds: string[];
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  username?: string;
}

export interface OnboardResult {
  address: string;
  userId?: string;           // enforcer-v2 UUID (needed for group ops)
  registered: boolean;       // true = newly registered
  grouped: boolean;
  error?: string;
}

/**
 * Onboard a single recipient into Enforcer-v2.
 * Registration is attempted; 409 (already exists) is treated as success.
 */
export async function onboardRecipient(
  input: OnboardInput
): Promise<OnboardResult> {
  const result: OnboardResult = {
    address: input.address,
    registered: false,
    grouped: false,
  };

  try {
    // Step 1: Register account (idempotent)
    try {
      await registerAccount(
        input.address,
        input.email,
        input.signature,
        {
          first_name: input.firstName,
          last_name: input.lastName,
          phone_number: input.phoneNumber,
          username: input.username,
        }
      );
      result.registered = true;
      console.log(`  [register]  ${input.address} ✓`);
    } catch (regErr) {
      const msg = regErr instanceof Error ? regErr.message : String(regErr);
      if (msg.includes("409") || msg.toLowerCase().includes("already")) {
        console.log(`  [register]  ${input.address} (already exists)`);
      } else {
        throw regErr;
      }
    }

    // Step 2: Resolve wallet → enforcer UUID (needed for group assignment)
    const user = await resolveUser(input.address);
    if (!user?.id) {
      throw new Error(`Could not resolve UUID for address ${input.address}`);
    }
    result.userId = user.id;
    console.log(`  [resolve]   ${input.address} → UUID ${user.id}`);

    // Step 3: Assign to groups
    if (input.groupIds.length > 0) {
      await addUserToGroups(user.id, input.groupIds);
      result.grouped = true;
      console.log(`  [groups]    ${user.id} → [${input.groupIds.join(", ")}] ✓`);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`  [error]     ${input.address}: ${result.error}`);
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

  const address    = get("--address");
  const email      = get("--email");
  const signature  = get("--signature");
  const groupIdsRaw = get("--group-ids") ?? "";

  if (!address || !email || !signature) {
    console.error(
      "Usage: ts-node scripts/onboardRecipient.ts \\\n" +
      "  --address <0x...> --email <email> --signature <0x...> \\\n" +
      "  --group-ids <uuid1,uuid2> [--first-name X] [--last-name Y] [--phone +1...]"
    );
    process.exit(1);
  }

  const groupIds = groupIdsRaw.split(",").map((g) => g.trim()).filter(Boolean);

  const result = await onboardRecipient({
    address,
    email,
    signature,
    groupIds,
    firstName: get("--first-name"),
    lastName:  get("--last-name"),
    phoneNumber: get("--phone"),
  });

  console.log("\nResult:", JSON.stringify(result, null, 2));
  if (result.error) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
