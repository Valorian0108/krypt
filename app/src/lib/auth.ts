// Login lives here. The browser talks to Auth0 for identity and to the app
// server for everything else. It never talks to the NEAR network directly:
// reads and writes both go through the server, which verifies this login's
// own ID token on every request.

import { FastAuthClient } from "@fast-auth-near/browser-sdk";
import { JavascriptProvider } from "@fast-auth-near/javascript-provider";
import type { Connection } from "near-api-js";
import type { AppConfig } from "./types";

export type FastAuthSigner = Awaited<ReturnType<FastAuthClient["getSigner"]>>;

// The JavascriptProvider keeps its Auth0 client private in the type
// declarations. These are the methods this app uses, verified live against
// the shared testnet tenant.
type PopupConfig = Record<string, unknown> | undefined;

type Auth0ClientLike = {
  getIdTokenClaims(): Promise<
    | {
        __raw?: string;
        sub?: string;
        email?: string;
        name?: string;
        exp?: number;
      }
    | undefined
  >;
  logout(options?: { logoutParams?: { returnTo?: string } }): Promise<void>;
  loginWithPopup(options?: PopupConfig, config?: PopupConfig): Promise<void>;
};

// Auth0 closes a popup after 60 seconds unless the caller passes
// timeoutInSeconds in the SECOND argument of loginWithPopup. The FastAuth
// provider spreads its options into the first argument only and never sets
// the second, so without this patch both the login popup and the
// transaction-approval popup die at the default while a person is still
// reading. Wrapping the method on the client instance is the only hook the
// provider leaves us, and it covers every popup path.
const POPUP_TIMEOUT_SECONDS = 180;

function patchPopupTimeout(auth0: Auth0ClientLike): void {
  const original = auth0.loginWithPopup.bind(auth0);
  auth0.loginWithPopup = (options, config) =>
    original(options, { timeoutInSeconds: POPUP_TIMEOUT_SECONDS, ...config });
}

function refuseNetworkAccess(what: string): never {
  throw new Error(
    `Ring 1 tried to ${what} straight from the browser. ` +
      "All network traffic goes through the app server.",
  );
}

// A stand-in for the near-api-js connection the SDK constructor requires.
// Every method throws, so if any code path ever tries to use it the failure
// is loud and immediate instead of a silent direct RPC call.
const offlineConnection = {
  networkId: "testnet",
  provider: {
    query: () => refuseNetworkAccess("read the chain"),
    block: () => refuseNetworkAccess("read the chain"),
    sendTransaction: () => refuseNetworkAccess("send a transaction"),
    sendTransactionUntil: () => refuseNetworkAccess("send a transaction"),
    sendJsonRpc: () => refuseNetworkAccess("call the network"),
    txStatus: () => refuseNetworkAccess("read the chain"),
  },
  signer: {
    createKey: () => refuseNetworkAccess("create a key"),
    getPublicKey: () => refuseNetworkAccess("read a key"),
    signMessage: () => refuseNetworkAccess("sign"),
  },
} as unknown as Connection;

let provider: JavascriptProvider | null = null;
let client: FastAuthClient | null = null;

export function initAuth(config: AppConfig): void {
  if (client) return;
  provider = new JavascriptProvider({
    network: "testnet",
    clientId: config.auth.clientId,
    domain: config.auth.domain,
  });
  client = new FastAuthClient(
    provider,
    offlineConnection,
    {
      fastAuthContractId: config.auth.fastAuthContractId,
      mpcContractId: config.auth.mpcContractId,
    },
  );
  patchPopupTimeout(auth0Client());
}

function requireAuth(): { provider: JavascriptProvider; client: FastAuthClient } {
  if (!provider || !client) {
    throw new Error("The login module is not ready yet. Reload the page.");
  }
  return { provider, client };
}

function auth0Client(): Auth0ClientLike {
  const { provider: javascriptProvider } = requireAuth();
  return (javascriptProvider as unknown as { client: Auth0ClientLike }).client;
}

export async function isLoggedIn(): Promise<boolean> {
  const { provider: javascriptProvider } = requireAuth();
  return javascriptProvider.isLoggedIn();
}

// One popup, one identity. No wallet extension and no seed phrase.
export async function login(): Promise<string> {
  const { client: fastAuth } = requireAuth();
  const user = await fastAuth.login();
  return user.userId;
}

export async function logout(): Promise<void> {
  // FastAuthClient.logout wraps its options in an extra array, so call the
  // Auth0 client directly for a clean tenant sign-out back to this app.
  await auth0Client()
    .logout({ logoutParams: { returnTo: window.location.origin } })
    .catch(() => {
      // The browser navigates away during logout; a rejection here is the
      // navigation itself.
    });
}

// The raw signed ID token is this app's API credential. The server verifies
// it against the tenant's published keys and derives the user's NEAR key
// from the token subject, so the browser is never asked to assert its own
// identity.
export async function getIdToken(): Promise<string> {
  const claims = await auth0Client().getIdTokenClaims();
  if (!claims || typeof claims.__raw !== "string" || !claims.__raw) {
    throw new Error("Your session expired. Sign in again.");
  }
  return claims.__raw;
}

export async function getSigner(): Promise<FastAuthSigner> {
  const { client: fastAuth } = requireAuth();
  try {
    return await fastAuth.getSigner();
  } catch (error) {
    if (error instanceof Error && error.message === "USER_NOT_LOGGED_IN") {
      throw new Error("Your session expired. Sign in again.");
    }
    throw error;
  }
}
