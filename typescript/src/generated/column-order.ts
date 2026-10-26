// Generated from contract/rules/column-order.json by `pnpm generate`. Do not edit by hand.

export const READING_COLUMNS = [
  ["time_period"],
  ["financingProvider_label", "financingProvider"],
  ["financingRecipient_label", "financingRecipient"],
  ["observationAbout_label", "observationAbout"],
  ["crsPurpose_label", "stat_var_crsPurpose"],
  ["value"],
  ["unit_label", "unit"],
  ["crsTypeOfFlow_label", "stat_var_crsTypeOfFlow", "dac2aAidType_label", "stat_var_dac2aAidType"],
  ["provenance_label", "provenance"],
] as const;
