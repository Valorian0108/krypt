// The vendors this demo agent can pay, and the guardrails a new account
// starts with. Amounts are in test dollars at the fixed demo rate; the
// server converts them to exact NEAR.
export const VENDORS = [
  {
    id: "data.eqxdemi.testnet",
    name: "Northstar Data",
    note: "Market data and research feeds",
  },
  {
    id: "agent.eqxdemi.testnet",
    name: "Field Notes",
    note: "Independent research notes",
  },
];

export const DEFAULT_RULES = {
  capUsd: "2.00",
  autoUsd: "0.40",
  budgetUsd: "2.00",
  periodDays: 7,
  payees: [],
};

export const PERIOD_CHOICES = [
  { days: 1, label: "per day" },
  { days: 7, label: "per week" },
  { days: 30, label: "per month" },
];
