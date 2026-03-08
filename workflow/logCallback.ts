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
 *     2. For each candidate: POST /auth/authorize (OPA policy check)
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

const DISBURSED_ABI = parseAbi([
  "event Disbursed(bytes32 indexed eventId, address indexed recipient, uint256 amount)",
]);

const DEPOSITED_ABI = parseAbi([
  "event Deposited(address indexed depositor, uint256 amount)",
]);

// ── Typed abi parameter schemas ───────────────────────────────────────────

const EVENT_VERIFICATION_PARAMS  = parseAbiParameters("bytes32 eventId, string externalRef");
const ELIGIBILITY_PARAMS         = parseAbiParameters("bytes32 eventId, address[] recipients, uint8[] tiers");
const EVENT_VERIFICATION_REPORT_PARAMS = parseAbiParameters("bytes32, bool");
const ELIGIBILITY_REPORT_PARAMS        = parseAbiParameters("bytes32, address[], uint8[]");

// ── Report prefix bytes (must match ReliefTreasury Solidity constants) ────
const PREFIX_EVENT_VERIFICATION = "01" as const;
const PREFIX_ELIGIBILITY        = "02" as const;

// ── Base64 helper (btoa is not available in the CRE WASM runtime) ─────────
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const hex = `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  return hexToBase64(hex);
}

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
    const http = new cre.capabilities.HTTPClient();
    const res  = http.sendRequest(runtime, { method: "GET", url, headers: {} }).result();
    const body = JSON.parse(new TextDecoder().decode(res.body)) as {
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
    const http = new cre.capabilities.HTTPClient();
    const res  = http.sendRequest(runtime, { method: "GET", url, headers: { Accept: "application/json" } }).result();
    const body = JSON.parse(new TextDecoder().decode(res.body)) as {
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

/** Source 3: NASA EONET (Earth Observatory Natural Event Tracker) — free, no key required */
function checkEONET(runtime: Runtime<WorkflowConfig>, ref: ExternalRef): boolean {
  // Query open natural events; optionally filter by category (floods=9, severe storms=10, wildfires=8)
  const categoryQ = ref.region ? "" : ""; // EONET doesn't filter by country — global open events confirm ongoing disasters
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=5${categoryQ}`;
  runtime.log(`[EONET] GET ${url}`);

  try {
    const http = new cre.capabilities.HTTPClient();
    const res  = http.sendRequest(runtime, { method: "GET", url, headers: { Accept: "application/json" } }).result();
    const body = JSON.parse(new TextDecoder().decode(res.body)) as { events?: unknown[] };
    const count = body.events?.length ?? 0;
    runtime.log(`[EONET] ${count} open natural event(s) → ${count > 0}`);
    return count > 0;
  } catch (err) {
    runtime.log(`[EONET] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 2-of-3 consensus: at least 2 sources must confirm */
function applyConsensus(
  runtime: Runtime<WorkflowConfig>,
  s: { usgs: boolean; gdacs: boolean; eonet: boolean }
): boolean {
  const votes = [s.usgs, s.gdacs, s.eonet].filter(Boolean).length;
  runtime.log(`[Consensus] USGS=${s.usgs} GDACS=${s.gdacs} EONET=${s.eonet} → ${votes}/3`);
  return votes >= 2;
}

// ── OPA eligibility check per recipient ──────────────────────────────────

/**
 * Check a single recipient's eligibility via OPA policy.
 *
 * Returns true if OPA approves. Throws on 5xx / 401 / 403 / network errors
 * so the DON retries the entire eligibility batch rather than silently skipping.
 * Returns false only on definitive 200 { allow: false }.
 */
function checkRecipientEligibility(
  runtime: Runtime<WorkflowConfig>,
  recipient: string,
  eventId: string,
  apiKey: string
): boolean {
  const { baseUrl, policyId } = runtime.config.instruxi;
  const http = new cre.capabilities.HTTPClient();

  runtime.log(`[OPA] Checking ${recipient} for eventId=${eventId}`);

  const authRes = http.sendRequest(runtime, {
    method: "POST",
    url: `${baseUrl}/auth/authorize`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: toBase64(JSON.stringify({
      policy_id: policyId,
      input: { action: "claim_disbursement", recipient, eventId },
    })),
  }).result();

  // 5xx = transient server error — throw so the DON retries
  if (authRes.statusCode >= 500) {
    throw new Error(`[OPA] Server error ${authRes.statusCode} for ${recipient} — DON will retry`);
  }
  // 401/403 = bad or expired API key — surface misconfiguration, not silent denial
  if (authRes.statusCode === 401 || authRes.statusCode === 403) {
    throw new Error(`[OPA] Auth error ${authRes.statusCode} — check INSTRUXI_API_KEY`);
  }

  const authBody = JSON.parse(new TextDecoder().decode(authRes.body)) as { allow: boolean };
  runtime.log(`[OPA] ${recipient} → allow=${authBody.allow}`);
  return authBody.allow;
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
    const gatewayJwt = runtime.getSecret({ id: "INSTRUXI_ADMIN_JWT" }).result().value ?? "";
    const http = new cre.capabilities.HTTPClient();
    const res = http.sendRequest(runtime, {
      method: "POST",
      url: `${rwGatewayUrl}/api/webhooks/cre`,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${gatewayJwt}`,
      },
      body: toBase64(JSON.stringify(payload)),
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
  const eonet    = checkEONET(runtime, externalRef);
  const verified = applyConsensus(runtime, { usgs, gdacs, eonet });

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

  const apiKey = runtime.getSecret({ id: "INSTRUXI_API_KEY" }).result().value ?? "";

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
    // If policyId is empty, skip OPA and approve all candidates —
    // security falls back to admin-controlled processRoster provisioning.
    const policyId = runtime.config.instruxi.policyId;
    if (!policyId || checkRecipientEligibility(runtime, addr, eventId, apiKey)) {
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

// ── Instruxi attestation helpers (direct API — no onchain write) ──────────

/**
 * Create a TrustSync attestation via the RWA Gateway.
 * POST /api/attestations
 * Returns the attestation ID string.
 * Throws on 5xx (DON retries) or 401/403 (misconfiguration).
 */
function createInstruxiAttestation(
  runtime: Runtime<WorkflowConfig>,
  attestationType: "net_asset_value" | "proof_of_reserve",
  message: Record<string, unknown>
): string {
  const { rwGatewayUrl, contractDeploymentId, } = runtime.config.instruxi;
  const adminJwt = runtime.getSecret({ id: "INSTRUXI_ADMIN_JWT" }).result().value ?? "";

  const primaryType = attestationType === "net_asset_value" ? "NAVAttestation" : "PORAttestation";
  const navFields = [
    { name: "contractAddress",    type: "address" },
    { name: "navContractAddress", type: "address" },
    { name: "decimals",           type: "uint8"   },
    { name: "amount",             type: "uint256" },
    { name: "cumulativeAmount",   type: "uint256" },
    { name: "validFrom",          type: "string"  },
    { name: "validTo",            type: "string"  },
    { name: "nonce",              type: "string"  },
  ];
  const porFields = [
    { name: "contractAddress",    type: "address" },
    { name: "porContractAddress", type: "address" },
    { name: "decimals",           type: "uint8"   },
    { name: "amount",             type: "uint256" },
    { name: "cumulativeAmount",   type: "uint256" },
    { name: "validFrom",          type: "string"  },
    { name: "validTo",            type: "string"  },
    { name: "nonce",              type: "string"  },
  ];

  const eip712Data = {
    types:       { [primaryType]: attestationType === "net_asset_value" ? navFields : porFields },
    primaryType,
    domain:      { name: "InstruxiAttestation", version: "1", chainId: String(runtime.config.chainId) },
    message,
  };

  const body = {
    contract_deployment_id: contractDeploymentId,
    attestation_type: attestationType,
    attestor_name: "Instruxi Relief Treasury",
    attestation_data: JSON.stringify(eip712Data),
    active: true,
  };

  const http = new cre.capabilities.HTTPClient();
  const res = http.sendRequest(runtime, {
    method: "POST",
    url: `${rwGatewayUrl}/api/attestations`,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${adminJwt}`,
    },
    body: toBase64(JSON.stringify(body)),
  }).result();

  if (res.statusCode >= 500) {
    throw new Error(`[Attestation] Server error ${res.statusCode} — DON will retry`);
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new Error(`[Attestation] Auth error ${res.statusCode} — check INSTRUXI_ADMIN_JWT`);
  }

  const bodyStr = new TextDecoder().decode(res.body);
  const parsed = JSON.parse(bodyStr) as { data?: { id?: string; attestation_id?: string }; success?: boolean };
  const id = parsed.data?.id ?? parsed.data?.attestation_id ?? "";
  if (!id) throw new Error(`[Attestation] createAttestation returned no id: ${bodyStr}`);
  return id;
}

/**
 * Publish an attestation (make it publicly visible).
 * POST /api/attestations/publish
 * Throws on 5xx so the DON retries.
 */
function publishInstruxiAttestation(
  runtime: Runtime<WorkflowConfig>,
  attestationId: string
): void {
  const { rwGatewayUrl } = runtime.config.instruxi;
  const adminJwt = runtime.getSecret({ id: "INSTRUXI_ADMIN_JWT" }).result().value ?? "";

  const http = new cre.capabilities.HTTPClient();
  const res = http.sendRequest(runtime, {
    method: "POST",
    url: `${rwGatewayUrl}/api/attestations/publish`,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${adminJwt}`,
    },
    body: toBase64(JSON.stringify({ id: attestationId })),
  }).result();

  if (res.statusCode >= 500) {
    throw new Error(`[Attestation] Publish server error ${res.statusCode} — DON will retry`);
  }
  runtime.log(`[Attestation] Published id=${attestationId} status=${res.statusCode}`);
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

// ── Disbursed handler (Pipeline 3) ────────────────────────────────────────

/**
 * Entrypoint for CRE EVM Log Trigger on Disbursed events.
 * Creates and publishes a proof-of-disbursement TrustSync attestation.
 * No onchain write — pure offchain side-effect.
 */
export function onDisbursed(runtime: Runtime<WorkflowConfig>, log: EVMLog): string {
  runtime.log("═══════════════════════════════════════════════════════");
  runtime.log("CRE: DisasterRelief — Disbursed (Pipeline 3)");
  runtime.log("═══════════════════════════════════════════════════════");

  const topics = log.topics.map((t: Uint8Array) => bytesToHex(t)) as [
    `0x${string}`,
    ...`0x${string}`[]
  ];
  const data = bytesToHex(log.data);

  const decoded = decodeEventLog({ abi: DISBURSED_ABI, data, topics });
  const recipient = decoded.args.recipient as string;
  const amount    = decoded.args.amount    as bigint;

  runtime.log(`recipient: ${recipient}`);
  runtime.log(`amount:    ${amount} (raw USDC units)`);

  const cfg = runtime.config;

  const now = new Date();
  const attestationId = createInstruxiAttestation(runtime, "proof_of_reserve", {
    contractAddress:    cfg.reliefTreasuryAddress,
    porContractAddress: cfg.usdcAddress,
    decimals:           6,
    amount:             String(amount),
    cumulativeAmount:   String(amount),
    validFrom:          now.toISOString(),
    validTo:            new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    nonce:              `cre-disbursement-${recipient}-${now.getTime()}`,
  });

  runtime.log(`[Attestation] Created proof-of-disbursement id=${attestationId}`);
  publishInstruxiAttestation(runtime, attestationId);

  const display = `${Number(amount) / 1e6} USDC`;
  return `DisbursementAttestation: recipient=${recipient} amount=${display} id=${attestationId}`;
}

// ── Deposited handler (Pipeline 4) ───────────────────────────────────────

/**
 * Entrypoint for CRE EVM Log Trigger on Deposited events.
 * Creates and publishes a proof-of-funds TrustSync attestation.
 * No onchain write — pure offchain side-effect.
 */
export function onDeposited(runtime: Runtime<WorkflowConfig>, log: EVMLog): string {
  runtime.log("═══════════════════════════════════════════════════════");
  runtime.log("CRE: DisasterRelief — Deposited (Pipeline 4)");
  runtime.log("═══════════════════════════════════════════════════════");

  const topics = log.topics.map((t: Uint8Array) => bytesToHex(t)) as [
    `0x${string}`,
    ...`0x${string}`[]
  ];
  const data = bytesToHex(log.data);

  const decoded = decodeEventLog({ abi: DEPOSITED_ABI, data, topics });
  const depositor = decoded.args.depositor as string;
  const amount    = decoded.args.amount    as bigint;

  runtime.log(`depositor: ${depositor}`);
  runtime.log(`amount:    ${amount} (raw USDC units)`);

  const cfg = runtime.config;

  const now = new Date();
  const attestationId = createInstruxiAttestation(runtime, "net_asset_value", {
    contractAddress:    cfg.reliefTreasuryAddress,
    navContractAddress: cfg.usdcAddress,
    decimals:           6,
    amount:             String(amount),
    cumulativeAmount:   String(amount),
    validFrom:          now.toISOString(),
    validTo:            new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    nonce:              `cre-deposit-${depositor}-${now.getTime()}`,
  });

  runtime.log(`[Attestation] Created proof-of-funds id=${attestationId}`);
  publishInstruxiAttestation(runtime, attestationId);

  const display = `${Number(amount) / 1e6} USDC`;
  return `DepositAttestation: depositor=${depositor} amount=${display} id=${attestationId}`;
}
