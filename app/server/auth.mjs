import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.mjs";
import { callView } from "./rpc.mjs";

const issuer = `https://${config.auth0Domain}/`;
const jwks = createRemoteJWKSet(
  new URL(`https://${config.auth0Domain}/.well-known/jwks.json`),
);

function friendlyJwtError(error) {
  const code = error?.code || "";
  if (code === "ERR_JWT_EXPIRED") return "Your session expired. Sign in again.";
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    return "This login token was issued for a different app.";
  }
  if (code === "ERR_JWKS_NO_MATCHING_KEY") {
    return "The login token could not be verified. Sign in again.";
  }
  return "The login token is not valid. Sign in again.";
}

export async function verifyIdToken(token) {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: config.auth0ClientId,
      clockTolerance: 60,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("no subject");
    }
    return payload;
  } catch (error) {
    const wrapped = new Error(friendlyJwtError(error));
    wrapped.status = 401;
    throw wrapped;
  }
}

export async function verifySigningToken(token) {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: config.auth0SigningAudience,
      clockTolerance: 60,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("no subject");
    }
    if (!Array.isArray(payload.fatxn) || payload.fatxn.length === 0) {
      throw new Error("no transaction claim");
    }
    return payload;
  } catch (error) {
    const wrapped = new Error(
      error.message === "no transaction claim"
        ? "This approval did not include a transaction."
        : friendlyJwtError(error),
    );
    wrapped.status = 401;
    throw wrapped;
  }
}

export function derivationPath(subject) {
  return `jwt#https://${config.auth0Domain}/#${subject}`;
}

export async function derivedPublicKey(subject) {
  const path = derivationPath(subject);
  const key = await callView(config.mpcContractId, "derived_public_key", {
    path,
    predecessor: config.fastAuthContractId,
    // The MPC contract numbers its domains the other way from near-api-js:
    // 1 is ed25519, 0 is secp256k1. Verified live against the two users.
    domain_id: 1,
  });
  if (typeof key !== "string" || !key.includes(":")) {
    throw new Error("The key service did not return a public key.");
  }
  return key;
}

export async function authenticate(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const error = new Error("Sign in to continue.");
    error.status = 401;
    throw error;
  }
  const claims = await verifyIdToken(match[1].trim());
  return {
    subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    name: typeof claims.name === "string" ? claims.name : null,
    token: match[1].trim(),
  };
}

export function identityName(identity) {
  if (identity.name && identity.name !== identity.email) return identity.name;
  if (identity.email) return identity.email.split("@")[0];
  return "there";
}
