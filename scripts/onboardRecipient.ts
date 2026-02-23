/**
 * onboardRecipient.ts — Phase 3A (onboardRecipient wrapper)
 *
 * The single "NEEDS WRAPPER" item from the Instruxi API alignment matrix.
 * Chains three Instruxi calls into one operation:
 *
 *   1. GET  /enforcer/account/exists/{address}
 *   2. POST /enforcer/auth/account/register   (if not yet registered)
 *   3. POST /profile/multi-create             (create/update profile)
 *   4. POST /admin/groups/account/add-multiple (assign to eligible groups)
 *
 * Can be called individually or used by processRoster.ts for batch ingestion.
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
 *   Message format: keccak256(account_address) — verify with your Enforcer instance.
 */

import "dotenv/config";
import {
  accountExists,
  registerAccount,
  multiCreateProfiles,
  addAccountToGroups,
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
  registered: boolean;   // true = newly registered, false = already existed
  profiled: boolean;
  grouped: boolean;
  error?: string;
}

/**
 * Onboard a single recipient into Instruxi Enforcer.
 * Safe to call multiple times — existence check prevents duplicate registration.
 */
export async function onboardRecipient(
  input: OnboardInput
): Promise<OnboardResult> {
  const result: OnboardResult = {
    address: input.address,
    registered: false,
    profiled: false,
    grouped: false,
  };

  try {
    // Step 1: Check if account already exists
    const exists = await accountExists(input.address);

    if (!exists) {
      // Step 2: Register account
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
    } else {
      console.log(`  [register]  ${input.address} (already exists)`);
    }

    // Step 3: Create/update profile
    await multiCreateProfiles([
      {
        account_address: input.address,
        email: input.email,
        first_name: input.firstName,
        last_name: input.lastName,
        phone_number: input.phoneNumber,
        username: input.username,
      },
    ]);
    result.profiled = true;
    console.log(`  [profile]   ${input.address} ✓`);

    // Step 4: Assign to groups
    if (input.groupIds.length > 0) {
      await addAccountToGroups(input.address, input.groupIds);
      result.grouped = true;
      console.log(`  [groups]    ${input.address} → [${input.groupIds.join(", ")}] ✓`);
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
      "  --group-ids <id1,id2> [--first-name X] [--last-name Y] [--phone +1...]"
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
