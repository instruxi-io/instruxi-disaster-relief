/**
 * queryAttestations.ts — query TrustSync attestations for a ReliefTreasury
 *
 * Lists attestations created by CRE Pipelines 3 (Disbursed) and 4 (Deposited),
 * printing ID, recipient/depositor, amount, active status, and creation time.
 *
 * Usage:
 *   npm run query-attestations -- --treasury 0x<CONTRACT_ADDRESS>
 *
 * Required env vars (from .env):
 *   INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT
 */

import "dotenv/config";

// ── Types ─────────────────────────────────────────────────────────────────

interface AttestationRecord {
  id: string;
  account_address: string;
  asset_contract_address: string;
  fractional_amount: number;
  fractional_unit: string;
  chain_id: number;
  public: boolean;
  active: boolean;
  created_at?: string;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ── Config ────────────────────────────────────────────────────────────────

function cfg() {
  return {
    baseUrl:  process.env.INSTRUXI_BASE_URL  || "https://api.instruxi.io",
    apiKey:   process.env.INSTRUXI_API_KEY   || "",
    adminJwt: process.env.INSTRUXI_ADMIN_JWT || "",
  };
}

async function get<T>(path: string): Promise<T> {
  const c = cfg();
  const url = `${c.baseUrl}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type":  "application/json",
      "x-api-key":     c.apiKey,
      "Authorization": `Bearer ${c.adminJwt}`,
    },
  });
  const json = await res.json() as T;
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ── Query logic ───────────────────────────────────────────────────────────

async function queryAttestations(treasuryAddress: string): Promise<void> {
  console.log(`\nQuerying TrustSync attestations for treasury: ${treasuryAddress}`);
  console.log("─".repeat(72));

  let attestations: AttestationRecord[] = [];
  let listAvailable = true;

  try {
    // Try the list endpoint filtered by asset_contract_address
    const res = await get<ApiResponse<AttestationRecord[]>>(
      `/rwa/attestation/list?asset_contract_address=${encodeURIComponent(treasuryAddress)}`
    );
    attestations = res.data ?? [];
  } catch (err) {
    // If the list endpoint is unavailable, print a helpful fallback message
    listAvailable = false;
    console.log(
      "\nNote: list endpoint unavailable or not yet populated.",
      "\nTo query a specific attestation by ID, run:",
      `\n  curl -H "x-api-key: $INSTRUXI_API_KEY" \\`,
      `\n       ${cfg().baseUrl}/rwa/attestation/<ID>\n`
    );
    if (err instanceof Error) {
      console.log(`Detail: ${err.message}`);
    }
  }

  if (!listAvailable || attestations.length === 0) {
    if (listAvailable) {
      console.log("No attestations found for this treasury address.");
      console.log(
        "\nTip: Attestations are created automatically when Disbursed or Deposited",
        "\nevents are picked up by CRE Pipelines 3 & 4. Simulate first:\n",
        "\n  cre workflow simulate disaster-relief-workflow \\",
        "\n    --non-interactive --trigger-index 1 \\",
        "\n    --evm-tx-hash <DISBURSED_TX_HASH> --evm-event-index 0 \\",
        "\n    --target staging-settings"
      );
    }
    return;
  }

  console.log(`Found ${attestations.length} attestation(s):\n`);

  for (const a of attestations) {
    const amountDisplay = a.fractional_amount != null
      ? `${(a.fractional_amount / 1e6).toFixed(6)} ${a.fractional_unit ?? "USDC"}`
      : "—";
    console.log(`  ID:          ${a.id}`);
    console.log(`  Account:     ${a.account_address}`);
    console.log(`  Amount:      ${amountDisplay}`);
    console.log(`  Active:      ${a.active}`);
    console.log(`  Public:      ${a.public}`);
    console.log(`  Chain ID:    ${a.chain_id}`);
    if (a.created_at) {
      console.log(`  Created:     ${a.created_at}`);
    }
    console.log("  " + "─".repeat(68));
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const treasury = get("--treasury");

  if (!treasury) {
    console.error(
      "Usage: npm run query-attestations -- --treasury 0x<CONTRACT_ADDRESS>\n" +
      "\nRequired env vars: INSTRUXI_BASE_URL, INSTRUXI_API_KEY, INSTRUXI_ADMIN_JWT"
    );
    process.exit(1);
  }

  await queryAttestations(treasury);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
