// Generated from contract/strict-fields.json and contract/served/openapi.json by `pnpm generate`. Do not edit by hand.

export const STRICT_SCHEMAS = {
  ArtifactEntryModel: { required: ["artifact_digest", "rendering", "url"], children: {} },
  CandidateSet: { required: ["specs"], children: { specs: { items: { ref: "Spec" } } } },
  CandidatesPart: {
    required: ["status", "candidates"],
    children: { candidates: { ref: "CandidateSet" } },
  },
  DefinitePart: { required: ["status", "spec"], children: { spec: { ref: "Spec" } } },
  DefinitionModel: { required: ["spec_id"], children: {} },
  Manifest: {
    required: ["definition", "content_version", "artifacts"],
    children: {
      definition: { ref: "DefinitionModel" },
      artifacts: { items: { ref: "ArtifactEntryModel" } },
    },
  },
  NearestRealSpec: {
    required: [],
    children: { definition: { ref: "SpecDefinition" }, resolved: { ref: "ResolvedSpec" } },
  },
  NoData: {
    required: ["reason"],
    children: {
      nearest_real: { items: { ref: "NearestRealSpec" } },
      flagged_match: { ref: "Spec" },
      alternate_match: { ref: "Spec" },
    },
  },
  NoDataPart: { required: ["status", "no_data"], children: { no_data: { ref: "NoData" } } },
  OperationEnvelope: { required: ["operation_id", "status"], children: {} },
  OperationResource: {
    required: ["operation"],
    children: { operation: { ref: "OperationEnvelope" } },
  },
  OptionsEnvelope: { required: [], children: { definition: { ref: "DefinitionModel" } } },
  RelatedMeasure: { required: [], children: { definition: { ref: "SpecDefinition" } } },
  Resolution: {
    required: ["parts"],
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
  ResolvedSpec: {
    required: [],
    children: {
      equivalent_readings: { items: { ref: "Spec" } },
      alternative_measures: { items: { ref: "SpecAlternativeMeasure" } },
      related_measures: { items: { ref: "RelatedMeasure" } },
    },
  },
  Spec: {
    required: ["spec_id", "definition"],
    children: { definition: { ref: "SpecDefinition" }, resolved: { ref: "ResolvedSpec" } },
  },
  SpecAlternativeMeasure: { required: [], children: { definition: { ref: "SpecDefinition" } } },
  SpecDefinition: { required: ["spec_id"], children: {} },
  Unsupported: { required: ["code"], children: {} },
  UnsupportedPart: {
    required: ["status", "unsupported"],
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
