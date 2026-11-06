import { utils } from "near-api-js";
import { config } from "./config.mjs";
import { derivedPublicKey, identityName } from "./auth.mjs";
import {
  accountExists,
  agentIdForSubject,
  chainInfo,
  keyOnAccount,
  provisionAgent,
  provisionVault,
  vaultIdForSubject,
} from "./chain.mjs";
import {
  claimSignup,
  getAgentRecord,
  getUser,
  releaseSignup,
  saveAgentRecord,
  saveUser,
} from "./store.mjs";

const locks = new Map();

function withSubjectLock(subject, task) {
  const previous = locks.get(subject) || Promise.resolve();
  const run = previous.then(task, task);
  locks.set(
    subject,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function ensureAgent({ subject, vaultId }) {
  const agentId = agentIdForSubject(subject);
  let record = await getAgentRecord(vaultId);

  if (!record || record.agentId !== agentId) {
    const keyPair = utils.KeyPair.fromRandom("ed25519");
    record = {
      vaultId,
      agentId,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
      createdAt: new Date().toISOString(),
    };
    // Saved before the account exists so a retry reuses the same key instead
    // of orphaning an account we can no longer sign for.
    await saveAgentRecord(vaultId, record);
  }

  const result = await provisionAgent({
    agentId,
    agentPublicKey: record.publicKey,
    vaultId,
  });
  return { record, txHash: result.txHash, reused: result.reused };
}

export async function setupAccount({ identity, inviteCode }) {
  return withSubjectLock(identity.subject, async () => {
    const existing = await getUser(identity.subject);
    if (existing) {
      return { user: existing, created: false, steps: ["already set up"] };
    }

    // Claim the invite and the capacity slot atomically before any slow
    // on-chain work, so two logins can never race on one code or overfill
    // the deployment. The claim is released below if provisioning fails.
    const claim = await claimSignup(identity.subject, inviteCode);
    if (!claim.ok) throw httpError(claim.status, claim.reason);
    if (claim.already) {
      const ready = await getUser(identity.subject);
      if (ready) return { user: ready, created: false, steps: ["already set up"] };
      throw httpError(
        409,
        "Setup for this login is already in progress. Wait a moment and try again.",
      );
    }

    try {
      return await provisionNewUser({ identity, claim });
    } catch (error) {
      // Nothing was registered, so give the invite and the slot back.
      await releaseSignup(identity.subject);
      throw error;
    }
  });
}

async function provisionNewUser({ identity, claim }) {
  const publicKey = await derivedPublicKey(identity.subject);
  const steps = [];

  const mappedVault = config.demoVaultMap[identity.subject];
  let vaultId;
  let adopted = false;
  let vaultTxHash = null;

  if (mappedVault) {
    vaultId = mappedVault;
    const key = await keyOnAccount(vaultId, publicKey);
    if (!key) {
      throw httpError(
        403,
        "That account exists but this login does not control it.",
      );
    }
    adopted = true;
    steps.push("found your existing account");
  } else {
    vaultId = vaultIdForSubject(identity.subject);
    if (await accountExists(vaultId)) {
      const key = await keyOnAccount(vaultId, publicKey);
      if (!key) {
        throw httpError(
          409,
          "That account name is taken by someone else. Contact the operator.",
        );
      }
      adopted = true;
      steps.push("found your existing account");
    }
  }

  if (!adopted) {
    const created = await provisionVault({ vaultId, publicKey });
    vaultTxHash = created.txHash;
    steps.push(created.reused ? "account already existed" : "account created and funded");
  }

  const agent = await ensureAgent({ subject: identity.subject, vaultId });
  steps.push(
    agent.reused
      ? "agent account already existed"
      : `agent account created (${agent.record.agentId})`,
  );

  const user = await saveUser({
    subject: identity.subject,
    email: identity.email,
    name: identity.name || identityName(identity),
    vaultId,
    publicKey,
    agentId: agent.record.agentId,
    agentPublicKey: agent.record.publicKey,
    inviteCodeHash: claim.digest,
    status: "ready",
    adopted,
    vaultTxHash,
    agentTxHash: agent.txHash,
    createdAt: new Date().toISOString(),
  });

  return { user, created: true, steps };
}

export async function describeUser(user) {
  const info = chainInfo();
  return {
    subject: user.subject,
    name: user.name,
    email: user.email,
    vaultId: user.vaultId,
    agentId: user.agentId,
    publicKey: user.publicKey,
    agentPublicKey: user.agentPublicKey,
    createdAt: user.createdAt,
    contractCodeHash: info.wasm.codeHash,
  };
}
