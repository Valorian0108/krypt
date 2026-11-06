import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.mjs";

const paths = {
  registry: join(config.dataDir, "registry.json"),
  agents: join(config.dataDir, "agents.json"),
  activity: join(config.dataDir, "activity.json"),
};

function hashInvite(code) {
  return createHash("sha256").update(code.trim()).digest("hex");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows can refuse a rename for a moment while another process (backup,
// indexer, editor) still holds the target open. Retry briefly, then remove
// the target and try once more, which is what the old code did immediately.
async function replaceFile(target, temp) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const transient =
        error.code === "EPERM" ||
        error.code === "EEXIST" ||
        error.code === "EBUSY" ||
        error.code === "EACCES";
      if (!transient || attempt > 4) throw error;
      await sleep(40 * attempt);
      if (attempt >= 3) await rm(target, { force: true });
    }
  }
}

class JsonFile {
  constructor(path, initial) {
    this.path = path;
    this.initial = initial;
    this.cache = null;
    this.queue = Promise.resolve();
  }

  async read() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        this.cache = structuredClone(this.initial);
        return this.cache;
      }
      // A torn or corrupt main file falls back to the last good backup
      // instead of taking the whole server down with it.
      try {
        this.cache = JSON.parse(await readFile(`${this.path}.bak`, "utf8"));
      } catch {
        throw error;
      }
    }
    return this.cache;
  }

  async write(value) {
    const temp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    // Keep the previous copy so an interrupted replace can never destroy
    // the last known-good state.
    await copyFile(this.path, `${this.path}.bak`).catch(() => undefined);
    try {
      await replaceFile(this.path, temp);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    this.cache = value;
  }

  async mutate(change) {
    const run = this.queue.then(async () => {
      const current = structuredClone(await this.read());
      const result = await change(current);
      await this.write(current);
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const registryFile = new JsonFile(paths.registry, { users: {} });
const agentsFile = new JsonFile(paths.agents, { agents: {} });
const activityFile = new JsonFile(paths.activity, { vaults: {} });

export async function initStore() {
  await mkdir(config.dataDir, { recursive: true });
  await registryFile.read();
  await agentsFile.read();
  await activityFile.read();
}

export async function getUser(subject) {
  const registry = await registryFile.read();
  const entry = registry.users[subject] || null;
  // A provisioning placeholder is a claim, not an account: it has no vault
  // and no keys, so every caller must treat this login as not set up yet.
  if (entry && entry.status === "provisioning") return null;
  return entry;
}

export async function getRawUser(subject) {
  const registry = await registryFile.read();
  return registry.users[subject] || null;
}

export async function getUserByVault(vaultId) {
  const registry = await registryFile.read();
  return (
    Object.values(registry.users).find((entry) => entry.vaultId === vaultId) ||
    null
  );
}

export async function listUsers() {
  const registry = await registryFile.read();
  return Object.values(registry.users);
}

export async function saveUser(entry) {
  return registryFile.mutate((registry) => {
    registry.users[entry.subject] = {
      ...registry.users[entry.subject],
      ...entry,
      updatedAt: new Date().toISOString(),
    };
    return registry.users[entry.subject];
  });
}

export async function patchUser(subject, patch) {
  return registryFile.mutate((registry) => {
    const current = registry.users[subject];
    if (!current) throw new Error("no registry entry for this login");
    registry.users[subject] = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return registry.users[subject];
  });
}

// Claim the invite code and a capacity slot in one atomic step, before any
// slow on-chain work. The old check-then-provision sequence let two logins
// racing through setup both pass the checks and then both provision.
export async function claimSignup(subject, inviteCode) {
  const code = String(inviteCode || "").trim();
  if (!code || !config.inviteCodes.includes(code)) {
    return { ok: false, status: 403, reason: "That invite code was not recognized." };
  }
  const digest = hashInvite(code);
  return registryFile.mutate((registry) => {
    const mine = registry.users[subject];
    if (mine && mine.status !== "provisioning") {
      return { ok: true, already: true };
    }
    const clash = Object.values(registry.users).find(
      (entry) => entry.subject !== subject && entry.inviteCodeHash === digest,
    );
    if (clash) {
      return {
        ok: false,
        status: 403,
        reason:
          clash.status === "provisioning"
            ? "That invite code is being used by a setup already in progress."
            : "That invite code has already been used.",
      };
    }
    const others = Object.values(registry.users).filter(
      (entry) => entry.subject !== subject,
    ).length;
    if (others >= config.maxUsers) {
      return {
        ok: false,
        status: 403,
        reason: `This deployment is limited to ${config.maxUsers} accounts and it is full.`,
      };
    }
    registry.users[subject] = {
      subject,
      status: "provisioning",
      inviteCodeHash: digest,
      createdAt: new Date().toISOString(),
    };
    return { ok: true, already: false, digest };
  });
}

// Drop a placeholder claim after a failed setup so the invite and the slot
// are only held while work is genuinely in flight. A server crash between
// claim and release leaves the claim behind on purpose: the same login can
// always retry and re-claim it, while nobody else can slip in.
export async function releaseSignup(subject) {
  return registryFile.mutate((registry) => {
    const entry = registry.users[subject];
    if (entry && entry.status === "provisioning") {
      delete registry.users[subject];
      return true;
    }
    return false;
  });
}

export async function countUsers() {
  const registry = await registryFile.read();
  return Object.keys(registry.users).length;
}

export async function getAgentRecord(vaultId) {
  const agents = await agentsFile.read();
  return agents.agents[vaultId] || null;
}

export async function saveAgentRecord(vaultId, record) {
  return agentsFile.mutate((agents) => {
    agents.agents[vaultId] = { ...record, savedAt: new Date().toISOString() };
    return agents.agents[vaultId];
  });
}

const MAX_ACTIVITY = 60;

export async function appendActivity(vaultId, item) {
  return activityFile.mutate((activity) => {
    const list = activity.vaults[vaultId] || [];
    list.unshift({
      id: randomBytes(6).toString("hex"),
      at: new Date().toISOString(),
      ...item,
    });
    activity.vaults[vaultId] = list.slice(0, MAX_ACTIVITY);
    return activity.vaults[vaultId][0];
  });
}

export async function listActivity(vaultId) {
  const activity = await activityFile.read();
  return activity.vaults[vaultId] || [];
}
