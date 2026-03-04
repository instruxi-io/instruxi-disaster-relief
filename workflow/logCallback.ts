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
 *   "eligibility_registration":
 *     1. Decode eventId, candidate addresses[], claimed tiers[] from requestData
 *     2. For each candidate: POST /enforcer/auth/authorize (OPA policy check)
 *     3. Collect only the OPA-approved addresses and their claimed tiers
 *     4. Write result via onReport(metadata, 0x02 + abi.encode(requestId, approvedAddrs[], tiers[]))
 *     5. Contract stores _eligible[eventId][addr] = tier for each approved recipient
 *
 * After every fulfillment: notify RWA Gateway → TrustSync attestation side-effect
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

const EVENT_VERIFICATION_PARAMS  = parseAbiParameters("bytes32 eventId, string externalRef");
const ELIGIBILITY_PARAMS         = parseAbiParameters("bytes32 eventId, address[] recipients, uint8[] tiers");
const EVENT_VERIFICATION_REPORT_PARAMS = parseAbiParameters("bytes32, bool");
const ELIGIBILITY_REPORT_PARAMS        = parseAbiParameters("bytes32, address[], uint8[]");

// ── Report prefix bytes (must match ReliefTreasury Solidity constants) ────
const PREFIX_EVENT_VERIFICATION = "01" as const;
const PREFIX_ELIGIBILITY        = "02" as const;

// ── Types ─────────────────────────────────────────────────────────────────

interface ExternalRef {
  usgsId?: string;        // USGS earthquake event ID, e.g. "us7000abc"
  gdacsId?: string;       // GDACS event ID
  region?: string;        // ISO alpha-2 or alpha-3, e.g. "US"
  minMagnitude?: number;  // Minimum earthquake magnitude (default 4.5)
  eventDate?: string;     // ISO date string for time-window filtering
}

// ── Report encoding ───────────────────────────────────────────────────────

/** Encode an event verification report: prefix 0x01 + abi.encode(requestId, verified) */
function encodeEventVerificationReport(
  requestId: `0x${string}`,
  verified: boolean
): `0x${string}` {
  const payload = encodeAbiParameters(EVENT_VERIFICATION_REPORT_PARAMS, [requestId, verified]);
  return `0x${PREFIX_EVENT_VERIFICATION}${payload.slice(2)}` as `0x${string}`;
}

/**
 * Encode an eligibility registration report:
 * prefix 0x02 + abi.encode(requestId, approvedAddresses[], approvedTiers[])
 *
 * Only OPA-approved recipients are included. The contract stores
 * _eligible[eventId][addr] = tier for each entry.
 */
function encodeEligibilityReport(
  requestId: `0x${string}`,
  recipients: `0x${string}`[],
  tiers: number[]
): `0x${string}` {
  const payload = encodeAbiParameters(ELIGIBILITY_REPORT_PARAMS, [requestId, recipients, tiers]);
  return `0x${PREFIX_ELIGIBILITY}${payload.slice(2)}` as `0x${string}`;
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

// ── OPA eligibility check per recipient ──────────────────────────────────

/**
 * Check a single recipient's eligibility via OPA policy.
 *
 * Returns true if OPA approves. Throws on 5xx / 401 / 403 / network errors
 * so the DON retries the entire eligibility batch rather than silently skipping.
 * Returns false only on definitive 200 { allowed: false }.
 */
function checkRecipientEligibility(
  runtime: Runtime<WorkflowConfig>,
  recipient: string,
  eventId: string,
  apiKey: string
): boolean {
  const { baseUrl, policyId } = runtime.config.instruxi;
  const http = new cre.capabilities.HTTPCapability();

  runtime.log(`[OPA] Checking ${recipient} for eventId=${eventId}`);

  const authRes = http.request(runtime, {
    method: "POST",
    url: `${baseUrl}/enforcer/auth/authorize`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      policy_id: policyId,
      input: { action: "claim_disbursement", recipient, eventId },
    }),
  }).result();

  // 5xx = transient server error — throw so the DON retries
  if (authRes.statusCode >= 500) {
    throw new Error(`[OPA] Server error ${authRes.statusCode} for ${recipient} — DON will retry`);
  }
  // 401/403 = bad or expired API key — surface misconfiguration, not silent denial
  if (authRes.statusCode === 401 || authRes.statusCode === 403) {
    throw new Error(`[OPA] Auth error ${authRes.statusCode} — check INSTRUXI_API_KEY`);
  }

  const authBody = JSON.parse(authRes.body) as { allowed: boolean };
  runtime.log(`[OPA] ${recipient} → allowed=${authBody.allowed}`);
  return authBody.allowed;
}

// ── Notify RWA Gateway via CRE webhook ────────────────────────────────────

/**
 * After a CRE fulfillment is written onchain, notify the RWA Gateway.
 * The Gateway's webhook handler (POST /api/webhooks/cre) automatically
 * triggers TrustSync attestation creation as a side-effect.
 */
function notifyGateway(
  runtime: Runtime<WorkflowConfig>,
  payload: {
    requestId: string;
    requestType: "event_verification" | "eligibility_registration";
    txHash: string;
    result: boolean;
    eventId?: string;
    approvedCount?: number;
    totalCount?: number;
  }
): void {
  const rwGatewayUrl = runtime.config.instruxi.rwGatewayUrl;
  if (!rwGatewayUrl) {
    runtime.log("[Gateway] rwGatewayUrl not configured — skipping webhook");
    return;
  }

  try {
    const gatewayJwt = (runtime.secrets()["RWA_GATEWAY_JWT"] as string) ?? "";
    const http = new cre.capabilities.HTTPCapability();
    const res = http.request(runtime, {
      method: "POST",
      url: `${rwGatewayUrl}/api/webhooks/cre`,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${gatewayJwt}`,
      },
      body: JSON.stringify(payload),
    }).result();
    runtime.log(`[Gateway] CRE webhook → ${res.statusCode}`);
  } catch (err) {
    // Non-critical: log but do not fail the fulfillment
    runtime.log(`[Gateway] Webhook error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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

  // IMPORTANT — production use: always populate externalRef with a specific usgsId,
  // gdacsId, or region. An empty ref may pass verification via unrelated global
  // disaster activity (GDACS returns true for any active red alert worldwide).
  // Empty ref is only appropriate for local testing.
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
  const report  = encodeEventVerificationReport(requestId, verified);
  const txHash  = writeReport(runtime, report);
  runtime.log(`[Write] ✓ tx=${txHash}`);

  // Notify RWA Gateway — triggers TrustSync attestation creation
  const [, eventId] = decodeAbiParameters(EVENT_VERIFICATION_PARAMS, requestData);
  notifyGateway(runtime, {
    requestId,
    requestType: "event_verification",
    txHash,
    result: verified,
    eventId: eventId as string,
  });

  return `EventVerification: verified=${verified} tx=${txHash}`;
}

// ── Eligibility registration handler ─────────────────────────────────────

/**
 * Validate a candidate eligibility batch via OPA. Only approved recipients
 * are written onchain. This creates the onchain eligibility gate:
 * _eligible[eventId][addr] = tier for each approved address.
 *
 * The admin provides the candidate list (from processRoster output).
 * CRE — running on the Chainlink DON — independently validates each wallet
 * via OPA before writing to the contract. The admin cannot directly set
 * eligibility; only the CRE Forwarder (authorized fulfiller) can.
 */
function handleEligibilityRegistration(
  runtime: Runtime<WorkflowConfig>,
  requestId: `0x${string}`,
  requestData: `0x${string}`
): string {
  runtime.log("── Eligibility Registration ─────────────────────────────");

  let eventId   = "";
  let candidates: readonly unknown[] = [];
  let claimedTiers: readonly unknown[] = [];

  try {
    const [evId, recipients, tiers] = decodeAbiParameters(ELIGIBILITY_PARAMS, requestData);
    eventId      = evId as string;
    candidates   = recipients as readonly unknown[];
    claimedTiers = tiers     as readonly unknown[];
    runtime.log(`[Step 1] eventId=${eventId} candidates=${candidates.length}`);
  } catch (err) {
    // Corrupted requestData is unresolvable — throw so the DON retries
    runtime.log(`[Step 1] Decode error: ${err} — throwing so DON can retry`);
    throw err instanceof Error ? err : new Error(String(err));
  }

  const secrets = runtime.secrets();
  const apiKey  = (secrets["INSTRUXI_API_KEY"] as string) ?? "";

  const approvedRecipients: `0x${string}`[] = [];
  const approvedTiers: number[] = [];

  runtime.log(`[Step 2] OPA-validating ${candidates.length} candidates...`);
  for (let i = 0; i < candidates.length; i++) {
    const addr = candidates[i] as string;
    const tier = claimedTiers[i] as number;

    // Validate tier is in [1, 255]
    if (tier < 1 || tier > 255) {
      runtime.log(`[OPA] Skipping ${addr}: invalid tier=${tier}`);
      continue;
    }

    // OPA check: does this wallet have the claimed eligibility for this event?
    // Throws on 5xx/auth errors → DON retries entire batch.
    if (checkRecipientEligibility(runtime, addr, eventId, apiKey)) {
      approvedRecipients.push(addr as `0x${string}`);
      approvedTiers.push(tier);
    }
  }

  runtime.log(`[Result] approved=${approvedRecipients.length}/${candidates.length}`);

  const report = encodeEligibilityReport(requestId, approvedRecipients, approvedTiers);
  const txHash = writeReport(runtime, report);
  runtime.log(`[Write] ✓ tx=${txHash}`);

  // Notify RWA Gateway — triggers TrustSync eligibility attestation
  notifyGateway(runtime, {
    requestId,
    requestType: "eligibility_registration",
    txHash,
    result: approvedRecipients.length > 0,
    eventId,
    approvedCount: approvedRecipients.length,
    totalCount:    candidates.length,
  });

  return `EligibilityRegistration: ${approvedRecipients.length}/${candidates.length} approved tx=${txHash}`;
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

  if (requestType === "eligibility_registration") {
    return handleEligibilityRegistration(runtime, requestId, requestData);
  }

  runtime.log(`Unknown requestType "${requestType}" — no-op`);
  return `Skipped: unknown requestType ${requestType}`;
}
