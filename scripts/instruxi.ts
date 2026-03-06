/**
 * instruxi.ts
 *
 * Typed HTTP client for the Instruxi API stack.
 *
 * Enforcer-v2  (enforcer-v2-dev.instruxi.dev/api/v1/enforcer):
 *   - Auth: register, authorize (OPA)
 *   - Admin Groups: create, add user, batch add, list, remove
 *   - Storage (Storj): upload, presigned-url, move
 *
 * RWA Gateway (rwa-gateway.instruxi.dev):
 *   - Attestations: create, publish
 *   - CRE webhook: notify
 *
 * Auth: Authorization: Bearer <adminJwt> on all requests.
 *       x-api-key accepted as alternative on some endpoints.
 *
 * IMPORTANT — User IDs in enforcer-v2:
 *   Group operations use UUID user IDs, not wallet addresses.
 *   Obtain the UUID from the registration response or resolveUser().
 *
 * All functions throw on non-2xx responses.
 */

// ── Config ────────────────────────────────────────────────────────────────

export interface InstruxiConfig {
  baseUrl: string;       // https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer
  rwGatewayUrl: string;  // https://rwa-gateway.instruxi.dev
  apiKey: string;        // INSTRUXI_API_KEY
  adminJwt: string;      // INSTRUXI_ADMIN_JWT
  tenantId: string;      // INSTRUXI_TENANT_ID
}

function cfg(): InstruxiConfig {
  return {
    baseUrl:      process.env.INSTRUXI_BASE_URL  || "https://enforcer-v2-dev.instruxi.dev/api/v1/enforcer",
    rwGatewayUrl: process.env.RWA_GATEWAY_URL    || "https://rwa-gateway.instruxi.dev",
    apiKey:       process.env.INSTRUXI_API_KEY   || "",
    adminJwt:     process.env.INSTRUXI_ADMIN_JWT || "",
    tenantId:     process.env.INSTRUXI_TENANT_ID || "",
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

async function gatewayReq<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const c = cfg();
  const url = `${c.rwGatewayUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${c.adminJwt}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json() as T;
  if (!res.ok) {
    throw new Error(`RWA Gateway ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
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
  description?: string;
  tenant_id?: string;
  created_at?: string;
  updated_at?: string;
}

// ── Enforcer-v2: Auth ─────────────────────────────────────────────────────

/**
 * Register a new account in Enforcer-v2.
 * POST /auth/register
 *
 * @param address   Wallet address (account_address)
 * @param email     Email address
 * @param signature ECDSA signature for verification
 * @param opts      Optional profile fields
 * @returns         User record including the UUID `id` needed for group operations
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
): Promise<ApiResponse<Record<string, string>>> {
  return req("POST", "/auth/register", {
    account_address: address,
    email,
    signature,
    ...opts,
  });
}

/**
 * Authorize an action via OPA Rego policy.
 * POST /auth/authorize
 *
 * Response contains `allow` (boolean), `message`, `reason`.
 * NOTE: The field is `allow`, not `allowed`.
 */
export async function authorize(
  policyId: string,
  input: {
    action?: string;
    user_id?: string;
    resource?: string;
    resource_type?: string;
    resource_metadata?: Record<string, unknown>;
    contexts?: string[];
    [key: string]: unknown;
  }
): Promise<{ allow: boolean; message?: string; reason?: string }> {
  const res = await req<{ allow: boolean; message?: string; reason?: string }>(
    "POST", "/auth/authorize",
    { policy_id: policyId, ...input }
  );
  return res;
}

/**
 * Resolve a wallet address to the user's enforcer-v2 UUID.
 * GET /admin/users/resolve?account_address={address}
 *
 * Group operations require the UUID user ID, not the wallet address.
 * Call this after registration if you only have the wallet address.
 */
export async function resolveUser(
  accountAddress: string
): Promise<{ id: string; account_address: string } | null> {
  try {
    const res = await req<ApiResponse<{ id: string; account_address: string }>>(
      "GET", `/admin/users/resolve?account_address=${encodeURIComponent(accountAddress)}`
    );
    return res.data ?? null;
  } catch {
    return null;
  }
}

// ── Enforcer-v2: Admin Groups ─────────────────────────────────────────────

/**
 * Create a new Enforcer group.
 * POST /admin/groups
 */
export async function createGroup(
  name: string,
  description?: string
): Promise<ApiResponse<GroupRecord>> {
  return req("POST", "/admin/groups", {
    name,
    tenant_id: cfg().tenantId,
    ...(description ? { description } : {}),
  });
}

/**
 * Add a single user to a single group.
 * POST /admin/groups/{group_id}/users/{user_id}
 *
 * Both IDs are enforcer-v2 UUIDs. Use resolveUser() to get the user UUID
 * from a wallet address if needed.
 */
export async function addUserToGroup(
  userId: string,
  groupId: string
): Promise<ApiResponse> {
  return req("POST", `/admin/groups/${groupId}/users/${userId}`, {
    user_id: userId,
    group_id: groupId,
  });
}

/**
 * Add a single user to multiple groups in one call.
 * POST /admin/groups/users/batch
 *
 * @param userId   Enforcer-v2 UUID for the user
 * @param groupIds Array of enforcer-v2 group UUIDs
 */
export async function addUserToGroups(
  userId: string,
  groupIds: string[]
): Promise<ApiResponse> {
  return req("POST", "/admin/groups/users/batch", {
    user_id: userId,
    group_ids: groupIds,
  });
}

/**
 * Get all groups a user belongs to.
 * GET /admin/groups/user/{user_id}/groups
 *
 * @param userId Enforcer-v2 UUID for the user
 */
export async function getUserGroups(userId: string): Promise<GroupRecord[]> {
  const res = await req<ApiResponse<GroupRecord[]>>(
    "GET", `/admin/groups/user/${userId}/groups`
  );
  return res.data ?? [];
}

/**
 * Remove a user from a group.
 * DELETE /admin/groups/{group_id}/users/{user_id}
 */
export async function removeUserFromGroup(
  userId: string,
  groupId: string
): Promise<ApiResponse> {
  return req("DELETE", `/admin/groups/${groupId}/users/${userId}`);
}

// ── Enforcer-v2: Storage (Storj) ──────────────────────────────────────────

/**
 * Upload a file to Instruxi Object Storage (Storj).
 * POST /storage/file/storj/upload  (multipart/form-data)
 *
 * The Storj bucket is configured server-side — no bucket_name needed.
 *
 * @param fileBuffer  File content as Buffer
 * @param fileName    File name (e.g. "roster-2026-001.csv")
 * @param fileType    MIME type (e.g. "text/csv")
 * @param directory   Optional directory path within the bucket
 * @param policyId    Optional Enforcer policy ID for access gating
 * @returns           Object with file_id and object_key (Storj path)
 */
export async function uploadFile(
  fileBuffer: Buffer,
  fileName: string,
  fileType: string,
  directory?: string,
  policyId?: string
): Promise<{ file_id: string; object_key: string }> {
  const c = cfg();
  const form = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: fileType });
  form.append("file", blob, fileName);
  form.append("file_type", fileType);
  if (directory) form.append("directory", directory);
  if (policyId) form.append("policy_id", policyId);

  const res = await fetch(`${c.baseUrl}/storage/file/storj/upload`, {
    method: "POST",
    headers: {
      "x-api-key": c.apiKey,
      "Authorization": `Bearer ${c.adminJwt}`,
    },
    body: form,
  });

  const json = await res.json() as ApiResponse<{ file_id: string }>;
  if (!res.ok) throw new Error(`uploadFile → ${res.status}: ${JSON.stringify(json)}`);
  // Compute the object_key locally (mirrors server-side path construction)
  const object_key = directory ? `${directory}/${fileName}` : fileName;
  const file_id = (json.data as { file_id: string }).file_id;
  return { file_id, object_key };
}

/**
 * Generate a presigned download URL for a Storj file.
 * GET /storage/file/storj/presigned-url?object_key={key}&expiry={seconds}
 *
 * @param objectKey     The file's object key/path in Storj
 * @param expireSeconds URL expiry time (default 3600, max 604800)
 */
export async function getPresignedUrl(
  objectKey: string,
  expireSeconds = 3600
): Promise<string> {
  const c = cfg();
  const url = `${c.baseUrl}/storage/file/storj/presigned-url?object_key=${encodeURIComponent(objectKey)}&expiry=${expireSeconds}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": c.apiKey,
      "Authorization": `Bearer ${c.adminJwt}`,
    },
  });
  const json = await res.json() as ApiResponse<{ url: string }>;
  if (!res.ok) throw new Error(`getPresignedUrl → ${res.status}: ${JSON.stringify(json)}`);
  return json.data?.url ?? "";
}

/**
 * Move/rename a file within Storj storage.
 * POST /storage/file/storj/move
 */
export async function moveFile(
  bucketName: string,
  sourceKey: string,
  destinationKey: string,
  destBucketName?: string
): Promise<ApiResponse> {
  return req("POST", "/storage/file/storj/move", {
    bucket_name: bucketName,
    source_key: sourceKey,
    destination_key: destinationKey,
    ...(destBucketName ? { dest_bucket_name: destBucketName } : {}),
  });
}

// ── RWA Attestations (rwa-gateway.instruxi.dev) ───────────────────────────

export interface CreateAttestationInput {
  contract_deployment_id: number;    // registered contract deployment ID
  attestation_type: string;          // "net_asset_value" | "proof_of_reserve"
  attestor_name: string;
  attestor_entity?: string;
  attestor_wallet_address?: string;
  attestation_data: string;          // EIP-712 typed data JSON string
  nonce?: string;                    // from POST /api/admin/attestations/nonce
  signature?: string;                // EIP-712 signature (0x-prefixed hex)
  active?: boolean;
}

/**
 * Create a TrustSync attestation via the RWA Gateway.
 * POST /api/attestations
 */
export async function createAttestation(
  input: CreateAttestationInput
): Promise<ApiResponse<{ id: string }>> {
  return gatewayReq("POST", "/api/attestations", input);
}

/**
 * Publish an attestation (make it publicly visible).
 * POST /api/attestations/publish
 */
export async function publishAttestation(id: string | number): Promise<ApiResponse> {
  return gatewayReq("POST", "/api/attestations/publish", { id });
}
