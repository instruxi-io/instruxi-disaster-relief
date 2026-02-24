/**
 * instruxi.ts
 *
 * Typed HTTP client for the Instruxi API (api.instruxi.io).
 * Covers every endpoint used by the disaster-relief pipeline:
 *   - Enforcer: register, exists, authorize, groups
 *   - Profile: multi-create
 *   - Object Storage: upload, metadata, presigned-url, move
 *   - RWA attestations: create, publish, batches, link, validate, metrics
 *
 * Auth: x-api-key header for storage/attestation endpoints;
 *       Authorization: Bearer <jwt> for group/profile admin endpoints.
 *
 * All functions throw on non-2xx responses.
 */

// ── Config ────────────────────────────────────────────────────────────────

export interface InstruxiConfig {
  baseUrl: string;       // e.g. https://api.instruxi.io
  apiKey: string;        // INSTRUXI_API_KEY (x-api-key header)
  adminJwt: string;      // INSTRUXI_ADMIN_JWT (Bearer token for admin ops)
  tenantId: string;      // INSTRUXI_TENANT_ID
}

function cfg(): InstruxiConfig {
  return {
    baseUrl:  process.env.INSTRUXI_BASE_URL  || "https://api.instruxi.io",
    apiKey:   process.env.INSTRUXI_API_KEY   || "",
    adminJwt: process.env.INSTRUXI_ADMIN_JWT || "",
    tenantId: process.env.INSTRUXI_TENANT_ID || "",
  };
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const c = cfg();
  const url = `${c.baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": c.apiKey,
    "Authorization": `Bearer ${c.adminJwt}`,
    ...extraHeaders,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json() as T;
  if (!res.ok) {
    throw new Error(`Instruxi ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ── Response types ────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface GroupRecord {
  id: string;
  name: string;
  tenant_id: string;
  note?: string;
}

export interface AttestationRecord {
  id: string;
  account_address: string;
  asset_contract_address: string;
  fractional_amount: number;
  fractional_unit: string;
  chain_id: number;
  public: boolean;
  active: boolean;
}

export interface AttestationBatch {
  id: string;
  asset_contract_address: string;
  total_amount: number;
  auditor_account_address: string;
}

// ── Enforcer: Account ─────────────────────────────────────────────────────

/**
 * Check whether an Enforcer account exists for a wallet address.
 * GET /enforcer/account/exists/{account_address}
 */
export async function accountExists(address: string): Promise<boolean> {
  const res = await req<ApiResponse<{ exists: boolean }>>(
    "GET", `/enforcer/account/exists/${address}`
  );
  return !!(res.data?.exists);
}

/**
 * Register a new Enforcer account.
 * POST /enforcer/auth/account/register
 *
 * @param address  Wallet address
 * @param email    Email address (required by Enforcer)
 * @param signature ECDSA signature — use service key for backend registration
 * @param opts     Optional fields: first_name, last_name, phone_number, username, tenant_code
 */
export async function registerAccount(
  address: string,
  email: string,
  signature: string,
  opts: {
    first_name?: string;
    last_name?: string;
    phone_number?: string;
    username?: string;
    tenant_code?: string;
  } = {}
): Promise<ApiResponse> {
  return req("POST", "/enforcer/auth/account/register", {
    account_address: address,
    email,
    signature,
    ...opts,
  });
}

// ── Enforcer: Auth ────────────────────────────────────────────────────────

/**
 * Authorize an action on a resource via OPA Rego policy.
 * POST /enforcer/auth/authorize
 * Returns the full OPA response (always contains at minimum { allowed: boolean })
 */
export async function authorize(
  policyId: string,
  input: Record<string, unknown>
): Promise<ApiResponse<Record<string, unknown>>> {
  return req<ApiResponse<Record<string, unknown>>>(
    "POST", "/enforcer/auth/authorize",
    { policy_id: policyId, input }
  );
}

/**
 * Batch authorize multiple actions.
 * POST /enforcer/auth/authorize/batch
 */
export async function authorizeBatch(
  policyId: string,
  requests: Array<Record<string, unknown>>,
  contexts?: Array<Record<string, unknown>>
): Promise<ApiResponse<unknown[]>> {
  return req("POST", "/enforcer/auth/authorize/batch", {
    policy_id: policyId,
    requests,
    ...(contexts ? { contexts } : {}),
  });
}

// ── Enforcer: Groups ──────────────────────────────────────────────────────

/**
 * Create a new Enforcer group.
 * POST /admin/groups/create
 */
export async function createGroup(
  name: string,
  note?: string
): Promise<ApiResponse<GroupRecord>> {
  return req("POST", "/admin/groups/create", {
    name,
    tenant_id: cfg().tenantId,
    ...(note ? { note } : {}),
  });
}

/**
 * Add a single account to a single group.
 * POST /admin/groups/add-account
 */
export async function addAccountToGroup(
  accountAddress: string,
  groupId: string
): Promise<ApiResponse> {
  return req("POST", "/admin/groups/add-account", {
    account_address: accountAddress,
    group_id: groupId,
  });
}

/**
 * Add a single account to multiple groups in one call.
 * POST /admin/groups/account/add-multiple
 */
export async function addAccountToGroups(
  accountAddress: string,
  groupIds: string[]
): Promise<ApiResponse> {
  return req("POST", "/admin/groups/account/add-multiple", {
    account_address: accountAddress,
    group_ids: groupIds,
  });
}

/**
 * Get all groups a wallet address belongs to.
 * GET /admin/groups/account/{account_address}/groups
 * Returns array of group name strings in data.
 */
export async function getAccountGroups(address: string): Promise<string[]> {
  const res = await req<ApiResponse<string[]>>(
    "GET", `/admin/groups/account/${address}/groups`
  );
  return res.data ?? [];
}

/**
 * Remove an account from a group.
 * POST /admin/groups/remove-account
 */
export async function removeAccountFromGroup(
  accountAddress: string,
  groupId: string
): Promise<ApiResponse> {
  return req("POST", "/admin/groups/remove-account", {
    account_address: accountAddress,
    group_id: groupId,
  });
}

// ── Profile ───────────────────────────────────────────────────────────────

export interface RawAccount {
  account_address: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  username?: string;
  tenant_id?: string;
}

/**
 * Batch-create profiles for multiple accounts.
 * POST /profile/multi-create
 */
export async function multiCreateProfiles(
  accounts: RawAccount[]
): Promise<ApiResponse<RawAccount[]>> {
  return req("POST", "/profile/multi-create", { accounts });
}

// ── Object Storage ────────────────────────────────────────────────────────

/**
 * Upload a file to Instruxi Object Storage.
 * POST /os/file/upload  (multipart/form-data)
 *
 * @param fileBuffer  File content as Buffer
 * @param fileName    File name (e.g. "roster-2026-001.csv")
 * @param fileType    MIME type (e.g. "text/csv")
 * @param policyId    Optional Enforcer policy ID for access gating
 * @returns           Object with file_id
 */
export async function uploadFile(
  fileBuffer: Buffer,
  fileName: string,
  fileType: string,
  policyId?: string
): Promise<{ file_id: string }> {
  const c = cfg();
  const form = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: fileType });
  form.append("file", blob, fileName);
  form.append("file_name", fileName);
  form.append("file_type", fileType);
  if (policyId) form.append("policy_id", policyId);

  const res = await fetch(`${c.baseUrl}/os/file/upload`, {
    method: "POST",
    headers: {
      "x-api-key": c.apiKey,
      "Authorization": `Bearer ${c.adminJwt}`,
    },
    body: form,
  });

  const json = await res.json() as { file_id: string };
  if (!res.ok) throw new Error(`uploadFile → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/**
 * Update metadata for an uploaded file.
 * POST /os/file/metadata
 */
export async function updateFileMetadata(
  fileId: string,
  opts: {
    file_type?: string;
    policy_id?: number;
    status?: string;
    version?: string;
  }
): Promise<ApiResponse> {
  return req("POST", "/os/file/metadata", { file_id: fileId, ...opts });
}

/**
 * Generate a presigned download URL for a file.
 * GET /storage/file/presigned-url?file_id={id}&expire={seconds}
 */
export async function getPresignedUrl(
  fileId: string,
  expireSeconds = 3600
): Promise<string> {
  const c = cfg();
  const url = `${c.baseUrl}/storage/file/presigned-url?file_id=${encodeURIComponent(fileId)}&expire=${expireSeconds}`;
  const res = await fetch(url, {
    headers: { "x-api-key": c.apiKey },
  });
  const json = await res.json() as ApiResponse<string>;
  if (!res.ok) throw new Error(`getPresignedUrl → ${res.status}: ${JSON.stringify(json)}`);
  return json.data as string;
}

/**
 * Move/archive a file to a different path/bucket.
 * POST /storage/file/move
 */
export async function moveFile(
  fileId: string,
  destinationPath: string
): Promise<ApiResponse> {
  return req("POST", "/storage/file/move", {
    file_id: fileId,
    destination_path: destinationPath,
  });
}

// ── RWA Attestations ──────────────────────────────────────────────────────

export interface CreateAttestationInput {
  account_address: string;
  asset_contract_address: string;       // ReliefTreasury address
  fractional_amount: number;            // USDC balance (in token units)
  fractional_decimals: number;          // 6 for USDC
  fractional_token_contract_address: string; // USDC contract address
  fractional_unit: string;              // "USDC"
  token_id: number;                     // 0 for treasury attestation
  chain_id?: number;
  blockchain_id?: string;
  attestation_batch_id?: string;
  public?: boolean;
  active?: boolean;
}

/**
 * Create a TrustSync attestation (proof-of-funds or proof-of-disbursement).
 * POST /rwa/attestation/create
 */
export async function createAttestation(
  input: CreateAttestationInput
): Promise<ApiResponse<{ id: string }>> {
  return req("POST", "/rwa/attestation/create", input);
}

/**
 * Publish an attestation (make it publicly visible).
 * POST /rwa/attestation/publish
 */
export async function publishAttestation(id: string): Promise<ApiResponse> {
  return req("POST", "/rwa/attestation/publish", { id });
}

export interface CreateBatchInput {
  asset_contract_address: string;
  fractional_token_contract_address: string;
  total_amount: number;
  audit_timestamp: string;              // ISO string
  auditor_account_address: string;
  auditor_signature: string;
  chain_id?: number;
  blockchain_id?: string;
  active?: boolean;
}

/**
 * Create an attestation batch (groups multiple disbursement proofs).
 * POST /rwa/attestation-batches
 */
export async function createAttestationBatch(
  input: CreateBatchInput
): Promise<ApiResponse<{ id: string }>> {
  return req("POST", "/rwa/attestation-batches", input);
}

/**
 * Link unlinked attestations into a batch.
 * POST /rwa/attestation-batches/{id}/link
 */
export async function linkAttestationsToBatch(
  batchId: string
): Promise<ApiResponse> {
  return req("POST", `/rwa/attestation-batches/${batchId}/link`);
}

/**
 * Validate that attestation totals match the batch total.
 * GET /rwa/attestation-batches/{id}/validate
 */
export async function validateAttestationBatch(
  batchId: string
): Promise<ApiResponse<{ valid: boolean; total: number }>> {
  return req("GET", `/rwa/attestation-batches/${batchId}/validate`);
}

/**
 * Get metrics summary for an attestation batch.
 * GET /rwa/attestation-batches/{id}/metrics
 */
export async function getAttestationBatchMetrics(
  batchId: string
): Promise<ApiResponse<Record<string, unknown>>> {
  return req("GET", `/rwa/attestation-batches/${batchId}/metrics`);
}
