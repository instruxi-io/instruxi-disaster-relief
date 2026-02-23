/**
 * logCallback.ts — CRE Log Trigger handler for ReliefTreasury RequestSent events
 *
 * Handles two request types:
 *
 *   "event_verification":
 *     1. Decode eventId and externalRef from requestData
 *     2. Query USGS Earthquake API  (Source 1)
 *     3. Query GDACS Disaster Feed  (Source 2)
 *     4. Query ReliefWeb Disasters  (Source 3)
 *     5. Apply 2-of-3 consensus rule
 *     6. Write result via onReport(metadata, 0x01 + abi.encode(requestId, verified))
 *
 *   "disbursement":
 *     1. Decode eventId and recipient address from requestData
 *     2. Query Instruxi Enforcer: GET /admin/groups/account/{address}/groups
 *     3. Check for eligibility group prefix match
 *     4. Write result via onReport(metadata, 0x02 + abi.encode(requestId, eligible))
 */

import {
  cre,
  type Runtime,
  type EVMLog,
  getNetwork,
  bytesToHex,
  hexToBase64,
  TxStatus,
} from "@chainlink/cre-sdk";
import {
  decodeEventLog,
  parseAbi,
  encodeAbiParameters,
  decodeAbiParameters,
  parseAbiParameters,
} from "viem";
import type { WorkflowConfig } from "./main";

// ── ABI definitions ───────────────────────────────────────────────────────

const REQUEST_SENT_ABI = parseAbi([
  "event RequestSent(bytes32 indexed requestId, address indexed requester, string requestType, bytes requestData)",
]);

// ── Typed abi parameter schemas ───────────────────────────────────────────

const EVENT_VERIFICATION_PARAMS = parseAbiParameters("bytes32 eventId, string externalRef");
const DISBURSEMENT_PARAMS        = parseAbiParameters("bytes32 eventId, address recipient");
const REPORT_PARAMS              = parseAbiParameters("bytes32, bool");

// ── Report prefix bytes (must match ReliefTreasury Solidity constants) ────
const PREFIX_EVENT_VERIFICATION = "01" as const;
const PREFIX_DISBURSEMENT        = "02" as const;

// ── Types ─────────────────────────────────────────────────────────────────

interface ExternalRef {
  usgsId?: string;        // USGS earthquake event ID, e.g. "us7000abc"
  gdacsId?: string;       // GDACS event ID
  region?: string;        // ISO alpha-2 or alpha-3, e.g. "US"
  minMagnitude?: number;  // Minimum earthquake magnitude (default 4.5)
  eventDate?: string;     // ISO date string for time-window filtering
}

// ── Report encoding ───────────────────────────────────────────────────────

function encodeReport(
  prefix: typeof PREFIX_EVENT_VERIFICATION | typeof PREFIX_DISBURSEMENT,
  requestId: `0x${string}`,
  result: boolean
): `0x${string}` {
  const payload = encodeAbiParameters(REPORT_PARAMS, [requestId, result]);
  return `0x${prefix}${payload.slice(2)}` as `0x${string}`;
}

// ── External data source checks ───────────────────────────────────────────

/** Source 1: USGS Earthquake Catalog API — free, no key required */
function checkUSGS(runtime: Runtime<WorkflowConfig>, ref: ExternalRef): boolean {
  if (!ref.usgsId) {
    runtime.log("[USGS] No usgsId provided — skipping");
    return false;
  }

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=${ref.usgsId}`;
  runtime.log(`[USGS] GET ${url}`);

  try {
    const http = new cre.capabilities.HTTPCapability();
    const res  = http.request(runtime, { method: "GET", url, headers: {} }).result();
    const body = JSON.parse(res.body) as {
      features?: Array<{ properties: { mag: number; status: string } }>;
    };

    if (!body.features?.length) {
      runtime.log("[USGS] Event not found → unconfirmed");
      return false;
    }

    const { mag, status } = body.features[0].properties;
    const minMag = ref.minMagnitude ?? 4.5;
    const ok = status === "reviewed" && mag >= minMag;
    runtime.log(`[USGS] mag=${mag} status=${status} minMag=${minMag} → ${ok}`);
    return ok;
  } catch (err) {
    runtime.log(`[USGS] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Source 2: GDACS API — global disaster alerts, free */
function checkGDACS(runtime: Runtime<WorkflowConfig>, ref: ExternalRef): boolean {
  const url =
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Red&eventlist=EQ,FL,TC&limit=20";
  runtime.log(`[GDACS] GET ${url}`);

  try {
    const http = new cre.capabilities.HTTPCapability();
    const res  = http.request(runtime, { method: "GET", url, headers: { Accept: "application/json" } }).result();
    const body = JSON.parse(res.body) as {
      features?: Array<{ properties: { eventid: number; iso3: string } }>;
    };

    if (!body.features?.length) {
      runtime.log("[GDACS] No active red alerts → unconfirmed");
      return false;
    }

    // Match by specific GDACS event ID if provided
    if (ref.gdacsId) {
      const found = body.features.some((f) => String(f.properties.eventid) === ref.gdacsId);
      runtime.log(`[GDACS] Event ${ref.gdacsId} found: ${found}`);
      return found;
    }

    // Match by region (ISO alpha-2/3)
    if (ref.region) {
      const r = ref.region.toUpperCase();
      const found = body.features.some((f) => f.properties.iso3?.includes(r));
      runtime.log(`[GDACS] Region ${r} alert found: ${found}`);
      return found;
    }

    // At least one global red alert confirms
    runtime.log(`[GDACS] ${body.features.length} active red alert(s) → confirmed`);
    return true;
  } catch (err) {
    runtime.log(`[GDACS] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Source 3: ReliefWeb Disasters API — OCHA data, free */
function checkReliefWeb(runtime: Runtime<WorkflowConfig>, ref: ExternalRef): boolean {
  const dateQ = ref.eventDate
    ? `&filter[conditions][0][field]=date.created&filter[conditions][0][value][from]=${encodeURIComponent(ref.eventDate + "T00:00:00+00:00")}`
    : "";
  const regionQ = ref.region
    ? `&filter[conditions][1][field]=primary_country.iso3&filter[conditions][1][value]=${ref.region}`
    : "";
  const url = `https://api.reliefweb.int/v1/disasters?appname=instruxi-disaster-relief${dateQ}${regionQ}&limit=5`;
  runtime.log(`[ReliefWeb] GET ${url}`);

  try {
    const http = new cre.capabilities.HTTPCapability();
    const res  = http.request(runtime, { method: "GET", url, headers: { Accept: "application/json" } }).result();
    const body = JSON.parse(res.body) as { data?: unknown[] };
    const count = body.data?.length ?? 0;
    runtime.log(`[ReliefWeb] ${count} matching disaster(s) → ${count > 0}`);
    return count > 0;
  } catch (err) {
    runtime.log(`[ReliefWeb] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 2-of-3 consensus: at least 2 sources must confirm */
function applyConsensus(
  runtime: Runtime<WorkflowConfig>,
  s: { usgs: boolean; gdacs: boolean; reliefweb: boolean }
): boolean {
  const votes = [s.usgs, s.gdacs, s.reliefweb].filter(Boolean).length;
  runtime.log(`[Consensus] USGS=${s.usgs} GDACS=${s.gdacs} ReliefWeb=${s.reliefweb} → ${votes}/3`);
  return votes >= 2;
}

// ── Instruxi Enforcer eligibility check ──────────────────────────────────

function checkEnforcerEligibility(
  runtime: Runtime<WorkflowConfig>,
  recipient: string
): boolean {
  const { baseUrl, eligibilityGroupPrefix } = runtime.config.instruxi;
  const url = `${baseUrl}/admin/groups/account/${recipient}/groups`;
  runtime.log(`[Enforcer] GET ${url}`);

  try {
    const http = new cre.capabilities.HTTPCapability();
    const res  = http.request(runtime, {
      method: "GET",
      url,
      headers: {
        Accept: "application/json",
        // API key injected from secrets.yaml at CRE runtime via environment
      },
    }).result();

    const body = JSON.parse(res.body) as { success?: boolean; data?: string[] };
    if (!body.success || !Array.isArray(body.data)) {
      runtime.log("[Enforcer] Unexpected response format → ineligible");
      return false;
    }

    const eligible = body.data.some((g) => g.startsWith(eligibilityGroupPrefix));
    runtime.log(
      `[Enforcer] ${body.data.length} group(s). Prefix "${eligibilityGroupPrefix}" match: ${eligible}`
    );
    return eligible;
  } catch (err) {
    runtime.log(`[Enforcer] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Write report to ReliefTreasury ────────────────────────────────────────

function writeReport(
  runtime: Runtime<WorkflowConfig>,
  reportData: `0x${string}`
): string {
  const cfg = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`Unknown CRE network: ${cfg.chainSelectorName}`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: cfg.reliefTreasuryAddress,
      report: reportResponse,
      gasConfig: { gasLimit: cfg.gasLimit },
    })
    .result();

  if (writeResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`onReport tx failed: ${writeResult.txStatus}`);
  }

  return bytesToHex(writeResult.txHash || new Uint8Array(32));
}

// ── Event verification handler ────────────────────────────────────────────

function handleEventVerification(
  runtime: Runtime<WorkflowConfig>,
  requestId: `0x${string}`,
  requestData: `0x${string}`
): string {
  runtime.log("── Event Verification ──────────────────────────────────");

  let externalRef: ExternalRef = {};

  try {
    const [, externalRefStr] = decodeAbiParameters(EVENT_VERIFICATION_PARAMS, requestData);
    externalRef = JSON.parse(externalRefStr as string) as ExternalRef;
    runtime.log(`[Step 2] externalRef: ${JSON.stringify(externalRef)}`);
  } catch (err) {
    runtime.log(`[Step 2] Decode error: ${err} — defaulting to empty ref`);
  }

  runtime.log("── Querying External Data Sources ──────────────────────");
  const usgs      = checkUSGS(runtime, externalRef);
  const gdacs     = checkGDACS(runtime, externalRef);
  const reliefweb = checkReliefWeb(runtime, externalRef);
  const verified  = applyConsensus(runtime, { usgs, gdacs, reliefweb });

  runtime.log(`[Result] verified=${verified}`);
  const report  = encodeReport(PREFIX_EVENT_VERIFICATION, requestId, verified);
  const txHash  = writeReport(runtime, report);
  runtime.log(`[Write] ✓ tx=${txHash}`);
  return `EventVerification: verified=${verified} tx=${txHash}`;
}

// ── Disbursement handler ──────────────────────────────────────────────────

function handleDisbursement(
  runtime: Runtime<WorkflowConfig>,
  requestId: `0x${string}`,
  requestData: `0x${string}`
): string {
  runtime.log("── Disbursement Eligibility Check ──────────────────────");

  let recipient = "";

  try {
    const [, addr] = decodeAbiParameters(DISBURSEMENT_PARAMS, requestData);
    recipient = addr as string;
    runtime.log(`[Step 2] recipient: ${recipient}`);
  } catch (err) {
    runtime.log(`[Step 2] Decode error: ${err}`);
    const report = encodeReport(PREFIX_DISBURSEMENT, requestId, false);
    const txHash = writeReport(runtime, report);
    return `Disbursement: decode error tx=${txHash}`;
  }

  const eligible = checkEnforcerEligibility(runtime, recipient);
  runtime.log(`[Result] eligible=${eligible}`);

  const report = encodeReport(PREFIX_DISBURSEMENT, requestId, eligible);
  const txHash = writeReport(runtime, report);
  runtime.log(`[Write] ✓ tx=${txHash}`);
  return `Disbursement: eligible=${eligible} tx=${txHash}`;
}

// ── Main log trigger callback ─────────────────────────────────────────────

/**
 * Entrypoint for CRE EVM Log Trigger.
 * Called for every RequestSent event emitted by ReliefTreasury.
 */
export function onRequestSent(runtime: Runtime<WorkflowConfig>, log: EVMLog): string {
  runtime.log("═══════════════════════════════════════════════════════");
  runtime.log("CRE: DisasterRelief — RequestSent");
  runtime.log("═══════════════════════════════════════════════════════");

  // Decode the RequestSent event
  const topics = log.topics.map((t: Uint8Array) => bytesToHex(t)) as [
    `0x${string}`,
    ...`0x${string}`[]
  ];
  const data = bytesToHex(log.data);

  const decoded = decodeEventLog({ abi: REQUEST_SENT_ABI, data, topics });
  const requestId   = decoded.args.requestId   as `0x${string}`;
  const requester   = decoded.args.requester   as string;
  const requestType = decoded.args.requestType as string;
  const requestData = decoded.args.requestData as `0x${string}`;

  runtime.log(`requestId:   ${requestId}`);
  runtime.log(`requester:   ${requester}`);
  runtime.log(`requestType: ${requestType}`);

  if (requestType === "event_verification") {
    return handleEventVerification(runtime, requestId, requestData);
  }

  if (requestType === "disbursement") {
    return handleDisbursement(runtime, requestId, requestData);
  }

  runtime.log(`Unknown requestType "${requestType}" — no-op`);
  return `Skipped: unknown requestType ${requestType}`;
}
