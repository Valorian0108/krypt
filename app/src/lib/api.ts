// Every request to the app server goes through this module. The bearer token
// is the raw Auth0 ID token; the server verifies it against the tenant's own
// keys and derives everything else from it.

import type {
  ActivityItem,
  AgentRunResult,
  AppConfig,
  BroadcastResult,
  MeResponse,
  User,
  VaultResponse,
} from "./types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let tokenGetter: (() => Promise<string>) | null = null;

export function setTokenGetter(getter: () => Promise<string>) {
  tokenGetter = getter;
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.auth) {
    if (!tokenGetter) throw new Error("Sign in to continue.");
    headers.authorization = `Bearer ${await tokenGetter()}`;
  }

  // A hung server must not leave the screen spinning forever.
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method || (options.body !== undefined ? "POST" : "GET"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(0, "The app server took too long to answer. Try again.");
    }
    throw new ApiError(0, "Cannot reach the app server. Is it still running?");
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const message =
      (parsed as { error?: string } | null)?.error ||
      `The server answered HTTP ${response.status}.`;
    throw new ApiError(response.status, message);
  }
  return parsed as T;
}

export const api = {
  health: () => request<{ ok: boolean; network: string; sponsor: string }>("/api/health"),

  config: () => request<AppConfig>("/api/config"),

  me: () => request<MeResponse>("/api/me", { auth: true }),

  // Provisioning signs and waits for several on-chain transactions.
  setup: (inviteCode: string) =>
    request<{ user: User; steps: string[]; created: boolean }>("/api/setup", {
      body: { inviteCode },
      auth: true,
      timeoutMs: 120_000,
    }),

  vault: () => request<VaultResponse>("/api/vault", { auth: true }),

  block: () => request<{ hash: string; height: number }>("/api/chain/block"),

  accessKey: (accountId: string, publicKey: string) =>
    request<{ nonce: string; permission: unknown }>("/api/chain/access-key", {
      body: { accountId, publicKey },
    }),

  // The relay endpoint verifies the signing token itself, so no bearer here.
  relaySign: (payload: {
    guard_id: string;
    verify_payload: string;
    sign_payload: number[];
    algorithm: "eddsa" | "ecdsa";
  }) =>
    request<{
      hash: string;
      result: { status: { SuccessValue?: string } };
    }>("/api/sign-tx", { body: payload, timeoutMs: 90_000 }),

  broadcast: (signedTxBase64: string) =>
    request<BroadcastResult>("/api/broadcast", {
      body: { signedTxBase64 },
      auth: true,
      timeoutMs: 90_000,
    }),

  runErrand: (errandId: string) =>
    request<AgentRunResult>("/api/agent/run", {
      body: { errandId },
      auth: true,
      timeoutMs: 90_000,
    }),

  recordActivity: (item: {
    kind: "owner" | "setup";
    summary: string;
    txHash: string;
    status?: string;
    amountYocto?: string;
  }) => request<{ activity: ActivityItem }>("/api/activity", { body: item, auth: true }),
};
