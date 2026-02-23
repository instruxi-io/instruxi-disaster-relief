/**
 * gateway.ts
 *
 * Typed HTTP client for the Instruxi RWA Gateway service.
 * Covers:
 *   - POST /api/webhooks/cre   — CRE fulfillment notification (triggers attestation)
 *   - GET  /api/webhooks/cre/health
 *   - POST /api/attestations   — Create attestation (Gateway-side, BearerAuth)
 *   - POST /api/attestations/publish
 */

export interface GatewayConfig {
  gatewayUrl: string;    // e.g. https://gateway.instruxi.io
  gatewayJwt: string;    // RWA_GATEWAY_JWT (Bearer token)
}

function cfg(): GatewayConfig {
  return {
    gatewayUrl: process.env.RWA_GATEWAY_URL || "",
    gatewayJwt: process.env.RWA_GATEWAY_JWT || "",
  };
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const c = cfg();
  if (!c.gatewayUrl) throw new Error("RWA_GATEWAY_URL env var is not set");

  const res = await fetch(`${c.gatewayUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${c.gatewayJwt}`,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json() as T;
  if (!res.ok) {
    throw new Error(`Gateway ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ── CRE Webhook ───────────────────────────────────────────────────────────

export interface CREWebhookPayload {
  requestId: string;
  requestType: "event_verification" | "disbursement";
  txHash: string;
  result: boolean;
  // disbursement-specific
  eventId?: string;
  recipient?: string;
  amount?: string;        // hex string of USDC amount (6 decimals)
  // event-verification-specific
  verifiedEventId?: string;
}

/**
 * Notify the RWA Gateway that a CRE fulfillment occurred onchain.
 * The Gateway's webhook handler automatically creates TrustSync attestations
 * as a side-effect of disbursement.
 *
 * POST /api/webhooks/cre
 */
export async function notifyCREWebhook(
  payload: CREWebhookPayload
): Promise<{ success: boolean }> {
  return req("POST", "/api/webhooks/cre", payload);
}

/**
 * Check RWA Gateway CRE webhook health.
 * GET /api/webhooks/cre/health
 */
export async function checkWebhookHealth(): Promise<{ status: string }> {
  return req("GET", "/api/webhooks/cre/health");
}

// ── Gateway Attestations ──────────────────────────────────────────────────

export interface GatewayCreateAttestationInput {
  attestation_data: string;           // JSON-encoded proof data
  attestation_type: string;           // e.g. "proof-of-funds", "proof-of-disbursement"
  attestor_name: string;              // e.g. "Instruxi Relief Treasury"
  contract_deployment_id: number;     // ID of the contract deployment record
  attestor_entity?: string;
  attestor_wallet_address?: string;
  nonce?: string;
  signature?: string;
  signer_chain_id?: number;
  active?: boolean;
}

/**
 * Create an attestation via the RWA Gateway (admin only, BearerAuth).
 * POST /api/attestations
 */
export async function createGatewayAttestation(
  input: GatewayCreateAttestationInput
): Promise<{ data: { attestation_id: string }; success: boolean }> {
  return req("POST", "/api/attestations", input);
}

/**
 * Publish an attestation via the RWA Gateway (owner only).
 * POST /api/attestations/publish
 */
export async function publishGatewayAttestation(id: number): Promise<{ message: string; success: boolean }> {
  return req("POST", "/api/attestations/publish", { id });
}
