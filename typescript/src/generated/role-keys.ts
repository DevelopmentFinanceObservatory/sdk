// Generated from contract/rules/role-keys.json by `pnpm generate`. Do not edit by hand.

export const ROLE_KEYS = {
  place: "observationAbout",
  origin: "origin",
  destination: "destination",
} as const;

export const FLOW_KEYS = ["origin", "destination"] as const;

export const COLUMN_ROLE_KEYS: Readonly<Record<string, string>> = {
  provider: "origin",
  creditor: "origin",
  source: "origin",
  financingProvider: "origin",
  recipient: "destination",
  debtor: "destination",
  target: "destination",
  financingRecipient: "destination",
};
