import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import express from "express";
import { config, APP_ROOT } from "./config.mjs";
import { authenticate, derivedPublicKey, identityName, verifySigningToken } from "./auth.mjs";
import {
  broadcastUserTransaction,
  initChain,
  keyOnAccount,
  outcomeLogs,
  readVault,
  relaySign,
} from "./chain.mjs";
import { errandList, runErrand } from "./agent.mjs";
import { DEFAULT_RULES, PERIOD_CHOICES, VENDORS } from "./catalog.mjs";
import { describeUser, setupAccount } from "./provision.mjs";
import { getBlock } from "./rpc.mjs";
import { appendActivity, countUsers, getUser, getRawUser, initStore, listActivity } from "./store.mjs";

const MAX_SIGN_PAYLOAD_BYTES = 8 * 1024;
const MAX_JWT_BYTES = 16 * 1024;

function log(event, fields = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

function subjectTag(subject) {
  return createHash("sha256").update(String(subject)).digest("hex").slice(0, 10);
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function limiter({ windowMs, max, name }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${name}`;
    const entry = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (now >= entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > max) {
      log("rate_limited", { name, ip: req.ip });
      res.status(429).json({ error: "That is too many requests. Wait a minute and try again." });
      return;
    }
    next();
  };
}

const derivedKeyCache = new Map();

async function derivedKeyFor(subject) {
  const cached = derivedKeyCache.get(subject);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.key;
  const key = await derivedPublicKey(subject);
  derivedKeyCache.set(subject, { key, at: Date.now() });
  return key;
}

async function requireUser(req) {
  const identity = await authenticate(req);
  const user = await getUser(identity.subject);
  if (!user) {
    const error = new Error("Set up your account first.");
    error.status = 409;
    throw error;
  }
  return { identity, user };
}

async function main() {
  await initStore();
  const info = await initChain();
  const users = await countUsers();

  log("boot", {
    network: config.network,
    port: config.port,
    sponsor: config.sponsorAccountId,
    sponsorPublicKey: info.sponsorPublicKey,
    contractCodeHash: info.wasm.codeHash,
    wasmBytes: info.wasm.bytes,
    rpc: [config.rpcUrl, ...config.rpcFallbacks],
    dataDir: config.dataDir,
    inviteCodes: config.inviteCodes.length,
    maxUsers: config.maxUsers,
    registeredUsers: users,
    demoVaultMap: Object.keys(config.demoVaultMap).length,
  });

  if (config.inviteCodes.length === 0) {
    log("warning", {
      message: "INVITE_CODES is empty, so nobody can set up an account.",
    });
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      network: config.network,
      sponsor: config.sponsorAccountId,
      contractCodeHash: info.wasm.codeHash,
    });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      network: config.network,
      nearUsdRate: config.nearUsdRate,
      auth: {
        domain: config.auth0Domain,
        clientId: config.auth0ClientId,
        fastAuthContractId: config.fastAuthContractId,
        mpcContractId: config.mpcContractId,
      },
      vendors: VENDORS,
      defaultRules: DEFAULT_RULES,
      periodChoices: PERIOD_CHOICES,
      errands: errandList(),
      agent: { gasAllowanceNear: config.agentGasAllowanceNear },
    });
  });

  app.get(
    "/api/me",
    asyncRoute(async (req, res) => {
      const identity = await authenticate(req);
      const publicKey = await derivedKeyFor(identity.subject);
      const user = await getUser(identity.subject);
      if (!user) {
        // A provisioning placeholder means setup is running right now (or
        // crashed mid-flight); say so instead of offering the invite form.
        const raw = await getRawUser(identity.subject);
        const setupInProgress = raw?.status === "provisioning";
        const mapped = setupInProgress
          ? null
          : config.demoVaultMap[identity.subject] || null;
        let existingVault = null;
        if (mapped && (await keyOnAccount(mapped, publicKey))) {
          existingVault = mapped;
        }
        res.json({
          needsSetup: true,
          setupInProgress,
          identity: {
            name: identityName(identity),
            email: identity.email,
            publicKey,
          },
          existingVault,
        });
        return;
      }
      res.json({ needsSetup: false, user: await describeUser(user) });
    }),
  );

  app.post(
    "/api/setup",
    limiter({ windowMs: 60_000, max: 6, name: "setup" }),
    asyncRoute(async (req, res) => {
      const identity = await authenticate(req);
      const inviteCode = String(req.body?.inviteCode || "").trim();
      const started = Date.now();
      const result = await setupAccount({ identity, inviteCode });
      log("setup", {
        subject: subjectTag(identity.subject),
        vault: result.user.vaultId,
        agent: result.user.agentId,
        created: result.created,
        ms: Date.now() - started,
      });
      res.json({
        user: await describeUser(result.user),
        steps: result.steps,
        created: result.created,
      });
    }),
  );

  app.get(
    "/api/vault",
    asyncRoute(async (req, res) => {
      const { user } = await requireUser(req);
      const vault = await readVault(user.vaultId);
      const activity = await listActivity(user.vaultId);
      res.json({ vault, activity, user: await describeUser(user) });
    }),
  );

  app.post(
    "/api/sign-tx",
    limiter({ windowMs: 60_000, max: 40, name: "sign" }),
    asyncRoute(async (req, res) => {
      const { guard_id: guardId, verify_payload: verifyPayload, sign_payload: signPayload, algorithm } =
        req.body || {};

      if (guardId !== config.authGuardId) {
        res.status(400).json({ error: "That approval came from a different login provider." });
        return;
      }
      if (typeof verifyPayload !== "string" || Buffer.byteLength(verifyPayload) > MAX_JWT_BYTES) {
        res.status(400).json({ error: "The approval token is missing or too large." });
        return;
      }
      if (algorithm !== "eddsa" && algorithm !== "ecdsa") {
        res.status(400).json({ error: "Unsupported signature algorithm." });
        return;
      }
      if (!Array.isArray(signPayload) || signPayload.length === 0) {
        res.status(400).json({ error: "There is no transaction to approve." });
        return;
      }
      if (signPayload.length > MAX_SIGN_PAYLOAD_BYTES) {
        res.status(400).json({ error: "That transaction is too large to approve." });
        return;
      }
      if (signPayload.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        res.status(400).json({ error: "That transaction is not readable." });
        return;
      }

      const claims = await verifySigningToken(verifyPayload);
      const user = await getUser(claims.sub);
      if (!user) {
        res.status(403).json({ error: "Set up your account first." });
        return;
      }

      const started = Date.now();
      const { hash, outcome } = await relaySign({
        guardId,
        verifyPayload,
        signPayload,
        algorithm,
      });
      log("relay", {
        subject: subjectTag(claims.sub),
        vault: user.vaultId,
        bytes: signPayload.length,
        txHash: hash,
        ms: Date.now() - started,
      });

      res.json({
        hash,
        result: {
          status: outcome.status,
          transaction: outcome.transaction
            ? {
                hash: outcome.transaction.hash,
                signer_id: outcome.transaction.signer_id,
                receiver_id: outcome.transaction.receiver_id,
              }
            : undefined,
        },
      });
    }),
  );

  app.post(
    "/api/broadcast",
    limiter({ windowMs: 60_000, max: 60, name: "broadcast" }),
    asyncRoute(async (req, res) => {
      const { user } = await requireUser(req);
      const signedTxBase64 = String(req.body?.signedTxBase64 || "");
      const result = await broadcastUserTransaction(signedTxBase64, {
        vaultId: user.vaultId,
        publicKey: user.publicKey,
      });
      log("owner_tx", {
        subject: subjectTag(user.subject),
        vault: user.vaultId,
        actions: result.summary,
        txHash: result.hash,
      });
      res.json({
        hash: result.hash,
        explorer: `https://explorer.testnet.near.org/transactions/${result.hash}`,
        status: result.outcome.status,
        successValue: result.outcome.status?.SuccessValue ?? null,
        logs: outcomeLogs(result.outcome),
      });
    }),
  );

  app.post(
    "/api/agent/run",
    limiter({ windowMs: 60_000, max: 30, name: "agent" }),
    asyncRoute(async (req, res) => {
      const { user } = await requireUser(req);
      const errandId = String(req.body?.errandId || "");
      const result = await runErrand({ vaultId: user.vaultId, errandId });
      log("agent_run", {
        subject: subjectTag(user.subject),
        vault: user.vaultId,
        errand: errandId,
        status: result.receipt?.status,
        txHash: result.txHash,
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/activity",
    limiter({ windowMs: 60_000, max: 60, name: "activity" }),
    asyncRoute(async (req, res) => {
      const { user } = await requireUser(req);
      const kind = String(req.body?.kind || "owner");
      const summary = String(req.body?.summary || "").slice(0, 140);
      const txHash = String(req.body?.txHash || "");
      if (!["owner", "setup"].includes(kind)) {
        res.status(400).json({ error: "Unknown activity kind." });
        return;
      }
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) {
        res.status(400).json({ error: "That is not a transaction reference." });
        return;
      }
      if (!summary) {
        res.status(400).json({ error: "A note is required." });
        return;
      }
      const item = await appendActivity(user.vaultId, {
        kind,
        title: summary,
        txHash,
        status: String(req.body?.status || "done").slice(0, 40),
        amountYocto:
          typeof req.body?.amountYocto === "string" && /^\d+$/.test(req.body.amountYocto)
            ? req.body.amountYocto
            : null,
      });
      res.json({ activity: item });
    }),
  );

  app.get(
    "/api/chain/block",
    asyncRoute(async (_req, res) => {
      const block = await getBlock();
      res.json({ hash: block.header.hash, height: block.header.height });
    }),
  );

  app.post(
    "/api/chain/access-key",
    limiter({ windowMs: 60_000, max: 120, name: "access-key" }),
    asyncRoute(async (req, res) => {
      const accountId = String(req.body?.accountId || "");
      const publicKey = String(req.body?.publicKey || "");
      if (!/^[a-z0-9._-]{2,64}$/.test(accountId) || !/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey)) {
        res.status(400).json({ error: "That account or key is not readable." });
        return;
      }
      const accessKey = await keyOnAccount(accountId, publicKey);
      if (!accessKey) {
        res.status(404).json({
          error: "This login does not control that account, so it cannot sign for it.",
        });
        return;
      }
      res.json({
        nonce: String(accessKey.nonce),
        permission: accessKey.access_key.permission,
      });
    }),
  );

  const distDir = join(APP_ROOT, "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(join(distDir, "index.html"));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    if (status >= 500) {
      log("error", { status, message: error.stack || error.message });
    } else {
      log("rejected", { status, message: error.message });
    }
    res.status(status).json({
      error:
        status >= 500
          ? "Something went wrong on our side. Try again in a moment."
          : error.message,
    });
  });

  const server = app.listen(config.port, "127.0.0.1", () => {
    log("listening", {
      url: `http://127.0.0.1:${config.port}`,
      web: existsSync(distDir) ? `http://127.0.0.1:${config.port}` : "run npm run dev for the web app",
    });
  });

  const shutdown = (signal) => {
    log("shutdown", { signal });
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  log("fatal", { message: error.stack || String(error) });
  process.exit(1);
});
