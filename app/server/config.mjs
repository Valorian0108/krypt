import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(APP_ROOT, "..");

// app/.env wins. The repository-level .env is a fallback so the existing
// RPC setting keeps working without being copied around.
dotenv.config({ path: resolve(APP_ROOT, ".env"), quiet: true });
dotenv.config({ path: resolve(REPO_ROOT, ".env"), override: false, quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is missing. Copy app/env.example to app/.env and fill it in.`);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function numberFromEnv(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${raw}`);
  }
  return value;
}

function intFromEnv(name, fallback, max) {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}, got ${raw}`);
  }
  return value;
}

function nearFromEnv(name, fallback) {
  const raw = optional(name, fallback);
  // Plain decimal NEAR amounts only. Anything else would make
  // parseNearAmount throw much later, at provisioning time, far from the
  // typo that caused it.
  if (!/^\d{1,6}(\.\d{1,24})?$/.test(raw)) {
    throw new Error(`${name} must be a plain NEAR amount like 2.8, got ${raw}`);
  }
  return raw;
}

function parseJsonObject(name, fallback) {
  const raw = optional(name, JSON.stringify(fallback));
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${name}.${key} must be a string`);
    }
  }
  return parsed;
}

const sponsorKeyPathRaw = required("SPONSOR_KEY_PATH");
const sponsorKeyPath = isAbsolute(sponsorKeyPathRaw)
  ? sponsorKeyPathRaw
  : resolve(APP_ROOT, sponsorKeyPathRaw);

export const config = {
  port: intFromEnv("PORT", 3001, 65535),
  network: "testnet",
  rpcUrl: optional("NEAR_RPC_URL", "https://test.rpc.fastnear.com"),
  rpcFallbacks: optional(
    "NEAR_RPC_FALLBACKS",
    "https://near-testnet.drpc.org,https://archival-rpc.testnet.near.org",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  sponsorAccountId: required("SPONSOR_ACCOUNT_ID"),
  sponsorKeyPath,
  sponsorSubaccountSuffix: required("SPONSOR_SUBACCOUNT_SUFFIX"),
  fastAuthContractId: optional("FAST_AUTH_CONTRACT_ID", "fast-auth.testnet"),
  mpcContractId: optional("MPC_CONTRACT_ID", "v1.signer-prod.testnet"),
  auth0Domain: optional("AUTH0_DOMAIN", "login.testnet.fast-auth.com"),
  auth0ClientId: required("AUTH0_CLIENT_ID"),
  auth0SigningAudience: optional(
    "AUTH0_SIGNING_AUDIENCE",
    "auth0.jwt.fast-auth.testnet",
  ),
  authGuardId: optional(
    "AUTH_GUARD_ID",
    "jwt#https://login.testnet.fast-auth.com/",
  ),
  inviteCodes: optional("INVITE_CODES", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  maxUsers: intFromEnv("MAX_USERS", 3, 1000),
  demoVaultMap: parseJsonObject("DEMO_VAULT_MAP", {}),
  vaultFundingNear: nearFromEnv("VAULT_FUNDING_NEAR", "2.8"),
  agentFundingNear: nearFromEnv("AGENT_FUNDING_NEAR", "0.3"),
  agentGasAllowanceNear: nearFromEnv("AGENT_GAS_ALLOWANCE_NEAR", "0.2"),
  nearUsdRate: numberFromEnv("NEAR_USD_RATE", 5),
  dataDir: resolve(APP_ROOT, ".data"),
  wasmPath: resolve(APP_ROOT, "assets", "policy_contract.wasm"),
  wasmSha256:
    "3ba68aef1f1754bea075f2e074c29f1f2b76a5cb804881486cf01271e132c842",
  allowedOrigins: optional(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
};

export const GAS = {
  owner: 50_000_000_000_000n,
  ownerLight: 30_000_000_000_000n,
  requestSpend: 100_000_000_000_000n,
  deployInit: 100_000_000_000_000n,
  sign: 300_000_000_000_000n,
};

export const ONE_YOCTO = 1n;
export const YOCTO_PER_NEAR = 10n ** 24n;
