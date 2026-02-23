/**
 * setupGroups.ts — Phase 3A
 *
 * Creates the Enforcer group hierarchy for a relief program.
 *
 * Group naming convention (from playbook):
 *   Admins:ProgramX
 *   Partners:ProgramX
 *   Eligible:ProgramX:RegionY   (one per region)
 *
 * Usage:
 *   npx ts-node scripts/setupGroups.ts \
 *     --program US-FLOOD-2026 \
 *     --regions "US-CA,US-TX,US-FL"
 *
 * Required env vars:
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT, INSTRUXI_TENANT_ID
 */

import "dotenv/config";
import { createGroup, type GroupRecord, type ApiResponse } from "./instruxi";

interface SetupResult {
  program: string;
  groups: { name: string; id: string }[];
  errors: string[];
}

async function setupGroups(
  program: string,
  regions: string[]
): Promise<SetupResult> {
  const result: SetupResult = { program, groups: [], errors: [] };

  const groupNames = [
    `Admins:${program}`,
    `Partners:${program}`,
    ...regions.map((r) => `Eligible:${program}:${r}`),
  ];

  console.log(`\nSetting up ${groupNames.length} groups for program "${program}":`);
  groupNames.forEach((n) => console.log(`  - ${n}`));
  console.log();

  for (const name of groupNames) {
    try {
      const res: ApiResponse<GroupRecord> = await createGroup(name);
      const id = res.data?.id ?? "unknown";
      console.log(`  ✓ Created: ${name}  (id: ${id})`);
      result.groups.push({ name, id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Group may already exist — log but don't fatal
      if (msg.toLowerCase().includes("already") || msg.includes("409")) {
        console.log(`  ~ Exists:  ${name}`);
        result.groups.push({ name, id: "existing" });
      } else {
        console.error(`  ✗ Failed:  ${name} — ${msg}`);
        result.errors.push(`${name}: ${msg}`);
      }
    }
  }

  console.log(`\nDone. ${result.groups.length} groups ready, ${result.errors.length} errors.`);
  return result;
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const program = get("--program");
  const regionsRaw = get("--regions") ?? "";

  if (!program) {
    console.error("Usage: ts-node scripts/setupGroups.ts --program <name> [--regions <r1,r2,...>]");
    process.exit(1);
  }

  const regions = regionsRaw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const result = await setupGroups(program, regions);

  // Print group IDs for use in subsequent scripts
  console.log("\nGroup ID map (save these):");
  result.groups.forEach((g) => console.log(`  ${g.name}: ${g.id}`));

  if (result.errors.length > 0) {
    console.error("\nErrors:");
    result.errors.forEach((e) => console.error("  ", e));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
