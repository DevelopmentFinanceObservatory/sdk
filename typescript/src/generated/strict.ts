// Generated from contract/strict-fields.json and contract/served/openapi.json by `pnpm generate`. Do not edit by hand.

export const STRICT_SCHEMAS = {
  ArtifactEntryModel: {
    required: { artifact_digest: "string", rendering: "object", url: "string" },
    children: {},
  },
  CandidateSet: { required: { specs: "array" }, children: { specs: { items: { ref: "Spec" } } } },
  CandidatesPart: {
    required: { status: "string", candidates: "object" },
    children: { candidates: { ref: "CandidateSet" } },
  },
  DefinitePart: {
    required: { status: "string", spec: "object" },
    children: { spec: { ref: "Spec" } },
  },
  DefinitionModel: { required: { spec_id: "string", identity: "object" }, children: {} },
  Manifest: {
    required: { definition: "object", content_version: "string", artifacts: "array" },
    children: {
      definition: { ref: "DefinitionModel" },
      artifacts: { items: { ref: "ArtifactEntryModel" } },
    },
  },
  NoData: { required: { reason: "string" }, children: {} },
  NoDataPart: {
    required: { status: "string", no_data: "object" },
    children: { no_data: { ref: "NoData" } },
  },
  OperationEnvelope: { required: { operation_id: "string", status: "string" }, children: {} },
  OperationResource: {
    required: { operation: "object" },
    children: { operation: { ref: "OperationEnvelope" } },
  },
  Resolution: {
    required: { parts: "array" },
    children: {
      parts: {
        items: {
          discriminator: "status",
          mapping: {
            candidates: "CandidatesPart",
            definite: "DefinitePart",
            no_data: "NoDataPart",
            unsupported: "UnsupportedPart",
          },
        },
      },
    },
  },
  Spec: {
    required: { spec_id: "string", definition: "object", resolved: "object" },
    children: { definition: { ref: "SpecDefinition" } },
  },
  SpecDefinition: { required: { spec_id: "string", identity: "object" }, children: {} },
  Unsupported: { required: { code: "string" }, children: {} },
  UnsupportedPart: {
    required: { status: "string", unsupported: "object" },
    children: { unsupported: { ref: "Unsupported" } },
  },
} as const;

export const STRICT_ENUMS = {
  Resolution: { kind: ["resolution"] },
  CatalogueAnswer: { kind: ["catalogue"] },
  DeclinedAnswer: { kind: ["declined"] },
  DefinitePart: { status: ["definite"] },
  CandidatesPart: { status: ["candidates"] },
  NoDataPart: { status: ["no_data"] },
  UnsupportedPart: { status: ["unsupported"] },
  OperationEnvelope: { status: ["pending", "running", "done", "failed"] },
} as const;
