import type { User, Vault } from "./types";

// A vault counts as onboarded once the registered agent matches the user's
// agent. Limits are not part of this test: zero limits are a valid paused
// account, and a failed read is handled by the caller, never as "new user".
export function isOnboarded(vault: Vault, user: User): boolean {
  return vault.status.agent === user.agentId;
}
