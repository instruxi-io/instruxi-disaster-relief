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
 * Auth: x-api-key is sufficient for all endpoints (including Admin-gated ones).
 *       INSTRUXI_ADMIN_JWT is sent when present but not required.
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
    rwGatewayUrl: process.env.RWA_GATEWAY_URL    || "https://rwa-gateway-staging.instruxi.dev",
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
    ...(c.adminJwt ? { "Authorization": `Bearer ${c.adminJwt}` } : {}),
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

export interface UserRecord {
  id: string;
  email?: string;
  account_address?: string;
  tenant_id?: string;
  role?: { id: string; name: string };
}

export interface WalletRecord {
  wallet_id: string;
  user_id: string;
  chain_id: number;
  name?: string;
  provider?: string;
  master_key_id?: string;  // e.g. "privy_did:privy:{DID}_0" — use to resolve address via Privy
  status?: string;
  created_at?: string;
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
 * Create a new user in enforcer-v2 as admin.
 * POST /admin/users
 *
 * Used to pre-provision victim accounts from a CSV before they log in.
 * account_address is required by the API — pass a zero address as placeholder
 * if the real wallet will be provisioned separately via createUserWallet().
 */
export async function adminCreateUser(
  email: string,
  opts: {
    account_address?: string;
    first_name?: string;
    last_name?: string;
    role_id?: string;
  } = {}
): Promise<ApiResponse<UserRecord>> {
  const tenantId = cfg().tenantId;
  return req("POST", "/admin/users", {
    email,
    account_address: opts.account_address ?? "0x0000000000000000000000000000000000000000",
    ...(tenantId ? { tenant_id: tenantId } : {}),
    ...(opts.first_name ? { first_name: opts.first_name } : {}),
    ...(opts.last_name ? { last_name: opts.last_name } : {}),
    ...(opts.role_id ? { role_id: opts.role_id } : {}),
  });
}

/**
 * Provision a new wallet for an existing enforcer user.
 * POST /users/{user_id}/wallets
 *
 * The enforcer creates and manages the wallet via Privy under the hood.
 * Returns the wallet address which can be used for onchain eligibility.
 *
 * @param userId  Enforcer-v2 UUID for the user
 * @param chainId Chain ID (11155111 for Sepolia)
 * @param name    Human-readable wallet label
 */
export async function createUserWallet(
  userId: string,
  chainId: number = 11155111,
  name: string = "relief-wallet"
): Promise<ApiResponse<WalletRecord>> {
  return req("POST", `/users/${userId}/wallets`, {
    user_id: userId,
    chain_id: chainId,
    name,
    provider: "privy",
  });
}

/**
 * Create a Privy user + server wallet in one call via the RWA Gateway.
 * POST /api/privy/server-wallet/create-user
 *
 * Returns the wallet address directly — no separate wallet provisioning step needed.
 * This is the preferred path for batch roster ingestion since POST /admin/users
 * has a known issue where it errors on identity_provider_error for all email domains.
 *
 * @param email   Recipient email address
 * @returns       { privyDid, walletAddress } or throws on failure
 */
export async function createPrivyUser(email: string): Promise<{ privyDid: string; walletAddress: string }> {
  const c = cfg();
  const url = `${c.rwGatewayUrl}/api/privy/server-wallet/create-user`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${c.adminJwt}`,
    },
    body: JSON.stringify({
      linked_accounts: [{ type: "email", address: email, chain_type: "ethereum" }],
    }),
  });

  const json = await res.json() as {
    success: boolean;
    data?: {
      id: string;
      linked_accounts: Array<{ type: string; address: string }>;
    };
    message?: string;
  };

  if (!res.ok || !json.success) {
    throw new Error(`createPrivyUser → ${res.status}: ${json.message ?? JSON.stringify(json)}`);
  }

  const privyDid = json.data!.id;
  const walletAccount = json.data!.linked_accounts.find(
    a => a.type === "wallet" && a.address && a.address !== "0x0000000000000000000000000000000000000000"
  );
  if (!walletAccount) throw new Error(`createPrivyUser: no wallet in response for ${email}`);

  return { privyDid, walletAddress: walletAccount.address };
}

/**
 * Get a provisioned wallet's real blockchain address via the RWA Gateway Privy API.
 * After POST /users/{id}/wallets, the address lives in Privy — not the enforcer wallet record.
 *
 * Extracts the Privy DID from master_key_id ("privy_did:privy:{DID}_0"),
 * fetches GET /api/privy/users from the Gateway, and returns the first non-zero wallet address.
 *
 * @param masterKeyId  The master_key_id field from the WalletRecord response
 */
export async function getPrivyWalletAddress(masterKeyId: string): Promise<string | null> {
  // master_key_id format: "privy_did:privy:{DID}_0"
  const match = masterKeyId.match(/privy_did:privy:([^_]+)/);
  if (!match) return null;
  const privyDid = `did:privy:${match[1]}`;

  const c = cfg();
  const url = `${c.rwGatewayUrl}/api/privy/users?limit=100`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${c.adminJwt}`,
    },
  });

  if (!res.ok) return null;

  const json = await res.json() as { data?: { data?: Array<{ id: string; linked_accounts: Array<{ type: string; address: string }> }> } };
  const users = json.data?.data ?? [];
  const user = users.find(u => u.id === privyDid);
  if (!user) return null;

  const wallet = user.linked_accounts.find(
    a => a.type === "wallet" && a.address && a.address !== "0x0000000000000000000000000000000000000000"
  );
  return wallet?.address ?? null;
}

/**
 * Resolve a user by email address to their enforcer-v2 record + wallets.
 * GET /admin/users/resolve?email={email}&include=wallets
 *
 * Use this after victims have logged in to retrieve their wallet addresses.
 */
export async function resolveUserByEmail(
  email: string
): Promise<(UserRecord & { wallets?: WalletRecord[] }) | null> {
  try {
    const res = await req<ApiResponse<UserRecord & { wallets?: WalletRecord[] }>>(
      "GET", `/admin/users/resolve?email=${encodeURIComponent(email)}&include=wallets`
    );
    return res.data ?? null;
  } catch {
    return null;
  }
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
  const tenantId = cfg().tenantId;
  return req("POST", "/admin/groups", {
    name,
    ...(tenantId ? { tenant_id: tenantId } : {}),
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
