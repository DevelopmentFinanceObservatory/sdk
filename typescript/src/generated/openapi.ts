// Generated from contract/served/openapi.json by `pnpm generate`. Do not edit by hand.
import type { UnknownPart } from "../unknown-part.ts";

export interface paths {
  "/api/search/resolve": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Resolve */
    post: operations["search_resolve"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/search/options": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * List Options
     * @description The options door: on-demand candidate enumeration for one resolved
     *     entity role (origin, destination, or observationAbout) of a posted
     *     identity, queried independently of the /resolve pipeline and fetched
     *     lazily when a user opens an editor.
     *
     *     Composes engine.options.resolve.resolve_options_target (derive the
     *     posted identity's own StatVar population, typed anchors and
     *     role-target validity, server-side, with no resubmit or materialise
     *     pipeline) with engine.options.surface.compute_options (compute the
     *     per-role option surface), then assembles the envelope here --
     *     see those two modules' own docstrings for the full design, including
     *     the option_target_invalid (422) role check that runs inside
     *     resolution. Every EngineInputError either half raises propagates
     *     uncaught to classify_search_exception above, the same RFC 9457
     *     problem body every other door's refusal returns -- no bespoke
     *     handling here.
     *
     *     resolve_options_target always runs, hit or miss on the response
     *     cache below: it is what runs validate_edited_identity and the role/
     *     anchor refusals, and none of those may be skipped just because an
     *     identical target was already answered once. Only build_options_
     *     response's own compute -- the graph/SDMX work -- is what a cache hit
     *     skips; see options.options_response_cache's own module docstring for
     *     the key and the warning-free-result caching rule.
     */
    post: operations["search_list_options"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/search/healthz": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Health */
    get: operations["search_get_health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/search/schema": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Schema */
    get: operations["search_get_schema"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/search/capabilities": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Capabilities */
    get: operations["search_get_capabilities"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/search/catalogue": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Catalogue
     * @description What DFO holds and example sentences to ask of it, from the published
     *     search catalogue. `place` scopes the counts to one country and offers the
     *     examples whose StatVar has data there, filled with its name.
     */
    get: operations["search_get_catalogue"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/healthz": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Health */
    get: operations["datasets_get_health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/schema": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Schema */
    get: operations["datasets_get_schema"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/capabilities": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Capabilities */
    get: operations["datasets_get_capabilities"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/operations/{operation_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Operation */
    get: operations["datasets_get_operation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/register": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Register */
    post: operations["datasets_register"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Mint */
    post: operations["datasets_mint"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Definition */
    get: operations["datasets_get_definition"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/options": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Definition Options
     * @description The definition's current version with no rendering, reported as
     *     `output_options`: what the data honours. A rebuild records the version and advances
     *     the head as a GET does. Any query key refuses `request_invalid` with an
     *     `/options/<key>` pointer, the same `QueryOptionsInvalid` this door's `get_definition`
     *     raises for a query key outside its own namespace, through the same
     *     `query_options.pointer_for_key` mapping.
     */
    get: operations["datasets_get_definition_options"];
    put?: never;
    /**
     * Post Definition Options
     * @description The GET route's envelope for a spec id whose canonical `definition` the body
     *     carries, registered or not. An unregistered definition is admitted as a mint admits a
     *     sidecar, registered, and served as the GET route serves a registered one, so the
     *     mint that follows is a head hit. Query keys refuse as on the GET route.
     */
    post: operations["datasets_post_definition_options"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/members": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Post Definition Members
     * @description The members a mint of the spec serves, resolved without materialising a frame:
     *     each member's ref, label, declared roles and constraints, their count, and the
     *     family's count and digest. The body may carry the spec's canonical `definition`,
     *     which an unregistered id needs; it is admitted as a mint admits a sidecar and nothing
     *     is registered. Refusals are the mint's member refusals. Query keys refuse as on the
     *     options route.
     */
    post: operations["datasets_post_definition_members"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/frames/refresh": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Refresh Frame
     * @description Whether the named dataset frame is still its rendering's current frame. Answers
     *     `current`, `moved` with the current frame, or `pending` with the queued rebuild.
     */
    post: operations["datasets_refresh_frame"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/frames/{spec_id}/{content_version}/recipe": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Recipe */
    get: operations["datasets_get_recipe"];
    /** Put Recipe */
    put: operations["datasets_put_recipe"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/recipes/replays/{replay_key}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Replay */
    get: operations["datasets_get_replay"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/versions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List Versions */
    get: operations["datasets_list_versions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Snapshot */
    get: operations["datasets_get_snapshot"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}/description": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Description */
    get: operations["datasets_get_description"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}/description/values": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Description Values */
    get: operations["datasets_get_description_values"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}/files/{digest}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get File */
    get: operations["datasets_get_file"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}/file": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get Version File
     * @description Redirect to the version's file in the format, bundle and layout the query names,
     *     renewing an aged copy whose bytes survive, else rendering it from the version's stored
     *     frame.
     */
    get: operations["datasets_get_version_file"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}/observations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Observations */
    get: operations["datasets_get_observations"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/{id}/{content_version}/pin": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Post Pin
     * @description Pin an artifact of a version, and the frame its files render from: the version's own frame and, for a derived version, its base version's frame, servable or aged, so every format stays fetchable and the version reports `retention.pinned`. A frame whose bytes are gone stays unpinned: the named artifact still pins, and `retention` keeps that frame's `held_until`. Only the named artifact's copy waits on the daily pin budget; the frame copies skip it and count toward later calls, so one pin can add up to three copies to the count.
     */
    post: operations["datasets_post_pin"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/datasets/frames/publish": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Post Publish
     * @description Publish a validated body under the permit the route class took for this request.
     */
    post: operations["datasets_post_publish"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/healthz": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Health */
    get: operations["graph_get_health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/capabilities": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Capabilities */
    get: operations["graph_get_capabilities"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/schema": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Schema */
    get: operations["graph_get_schema"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/resolve": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Resolve */
    post: operations["graph_resolve"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/documentation/{dcid}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Documentation */
    get: operations["graph_get_documentation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List Sources */
    get: operations["graph_list_sources"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/node/{dcid}/members": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List Members */
    get: operations["graph_list_members"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/roots": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List Roots */
    get: operations["graph_list_roots"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/node/{dcid}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Node */
    get: operations["graph_get_node"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/graph/nodes": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Get Nodes */
    post: operations["graph_get_nodes"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/healthz": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Health */
    get: operations["presentation_get_health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/capabilities": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Capabilities */
    get: operations["presentation_get_capabilities"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/components": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Create Component */
    post: operations["presentation_create_component"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/components/{component_id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Read Component */
    get: operations["presentation_read_component"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Revise Component */
    patch: operations["presentation_revise_component"];
    trace?: never;
  };
  "/api/presentation/components/{component_id}/revisions/{revision}/data": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Read Component Data */
    get: operations["presentation_read_component_data"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/components/{component_id}/revisions/{revision}/render": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Render Component Revision
     * @description Draw one stored revision on the frame the body names. Appends no revision.
     */
    post: operations["presentation_render_component_revision"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/components/{component_id}/revisions/{revision}/render/data": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read Rendered Component Data
     * @description The data export of one stored revision drawn on the frame the query names.
     */
    get: operations["presentation_read_rendered_component_data"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/frames/{spec_id}/{content_version}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Frame */
    get: operations["presentation_get_frame"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/presentation/release": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Release */
    get: operations["presentation_get_release"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/codes/{code}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Get Code */
    get: operations["codes_get_code"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    /** AggregateNode */
    AggregateNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "aggregate";
      aggregate: components["schemas"]["PartyBlock"];
    };
    /**
     * AidCounts
     * @description Counts over the coverage index's rows of the declared datasets.
     */
    AidCounts: {
      /**
       * Donors
       * @description distinct donors: countries and organisations, leaving out the parties that total other donors (DAC countries, the G7)
       */
      donors: number;
      /**
       * Recipients
       * @description distinct recipients: countries, organisations and the residuals no country holds (Africa, unallocated by country), leaving out the parties that total other recipients (Africa, Total)
       */
      recipients: number;
      /** @description the years with aid data; null when none */
      years: components["schemas"]["YearRange"] | null;
    };
    /**
     * AmbiguousEntityCandidate
     * @description One graph node an ambiguous query wording could name -- one entry of
     *     an AmbiguousEntityGroup's own `candidates`. Mirrors engine.region.result.
     *     AmbiguousEntityCandidate field-for-field, with `label` in place of that
     *     dataclass's `name` (this contract's own vocabulary for a display
     *     string, matching ResolvedEntity.label), except that it omits `group_node`
     *     and `group_name`, which only NoData.options read.
     */
    AmbiguousEntityCandidate: {
      /**
       * Ref
       * @description the candidate's own dcid
       */
      ref: string;
      /**
       * Label
       * @description the candidate's display name
       */
      label: string;
      /**
       * Kind
       * @description the candidate's entity kind: country, continent, subregion, continental_union, organisation, aggregate, place_other, or other
       */
      kind: string;
    };
    /**
     * AmbiguousEntityGroup
     * @description One query wording Ambiguous resolved to more than one graph
     *     candidate, paired with the candidates it could name -- one entry of
     *     NoData.ambiguous_entities.
     */
    AmbiguousEntityGroup: {
      /**
       * Text
       * @description the ambiguous query wording; equals some restatement.entities[i].text on the same part
       */
      text: string;
      /**
       * Candidates
       * @description the graph candidates this wording could name -- 2+ from a real Ambiguous resolution, by construction of the resolver's own Ambiguous outcome (2+ candidates graph-confirm and none can be preferred); not constrained to a minimum here since region.AmbiguousEntity, this field's own engine-side source, carries no such constraint of its own
       */
      candidates: components["schemas"]["AmbiguousEntityCandidate"][];
    };
    /**
     * AmbiguousSourceCandidate
     * @description One reading of an ambiguous source wording -- one entry of an
     *     AmbiguousSourceGroup's own `candidates`.
     */
    AmbiguousSourceCandidate: {
      /**
       * Ref
       * @description the source's reference, which a client posts back as a SourceMention's ref
       */
      ref: string;
      /**
       * Label
       * @description the source's display name in the origin catalogue
       */
      label: string;
      /**
       * Kind
       * @description what the reference names: a provenance, a catalogue Dataset, or a publishing Source
       */
      kind: ("provenance" | "dataset" | "source") | (string & {});
    };
    /**
     * AmbiguousSourceGroup
     * @description One source wording that names two or more unrelated admitted sources, paired with
     *     the sources it could name -- one entry of NoData.ambiguous_sources.
     */
    AmbiguousSourceGroup: {
      /**
       * Text
       * @description the ambiguous wording; equals some restatement.sources[i].text on the part, or its restatement.source_code for source_code_ambiguous
       */
      text: string;
      /**
       * Candidates
       * @description the admitted sources this wording names, two or more: provenances first, then datasets and sources
       */
      candidates: components["schemas"]["AmbiguousSourceCandidate"][];
    };
    /**
     * AppliedDefaultModel
     * @description One `fact_summary.defaults[]` entry: a choice the component made where its intent
     *     left one open. An entity-mode bar_chart whose select lists no values draws every value
     *     of its one varying dimension, largest first.
     */
    AppliedDefaultModel: {
      /**
       * Pointer
       * @description a JSON Pointer to the intent field this default fills
       */
      pointer: string;
      /**
       * Detail
       * @description what the component chose and how to narrow it, in plain language
       */
      detail: string;
    };
    /** ArtifactEntryModel */
    ArtifactEntryModel: {
      /** Artifact Digest */
      artifact_digest: string;
      /**
       * Rendering
       * @description the rendering that produced the bytes: the request options of a requested file, {"statistics": "series"} for the series statistics, or {"format": "frame"} for the version's canonical frame, a Parquet file of the frame as minted
       */
      rendering: {
        [key: string]: unknown;
      };
      /** Bytes */
      bytes: number;
      /** Media Type */
      media_type: string;
      /** Created At */
      created_at: string;
      /** Tier */
      tier: string;
      /**
       * Url
       * @description the artifact's stable download link, `/api/datasets/{id}/{content_version}/files/{artifact_digest}`, relative to the API host. It never expires: each request checks the version and answers 302 to a signed URL valid for five minutes, or refuses snapshot_revoked once the version is taken down
       */
      url: string;
    };
    /**
     * Assumption
     * @description One value the answer filled that its request did not ask for, stated for people
     *     in `text` and for code in `kind`, `binding_ref` and `refs`.
     *
     *     Assumptions live on the part (`_PartBase.assumptions`), and a candidates part holds
     *     each shown reading's own list as well (`CandidatesPart.reading_assumptions`), the one
     *     a client echoes on a dataset_resubmit after picking that reading. The sentence that
     *     carries the part closes with them as one clause: "Assumed: official development
     *     assistance; every provider."
     */
    Assumption: {
      /**
       * Kind
       * @description what the engine filled. 'declared_default' is a slot the request left open that its code system's or shape's declared default fixed. 'open_role' is a flow role no request word asked for, read across every entity on it with data, as one series per member where the role scope default filled it and the shape declares the role, else as the total over them. 'place_scope' is a request that named no place, read across every place with data
       */
      kind: ("declared_default" | "open_role" | "place_scope") | (string & {});
      /**
       * Binding Ref
       * @description the identity binding whose edit replaces this assumption: 'how:<property dcid>' for a declared default, 'origin:' or 'where:' for a role or the place scope, as on the sentence's own tokens
       */
      binding_ref: string;
      /**
       * Text
       * @description the words the sentence's assumptions clause states for this fill: the bound code's full label for a declared default ('official development assistance' for CRSTypeOfFlow10, whose short name is 'ODA'), 'every' and the role's noun in the answer's flow family for an open role ('every provider', 'every creditor'), and 'every country', 'every place' or 'the world as a whole' for the place scope, as its members are typed
       */
      text: string;
      /**
       * Refs
       * @description the value dcid a declared default bound its slot to, as the slot's trace.slot_filters[].refs list it (['CRSTypeOfFlow10'] for official development assistance). An open role and the place scope carry []. A dataset_resubmit echo matches a declared default to its slot by these values
       */
      refs?: string[];
    };
    /**
     * GraphMembershipAuthority
     * @description Where a membership's rows come from, with the data version that reproduces them.
     */
    Authority: {
      /** Name */
      name: string;
      /** Version */
      version: string;
    };
    /**
     * GraphAvailability
     * @description Where DFO holds observations of a variable. `sources: []` means it verifiably holds
     *     none.
     */
    Availability: {
      /**
       * Scope
       * @default dfo
       * @constant
       */
      scope: "dfo";
      summary: components["schemas"]["AvailabilitySummary"];
      /** @description null when no facet dispatches a request naming nothing */
      default: components["schemas"]["AvailabilityDefault"] | null;
      /** Sources */
      sources: components["schemas"]["SourceAvailability"][];
      /**
       * More Sources
       * @description the sources past the first ten
       */
      more_sources: number;
    };
    /**
     * GraphAvailabilityDefault
     * @description What a data request naming no place, years or facet receives.
     */
    AvailabilityDefault: {
      /**
       * Facets
       * @description the facet ids the request is served, in order
       */
      facets: string[];
      source: components["schemas"]["AvailabilitySource"] | null;
      unit: components["schemas"]["NodeRef"] | null;
      measurement_method: components["schemas"]["NodeRef"] | null;
      /** Observation Period */
      observation_period: string | null;
      /** First Year */
      first_year: string | null;
      /** Last Year */
      last_year: string | null;
      /**
       * Places
       * @description null for a role-bearing variable
       */
      places: number | null;
      /**
       * Without Data
       * @description the places, or parties, holding the variable that the default leaves without data
       */
      without_data: number;
    };
    /**
     * GraphAvailabilitySource
     * @description A source that holds the variable: its provenance, labelled with the catalogue's name.
     */
    AvailabilitySource: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
      /**
       * Documentation
       * @description the path of the provenance's source document
       */
      documentation: string;
    };
    /**
     * GraphAvailabilitySummary
     * @description The variable across every source.
     */
    AvailabilitySummary: {
      /**
       * Places
       * @description the places covered by kind; null for a role-bearing variable, and while the places' kinds are unread (a transient gap)
       */
      places: {
        [key: string]: number;
      } | null;
      /**
       * Entities
       * @description the entities covered per graph role; null for any other variable
       */
      entities: {
        [key: string]: components["schemas"]["EntityCounts"];
      } | null;
      /** First Year */
      first_year: string | null;
      /** Last Year */
      last_year: string | null;
      /** Sources */
      sources: number;
      /** Facets */
      facets: number;
    };
    /**
     * BaseIdentity
     * @description The spec1 identity-core projection document for one Spec: exactly what
     *     gets hashed to produce its spec_id, serialised once and echoed back
     *     verbatim -- never re-derived by a second, parallel implementation.
     *
     *     Every Spec carries one, on `Spec.definition.identity` (see
     *     `SpecDefinition`). A dataset_resubmit identity entry posts a prior Spec's own
     *     `definition.identity` byte-for-byte as its edited `identity`. Directional
     *     entities live directly in `identity.entities.origin` and
     *     `identity.entities.destination`. StatVar members are graph state, derived from the
     *     identity, and no member here.
     *
     *     The document is hashed whole. `"spec_"` plus the first 32 hex digits of
     *     the SHA-256 of its RFC 8785 serialisation, with null members omitted, is
     *     the Spec's spec_id.
     */
    BaseIdentity: {
      /**
       * Identity Version
       * @description the identity domain separator this Spec was hashed under
       * @default spec1
       * @constant
       */
      identity_version?: "spec1";
      /**
       * Shape
       * @description the shape this Spec was hashed under
       */
      shape:
        components["schemas"]["IdentityShapeSchema"] | components["schemas"]["IdentityShapePin"];
      /**
       * Slots
       * @description the what/how slots that feed identity -- where/when/source are excluded
       */
      slots: components["schemas"]["IdentitySlot"][];
      /**
       * Entities
       * @description the bound entities, keyed by role (observationAbout/origin/destination); {} when none were bound -- always present, never omitted. A role that appears carries at least one dcid: the identity core refuses a role with zero members, so an empty list must not be expressible here
       */
      entities?: {
        [key: string]: string[];
      };
      /**
       * Requested Window
       * @description the requested date window this Spec was hashed under; always present -- {"kind": "all"} means no date was requested at all
       */
      requested_window:
        | components["schemas"]["IdentityWindowAll"]
        | components["schemas"]["IdentityWindowLatest"]
        | components["schemas"]["IdentityWindowRange"];
      /**
       * Facets
       * @description sparse facet bindings (provenance/measurementMethod/unit); omitted entirely when no facet axis is bound, never an empty object. A facet axis that appears is bound -- value, set, or (unit axis only) the request form -- never unbound: the identity core refuses an unbound facet binding state, since a sparse map omits what is not bound rather than carrying it as unbound
       */
      facets?: {
        [key: string]:
          | components["schemas"]["IdentityBindingValue"]
          | components["schemas"]["IdentityBindingSet"]
          | components["schemas"]["IdentityFacetValueRequest"]
          | components["schemas"]["IdentityFacetValueAbsent"];
      } | null;
      /**
       * Open Roles
       * @description the flow axes asked for member by member (every creditor, every donor), sorted and de-duplicated; omitted when none is. A role absent from both entities and open_roles asks for the total over that role. An open role is never also an entities key, and a pinned shape (kind='stat_var') carries none
       */
      open_roles?: components["schemas"]["RoleAxis"][] | null;
    };
    /**
     * GraphAvailabilityBinding
     * @description The `scope.facets` values that request a series from Datasets, in its leading unit.
     */
    Binding: {
      /** Provenance */
      provenance: string;
      /** Measurementmethod */
      measurementMethod: string | null;
      /** Unit */
      unit: string | null;
    };
    /**
     * BindingSet
     * @description A slot bound to two or more taxonomy members, all in scope.
     */
    BindingSet: {
      /**
       * @description binding kind discriminator (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "set";
      /**
       * Values
       * @description two or more members, all in scope (a union)
       */
      values: components["schemas"]["SlotValue"][];
      /** @description the group the set was drawn from, when one exists */
      set_ref?: components["schemas"]["GraphRef"] | null;
    };
    /**
     * BindingUnbound
     * @description A slot explicitly open to the whole slot in scope, NOT null or missing.
     */
    BindingUnbound: {
      /**
       * @description explicit whole slot in scope, NOT null/missing (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "unbound";
    };
    /**
     * BindingValue
     * @description A slot bound to exactly one taxonomy member.
     */
    BindingValue: {
      /**
       * @description binding kind discriminator (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "value";
      /** @description exactly one taxonomy member */
      value: components["schemas"]["SlotValue"];
    };
    /**
     * BreadthDim
     * @description One breadth dimension with its cardinality.
     */
    BreadthDim: {
      /**
       * Label
       * @description the dimension, e.g. providers, years, methods, sources
       */
      label: string;
      /**
       * Count
       * @description e.g. 36, 22, 3
       */
      count: number;
    };
    /** BundleOptionModel */
    BundleOptionModel: {
      /** State */
      state: string;
      /** Reason */
      reason?: string | null;
    };
    /**
     * CandidateSet
     * @description A set of 2..N competing Specs, presented in the order named by ``ordering``.
     *
     *     ``ordering="intent_rank"``: the order the status rule offers the readings in. A first
     *     answer always uses it. The elected reading comes first, then its rivals in menu order,
     *     each stating why it is offered (``ResolvedSpec.basis``). Where the elected reading holds
     *     no data and several siblings differing from it only on the measurement qualifier do,
     *     those siblings are the set, in menu order, without it. Where a place named without a
     *     direction holds data under both, the elected reading under each direction is offered.
     *
     *     ``ordering="broadest_first"``: a posted candidates entry that names it
     *     (``ResubmitCandidatesEntry``) keeps its posted order and states this ordering back. No
     *     first answer uses it.
     *
     *     Each candidate carries its own heading and byline inside its own
     *     ``resolved.rendered_sentence``/``resolved.sentence_plan``. There is no separate parallel sentence array, and a
     *     candidate's Spec is a returned Spec like any other. The part's own
     *     sentence opens with how many readings there are and states, for each
     *     shown candidate, the source and span that set it apart.
     */
    CandidateSet: {
      /**
       * Ordering
       * @description how `specs` below is ordered -- see the two orderings described above
       */
      ordering: ("broadest_first" | "intent_rank") | (string & {});
      /**
       * Max Candidates
       * @description the maximum number of candidates applied
       */
      max_candidates: number;
      /**
       * Specs
       * @description 2 <= len <= max_candidates; full Specs, ordered per `ordering` above
       */
      specs: components["schemas"]["Spec"][];
      /**
       * Truncated
       * @description false when every eligible, semantically distinct candidate shape found for this query is present in specs; true when the engine's own candidate budget dropped an eligible shape before it could be considered, or max_candidates itself cut the ordered list short
       */
      truncated: boolean;
    };
    /**
     * CandidatesPart
     * @description This part's variable was genuinely ambiguous; two or more distinct specs compete.
     */
    CandidatesPart: {
      /**
       * Variable Text
       * @description the variable text this part answers, in the order asked. This part's position in Resolution.parts equals the same variable_index every SSE event keyed by variable_index uses (ShapeEvent, StepEvent, SentenceEvent). Every dataset_resubmit entry kind (identity, candidates, placeholder, and parsed through its nested ParsedPart) requires its own posted variable_text, so this field is always the posted text echoed back onto the rebuilt part, never null. Null only when the whole posted query was empty or whitespace-only (raw_text door), which refuses variable_not_resolved before extraction runs and so has no text to name.
       */
      variable_text?: string | null;
      /**
       * Separate
       * @description true when this part was asked beside the others to be compared with them. A client resubmitting an identity, candidate set, or placeholder posts this flag on that entry to preserve the comparison. Two parts marked separate that resolve to one reading carry the same spec_id and stay two parts. False, the default, is omitted
       * @default false
       */
      separate?: boolean;
      /**
       * Warnings
       * @description this part's own run-health signals. A part folded into an earlier part's spec (see DefinitePart.spec) carries binding_folded alone. The merged spec's own resolved warnings live only on the first part that carries it. An unfolded part carries the warnings raised while resolving this part, plus observations_omitted on a candidates part when response_options.include_observations was set.
       */
      warnings?: components["schemas"]["Warning"][];
      /** @description this part's own latency breakdown, where by_step names only the phases this part ran and total sums them, leaving out the shape_* stages nested inside shape. Excludes the shared, once-per-request steps (e.g. extract), which diagnostics.timing_ms.by_step carries once for the whole request; distinct too from diagnostics.timing_ms.total, the whole request's wall-clock elapsed time. */
      timing_ms?: components["schemas"]["Timing"] | null;
      /**
       * Rendered Sentence
       * @description a human-readable string. For candidates, a header naming how many readings there are ('3 readings.'), then each shown candidate's heading and a byline led by the source and span that set it apart; for no_data, a heading in the same claim form naming the entity, measure, and counterpart that were checked. Either ends with the text of this part's departures, in order, and a candidates part's then closes with its assumptions clause. For a definite part this stays null or omitted: the confirmation sentence (heading and byline) lives at spec.resolved.rendered_sentence, and its departures reach the envelope's composed sentence.
       */
      rendered_sentence?: string | null;
      /**
       * Sentence Plan
       * @description the ordered token form of rendered_sentence, present whenever it is. For a definite part this stays null or omitted. spec.resolved.sentence_plan carries the confirmation sentence's own plan instead.
       */
      sentence_plan?: components["schemas"]["SentenceToken"][] | null;
      /** @description the ParsedPart that reproduces this part's own resolution inputs -- the same entities, resolved time window, unit text, and source text the engine actually used to resolve this one leg -- so a client holding this part alone can copy it straight into a fresh ParsedInput.parts entry and re-resolve it faithfully, without flattening it into the whole query's variable_text the way variable_text alone would. Canonical, not verbatim: for a raw_text part, time_text is the equivalent phrase this door's own time grammar recognises (e.g. '2015 to 2020'), not the user's original words, since the engine's date extraction keeps only the structured window and discards the phrasing. Null whenever this part has no faithful echo to give. On a dataset_resubmit entry's identity/candidates/placeholder kinds, which post an identity or stub rather than a phrase and have no per-part resolution inputs to echo -- a dataset_resubmit parsed entry, genuinely re-resolved from its own posted ParsedPart, carries a real one like any parsed-door part. Also null when this leg's entity was bound to a directional role axis (origin/destination) and no door-supplied role named that axis, since an echo without the axis would resubmit the request with that entity reversed. Also null when one of this leg's own inputs does not fit ParsedPart's own field caps, since a truncated echo would misrepresent what was actually resolved. */
      restatement?: components["schemas"]["ParsedPart"] | null;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
      /**
       * Departures
       * @description every way this part's answer differs from what its request asked, ordered by how much each changes the number: closest_match, measure_not_applied, operation_not_applied, breakdown_not_applied, entity_unavailable, year_unavailable, modelled_values, group_read_as_members, direction_discarded, direction_inferred, scope_limited. [] when the answer is what was asked. A client that renders its own sentence reads them here; each one's text also closes the sentence that carries this part (see Departure.text). A warning on the same part reports run health and stays separate
       */
      departures?: components["schemas"]["Departure"][];
      /**
       * Assumptions
       * @description every value the engine filled that the request did not ask for, in clause order. Declared defaults come first, in the order of the Spec's trace.slot_filters, then open roles, then the place scope. A declared default is a slot the request left open that its code system's or shape's declared default fixed, named by the bound code's full label. An open role is a flow role no request word asked for, read across every entity on it with data. It is either a role the role scope default filled (resolved.scope on that axis), whatever its member count, served as one series per member where the shape declares the role, or a role the heading states with no entity of its own ('from 164 providers', 'owed to all creditors'), served as the total over its members. A role the identity binds in entities or lists in open_roles, that one of the part's operations runs over ('top 5 donors'), or that the request's words asked every member of ('all donors'), is asked. The place scope is a request that named no place, read across every place with data. Every door fills assumptions. A definite part reads them from its Spec, a candidates part carries the items every list in CandidatesPart.reading_assumptions holds alike, text included, and no_data and unsupported parts carry []. A dataset_resubmit identity entry posts every slot bound, so its part states the items of the entry's assumptions echo that still hold (see ResubmitIdentityEntry.assumptions), and a candidates entry reads each reading with its candidate's echo (see ResubmitCandidate.assumptions). The sentence that carries this part closes with them as one segment='assumption' clause ('Assumed: official development assistance; every provider.'), after its departures. [] when the answer fills nothing
       */
      assumptions?: components["schemas"]["Assumption"][];
      /**
       * @description this part's variable was genuinely ambiguous (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      status: "candidates";
      /** @description 2..N competing Specs */
      candidates: components["schemas"]["CandidateSet"];
      /**
       * Reading Assumptions
       * @description each shown reading's own assumptions, keyed by its Spec's spec_id (candidates.specs[].spec_id). Each list is the one a definite part answering that Spec for this part's request carries, read with the part's operations and the axes the request's words asked every member of. The part's own assumptions are the items every list here holds alike, text included, so an open role one reading reads, or an item two readings word differently ('every provider' against 'every creditor'), is stated here alone. A client that picks a reading posts its identity as a dataset_resubmit identity entry and echoes reading_assumptions[spec_id] as the entry's assumptions, so the picked answer states what that reading assumed. A client that edits the set echoes each reading's entry as its candidate's assumptions. [] for a reading that assumes nothing
       */
      reading_assumptions?: {
        [key: string]: components["schemas"]["Assumption"][];
      };
    };
    /**
     * CanonicalDefinition
     * @description One canonical definition, exactly as the contract shapes it: the wire
     *     version it was written under, its own spec_id (required -- the register
     *     door always verifies a supplied id, never mints one for a definition),
     *     and its identity-core document.
     */
    CanonicalDefinition: {
      /**
       * Schema Version
       * @description the wire version this definition was written under
       * @constant
       */
      schema_version: 1;
      /**
       * Spec Id
       * @description the caller-supplied spec_id this definition must hash to
       */
      spec_id: string;
      /**
       * Identity
       * @description the identity-core document, shaped as search.models.identity.BaseIdentity and published at GET /api/search/schema
       */
      identity: {
        [key: string]: unknown;
      };
    };
    /**
     * CapabilitiesResponse
     * @description `GET /api/presentation/capabilities`'s body. It carries this
     *     surface's own hashed `capability_version` beside the unhashed
     *     `catalog_version`.
     */
    CapabilitiesResponse: {
      /**
       * Capability Version
       * @description a content hash over every capability-bearing field of the release this deployment serves
       */
      capability_version: string;
      /**
       * Catalog Version
       * @description the catalogue release this deployment serves
       */
      catalog_version: string;
      /**
       * Build
       * @description the commit sha the image was built from, the same value the x-dfo-commit response header carries
       */
      build: string;
    };
    /**
     * CapabilityDefaultPolicy
     * @description One declared default policy: whether it is live, and its current
     *     default value when it is a simple boolean toggle.
     */
    CapabilityDefaultPolicy: {
      /**
       * Name
       * @description the declared default policy's name
       */
      name: string;
      /**
       * Live
       * @description whether this deployment honours the declared default
       */
      live: boolean;
      /**
       * Default
       * @description the current default value, when this policy is a boolean toggle
       */
      default?: boolean | null;
    };
    /**
     * CapabilityFormat
     * @description One output rendering's liveness in this deployment.
     */
    CapabilityFormat: {
      /**
       * Name
       * @description csv, xlsx, or parquet
       */
      name: string;
      /**
       * Live
       * @description whether this deployment can render this format
       */
      live: boolean;
    };
    /**
     * CapabilityKind
     * @description One mint-request `kind`'s liveness in this deployment.
     */
    CapabilityKind: {
      /**
       * Name
       * @description spec_id or statvar_set
       */
      name: string;
      /**
       * Live
       * @description whether this deployment's mint door dispatches this kind
       */
      live: boolean;
    };
    /**
     * CatalogueAnswer
     * @description A resolve response to a question that asks what DFO holds and names
     *     neither an indicator nor a subject, such as "what data do you have?". It
     *     carries the country the question named, when the resolver confirms one.
     */
    CatalogueAnswer: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1. Required on every response.
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** @description what the response was understood to be answering */
      query_echo: components["schemas"]["QueryEcho"];
      /** @description run health, warnings, timing, build stamp */
      diagnostics: components["schemas"]["Diagnostics"];
      /**
       * @description discriminator for a response to a question about what DFO holds (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "catalogue";
      /** @description the place the question named, when it named a country */
      scope: components["schemas"]["Scope-Output"];
    };
    /**
     * CatalogueExampleSentence
     * @description An example sentence a client offers and runs as a query.
     */
    CatalogueExampleSentence: {
      /**
       * Text
       * @description the template filled with the place's name
       */
      text: string;
      /**
       * Template
       * @description the sentence with a {place} slot
       */
      template: string;
      /**
       * Stat Var
       * @description the StatVar the sentence resolves to
       */
      stat_var: string;
      /**
       * Place
       * @description the country dcid the sentence is filled with
       */
      place: string;
    };
    /**
     * CatalogueResponse
     * @description What DFO holds and example sentences to ask of it.
     */
    CatalogueResponse: {
      /**
       * Catalogue Version
       * @description the published build this body comes from
       */
      catalogue_version: string;
      /**
       * Counts
       * @description global counts, or the counts at the requested place
       */
      counts: components["schemas"]["Counts"] | components["schemas"]["PlaceCounts"];
      /** Examples */
      examples: components["schemas"]["CatalogueExampleSentence"][];
    };
    /**
     * Cause
     * @description The `cause` extension: why a refusal fired, beneath its own top-level
     *     `code` -- present only on a refusal that carries one (`recipe_not_declared`,
     *     `rate_coverage_gap`, `operation_failed`). On `operation_failed`, `code` is
     *     the failed operation's refusal code. Mirrors `alternatives`/`truncated`'s
     *     own extension style: `entities` names what the cause concerns (entity or
     *     `entity@year` keys), capped, with `truncated` set when the cap cut items
     *     short.
     */
    Cause: {
      /**
       * Code
       * @description the cause code: a sub-cause such as nominal_undeclared, recipe_undeclared, or rate_missing, or on operation_failed the failed operation's own refusal code
       */
      code: string;
      /**
       * Entities
       * @description the entity or entity@year keys this cause concerns, in the order given, capped at 10; empty for a cause that names no entity
       */
      entities?: string[];
      /**
       * Truncated
       * @description true when the entities cap cut items short
       * @default false
       */
      truncated?: boolean;
    };
    /**
     * ChangeEntry
     * @description One change in a release.
     */
    ChangeEntry: {
      /**
       * Kind
       * @description the Keep a Changelog group the change sits under
       */
      kind: ("added" | "changed" | "deprecated" | "removed" | "fixed" | "security") | (string & {});
      /**
       * Note
       * @description the change, as CommonMark
       */
      note: string;
    };
    /**
     * ChangeModel
     * @description One change in a release of a source's DFO pipeline.
     */
    ChangeModel: {
      /**
       * Kind
       * @description the Keep a Changelog group, lowercase: added, changed, deprecated, removed, fixed or security
       */
      kind: string;
      /**
       * Note
       * @description the change, as CommonMark
       */
      note: string;
    };
    /**
     * ChangedFieldModel
     * @description One entry of `changed[]`. `prior` and `new` are present only for a
     *     scalar field the write set changed. An array or object field carries
     *     `field` alone.
     */
    ChangedFieldModel: {
      /**
       * Field
       * @description the intent field this entry reports
       */
      field: string;
      /**
       * Prior
       * @description the field's value before the write, for a disclosed scalar
       */
      prior?: unknown | null;
      /**
       * New
       * @description the field's value after the write, for a disclosed scalar
       */
      new?: unknown | null;
    };
    /**
     * Choice
     * @description A choice of source at mint: the source chosen, the others it was chosen over, and the
     *     ranking it applied, in order.
     */
    Choice: {
      chosen: components["schemas"]["StepRef"];
      /** Others */
      others: components["schemas"]["StepRef"][];
      /** Ranking */
      ranking: string[];
    };
    /** CitationModel */
    CitationModel: {
      /** Text */
      text: string;
      /** Sources */
      sources: components["schemas"]["CitationSource"][];
    };
    /**
     * CitationSource
     * @description One cited source, named through
     *     `materialise.provenance_doc.read_source_citations`. `label`, `url`,
     *     `source`, `data_commons`, the licence fields and `documentation` come
     *     from the origin catalogue where it lists `ref`, and from the graph
     *     otherwise: `license` is the licence's label, `license_type` its
     *     `licenseType` dcid and `license_url` its terms page. `license`, `license_type`,
     *     `license_url` and `url` are `None` where neither the catalogue nor the graph declares one. `source`
     *     and `data_commons` are `None` for a ref the catalogue does not list.
     *     `documentation` is the source's documentation at first mint, `None` when
     *     nothing documents the source or its graph read failed. A mint
     *     leaves a stored citation as it is. A bundle render fills every field but
     *     `ref`, `label` and `processing_level` that is `None` from a live read for
     *     that render only (`datasets_api.manifest.healed_citation`), and every set
     *     field wins.
     */
    CitationSource: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
      /** Processing Level */
      processing_level?: string | null;
      /** License */
      license?: string | null;
      /** License Type */
      license_type?: string | null;
      /** License Url */
      license_url?: string | null;
      /** Url */
      url?: string | null;
      source?: components["schemas"]["CitedSourceNode"] | null;
      data_commons?: components["schemas"]["CitedDataCommons"] | null;
      documentation?: components["schemas"]["CitedDocumentation"] | null;
    };
    /**
     * CitedDataCommons
     * @description The Data Commons that serves a cited provenance.
     */
    CitedDataCommons: {
      /** Id */
      id: ("dfo" | "base" | "un_system") | (string & {});
      /** Label */
      label: string;
    };
    /**
     * CitedDocumentation
     * @description A cited source's documentation at first mint, read by
     *     `materialise.provenance_doc.read_provenance_doc`, the reader behind
     *     `GET /api/graph/documentation/{ref}`. Each member is `None` or empty where the graph
     *     documents nothing.
     */
    CitedDocumentation: {
      /**
       * Publisher
       * @description the publishing organisation
       */
      publisher?: string | null;
      /**
       * Description
       * @description what the source holds
       */
      description?: string | null;
      /**
       * Source Data Url
       * @description where the raw data downloads from
       */
      source_data_url?: string | null;
      /**
       * Attribution
       * @description the citation text the publisher asks for, verbatim
       */
      attribution?: string | null;
      /**
       * Update Cadence
       * @description how often the source updates, as display text such as 'Quarterly'; an unrecognised ISO 8601 duration passes through as stored
       */
      update_cadence?: string | null;
      /**
       * Last Update
       * @description the date of the DFO's last refresh of the source
       */
      last_update?: string | null;
      /**
       * Years Covered
       * @description YYYY or YYYY-YYYY
       */
      years_covered?: string | null;
      /**
       * Granularity
       * @description such as 'Annual, by provider and recipient'
       */
      granularity?: string | null;
      /**
       * Currencies
       * @description sorted ISO 4217 codes of the source's currencies
       */
      currencies?: string[];
      /** Transformation Log */
      transformation_log?: components["schemas"]["TransformationStepModel"][];
      /**
       * Version History
       * @description the DFO pipeline's releases, newest first
       */
      version_history?: components["schemas"]["ReleaseModel"][];
    };
    /**
     * CitedSourceNode
     * @description The Data Commons `Source` node behind a cited provenance. On the UN
     *     System Data Commons it is the agency provenance itself.
     */
    CitedSourceNode: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
    };
    /**
     * GraphCodeBlock
     * @description A code's detail block.
     */
    CodeBlock: {
      /** @description the system's graph node, such as `CRSPurposeCodeEnum` */
      code_system: components["schemas"]["NodeRef"] | null;
      /**
       * Property
       * @description the constraint property the code is a value of
       */
      property: string;
      /** Code */
      code: string;
      /** @description the code it specialises; null for a root */
      parent: components["schemas"]["NodeRef"] | null;
      /** Synonyms */
      synonyms: string[];
    };
    /**
     * GraphCodeItem
     * @description A code in a `codes` or `children` list, with its code and its parent's dcid.
     */
    CodeItem: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
      /** Code */
      code: string;
      /**
       * Parent
       * @description the parent code's dcid; null for a top-level code
       */
      parent: string | null;
    };
    /**
     * CodeMappingEntry
     * @description One endpoint/channel combination a registered code is permitted on.
     *     Mirrors `dfo_spec_kit.registry.CodeMapping`'s fields. `doors` and
     *     `http_status` are null when the registry entry omits them.
     */
    CodeMappingEntry: {
      /** Endpoint */
      endpoint: string;
      /** Channel */
      channel: string;
      /** Doors */
      doors: string[] | null;
      /** Http Status */
      http_status: number | null;
    };
    /** CodeNode */
    CodeNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "code";
      code: components["schemas"]["CodeBlock"];
    };
    /**
     * CodeRegistryEntry
     * @description The wire shape of a successful `GET /codes/{code}` lookup, not the
     *     `ProblemDetails`/`Envelope` shape that carries `capability_version`,
     *     `trace_id`, and `type`. `dfo_platform.version` hashes this shape by
     *     calling `registry_entry_body` through the `codes` module attribute, so
     *     any change here moves `PLATFORM_CAPABILITY_VERSION`.
     *
     *     `classification`, `definition`, `lifecycle` and `mappings` come from
     *     `dfo_spec_kit.registry.REGISTRY`. `title` and `detail` come from the
     *     merged refusal catalogue. Either source can lack the code. `title` and
     *     `detail` are null for a code the merged catalogue does not carry (a
     *     warning, or a no-data reason), while `classification`, `definition` and
     *     `lifecycle` are null and `mappings` is empty for a code absent from the
     *     registry. A client sees a missing source as null fields on a present
     *     code, not as a vanished key set.
     */
    CodeRegistryEntry: {
      /** Code */
      code: string;
      /** Classification */
      classification: (("refusal" | "warning") | (string & {})) | null;
      /** Definition */
      definition: string | null;
      /** Lifecycle */
      lifecycle: (("active" | "retired") | (string & {})) | null;
      /** Mappings */
      mappings: components["schemas"]["CodeMappingEntry"][];
      /** Title */
      title: string | null;
      /** Detail */
      detail: string | null;
    };
    /**
     * GraphCodeSystemBlock
     * @description A code system's detail block.
     */
    CodeSystemBlock: {
      /**
       * Property
       * @description the constraint property the system governs
       */
      property: string;
      /**
       * Plain Name
       * @description the property's plain name, such as `sector`
       */
      plain_name: string;
      declarations: components["schemas"]["CodeSystemDeclarations"];
      /**
       * Code Count
       * @description how many codes the code index holds for the system
       */
      code_count: number;
    };
    /**
     * GraphCodeSystemDeclarations
     * @description The rules a code system declares (`code_index.types.CodeSystemDeclaration`).
     */
    CodeSystemDeclarations: {
      /**
       * Hierarchical
       * @description whether its codes nest through specializationOf
       */
      hierarchical: boolean;
      /**
       * Disjoint From Children
       * @description whether a parent code's records sit apart from its children's, so a parent's total is its own records plus its descendants' (CRS purposes); false where a parent row already totals its children (DAC1 aid types)
       */
      disjoint_from_children: boolean;
      /**
       * Summable
       * @description whether sibling values can rebuild a parent total
       */
      summable: boolean;
      /**
       * Absent Reading
       * @description how a variable that does not declare the property reads
       */
      absent_reading: ("not_declared" | "aggregate") | (string & {});
    };
    /** CodeSystemNode */
    CodeSystemNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "code_system";
      code_system: components["schemas"]["CodeSystemBlock"];
    };
    /**
     * ColumnOptionModel
     * @description One frame column, verbatim from `materialise.profile.ColumnProfile`.
     */
    ColumnOptionModel: {
      /** Name */
      name: string;
      /** Kind */
      kind: string;
      /** Droppable */
      droppable: boolean;
      /** Distinct */
      distinct?: number | null;
    };
    /**
     * ComponentBody
     * @description The create and revise routes' shared request body. `extra="forbid"`
     *     is what refuses a body carrying `session`/`caller`. An undeclared
     *     field fails pydantic validation, which
     *     `presentation_api.refusals.request_validation_spec` classifies as
     *     `request_invalid` with no door-level code needed, `retryable` false. A
     *     revise's `composition_id` is passed straight through to
     *     `write_component`, which refuses it (composition membership is
     *     create-only); this model does not distinguish the two routes.
     */
    ComponentBody: {
      /** Intent */
      intent: {
        [key: string]: unknown;
      };
      /** Composition Id */
      composition_id?: string | null;
    };
    /**
     * ComponentReadResponse
     * @description `GET /api/presentation/components/{component_id}`'s 200 body.
     */
    ComponentReadResponse: {
      /**
       * Component Id
       * @description the read component's own id
       */
      component_id: string;
      /**
       * Revision
       * @description the revision this read reports
       */
      revision: number;
      /**
       * Catalog Version
       * @description the catalogue release this revision minted under
       */
      catalog_version: string;
      /**
       * Composition Id
       * @description the composition this component belongs to, null outside one
       */
      composition_id: string | null;
      /**
       * Composition Revision
       * @description the composition's current head revision, null outside one
       */
      composition_revision: number | null;
      /**
       * Stored Intent
       * @description this revision's own stored intent, exactly as minted
       */
      stored_intent: {
        [key: string]: unknown;
      };
      /** @description the closed, token-capped fact summary this revision reports */
      fact_summary: components["schemas"]["FactSummaryModel"];
      /**
       * Resolved Payload
       * @description the revision's stored resolved payload, verbatim: the catalogue envelope {schema_version, catalog_version, component_id, revision, provenance, component}, validated against the catalogue release's envelope schema (dfo-spec-kit envelope.schema.json) when minted. GET /api/presentation/release serves the pinned release's envelope_schema and the component_schemas its component field $refs by $id; every payload this door serves carries that pinned catalog_version.
       */
      resolved_payload: {
        [key: string]: unknown;
      };
    };
    /**
     * ComposedUnit
     * @description A quotient's unit: the numerator's unit per the denominator's. Either side may be a
     *     variable.
     */
    ComposedUnit: {
      /** Numerator */
      numerator: components["schemas"]["SimpleUnit"] | components["schemas"]["VariableSide"];
      /** Denominator */
      denominator: components["schemas"]["SimpleUnit"] | components["schemas"]["VariableSide"];
    };
    /**
     * ComposedUnitModel
     * @description The unit of a quotient of two measures, read `<numerator> per <denominator>`.
     *
     *     Each side is a unit's graph name (its ref when the graph has none), a converted unit, or
     *     the StatVar a unit-less side counts.
     */
    ComposedUnitModel: {
      /**
       * Numerator
       * @description the unit of the measure divided
       */
      numerator:
        | string
        | components["schemas"]["ConvertedUnitModel"]
        | components["schemas"]["CountedStatVarModel"];
      /**
       * Denominator
       * @description the unit of the measure divided by
       */
      denominator:
        | string
        | components["schemas"]["ConvertedUnitModel"]
        | components["schemas"]["CountedStatVarModel"];
    };
    /**
     * GraphDefinitionConstraint
     * @description One constraint: the property and the value the variable fixes it at.
     */
    Constraint: {
      property: components["schemas"]["NodeRef"];
      value: components["schemas"]["NodeRef"];
    };
    /** ContinentNode */
    ContinentNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "continent";
      continent: components["schemas"]["PlaceBlock"];
    };
    /** ContinentalUnionNode */
    ContinentalUnionNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "continental_union";
      continental_union: components["schemas"]["PlaceBlock"];
    };
    /**
     * ConversionCurrency
     * @description One currency a unit request can convert this answer to, with the years each price
     *     basis converts. A request whose tables leave out some of the years the answer serves
     *     shows the years stated here, and departs `year_unavailable` naming the table.
     */
    ConversionCurrency: {
      /**
       * Code
       * @description the ISO 4217 code a unit request names the currency by
       */
      code: string;
      /**
       * Noun
       * @description the plural English noun the sentence's unit token names the currency by ('euros', 'Guatemalan quetzales')
       */
      noun: string;
      /** @description the first and last years a current-price request in this currency shows, the longest run of consecutive years, inside the years the answer serves (download.window), in which the recipe's exchange-rate table holds a rate for this currency and for the native currency of every facet the answer serves. It equals download.window when the conversion keeps every served year. With no download.window, the run the tables hold. Null when no year converts */
      current_years: components["schemas"]["TimeWindow"] | null;
      /** @description the first and last years a constant-price request in this currency shows, at any base year from base_year_min to base_year_max, the longest run of consecutive years, read as current_years is, in which the exchange-rate table holds a rate for the native currency of every facet the answer serves and the deflator table a value for at least one entity the answer serves on the recipe's deflator role, bound or open. The conversion leaves out an entity's rows in the years its deflator lacks, and the answer names them (deflator_missing_omitted). Null when no year converts or no base year exists */
      constant_years: components["schemas"]["TimeWindow"] | null;
      /**
       * Base Year Min
       * @description the first base year a constant-price request in this currency converts at. With base_year_max it spans the run of consecutive years, ending at the latest, in which the deflator table holds an actual value, the exchange-rate table a rate for the currency, and the deflator table a value for at least one entity the answer serves on the recipe's deflator role. The conversion leaves out every row of an entity whose deflator lacks the base year, and the answer names it (deflator_missing_omitted). Null when no such year exists
       */
      base_year_min: number | null;
      /**
       * Base Year Max
       * @description the last base year a constant-price request in this currency converts at
       */
      base_year_max: number | null;
    };
    /**
     * ConvertedUnitModel
     * @description A converted unit, as the frame's `unit` cell states it.
     */
    ConvertedUnitModel: {
      /**
       * Currency
       * @description the ISO 4217 code of the currency the values are in
       */
      currency: string;
      /**
       * Prices
       * @description the price basis of the values
       */
      prices: ("current" | "constant") | (string & {});
      /**
       * Base Year
       * @description the base year of constant prices, absent for current prices
       */
      base_year?: number | null;
    };
    /**
     * CountedStatVarModel
     * @description One side of a composed unit whose measure declares no unit, named by its StatVar.
     */
    CountedStatVarModel: {
      /**
       * Stat Var
       * @description the StatVar's `dcid:`-prefixed ref, as the frame holds it
       */
      stat_var: string;
      /**
       * Label
       * @description the StatVar's graph name, or its ref without `dcid:` when the graph has none
       */
      label: string;
    };
    /** CountryNode */
    CountryNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "country";
      country: components["schemas"]["PlaceBlock"];
    };
    /**
     * Counts
     * @description What DFO holds, counted from one origin catalogue build and one
     *     coverage index build.
     */
    Counts: {
      /**
       * Indicators
       * @description distinct StatVars search can serve: base, DFO and coverage variables
       */
      indicators: number;
      /**
       * Datasets
       * @description distinct source-index entries of the admitted provenances
       */
      datasets: number;
      /**
       * Publishers
       * @description distinct sources of the admitted provenances
       */
      publishers: number;
      /**
       * Countries
       * @description countries with base data in the origin catalogue or coverage rows
       */
      countries: number;
      aid: components["schemas"]["AidCounts"];
    };
    /**
     * CoverageBare
     * @description Observation footprint with no count or dimensions; an honest could-not-count.
     */
    CoverageBare: {
      /**
       * @description coverage kind discriminator (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "bare";
      /**
       * Has Data
       * @description whether the region has any observations
       */
      has_data: boolean;
      /** @description the date window, when known */
      window?: components["schemas"]["TimeWindow"] | null;
    };
    /**
     * CoverageBreadth
     * @description Observation footprint expressed as structured breadth dimensions.
     */
    CoverageBreadth: {
      /**
       * @description coverage kind discriminator (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "breadth";
      /**
       * Has Data
       * @description whether the region has any observations
       */
      has_data: boolean;
      /**
       * Dimensions
       * @description non-empty on breadth; structured dimension counts
       */
      dimensions: components["schemas"]["BreadthDim"][];
      /** @description the date window this breadth applies to */
      window?: components["schemas"]["TimeWindow"] | null;
    };
    /**
     * CoverageDimension
     * @description One coverage dimension. `axis` is `axis_for_role(label)`: the flow axis of a dimension
     *     labelled by a declared role, and `None` for `years` and unmapped roles. Validation derives
     *     it, so a stored body written without it carries it once loaded. `noun` is set at the mint
     *     from the version's flow family (`dfo_platform.roles.role_wording`), which the label and
     *     axis do not fix, so a body stored without it carries none (`year_coverage_counted`): a
     *     `None` noun is left out of every dump.
     */
    CoverageDimension: {
      /** Label */
      label: string;
      /** Count */
      count: number;
      axis?: components["schemas"]["RoleAxis"] | null;
      /** @description what the members this dimension counts are called, by the frame's flow family: provider and recipient for aid, creditor and debtor for debt. Absent for a dimension on no flow axis, such as `years`, and on a version stored without it */
      noun?: components["schemas"]["DimensionNoun"] | null;
    };
    /**
     * CoverageExact
     * @description Observation footprint with an exact count for its resolved window.
     */
    CoverageExact: {
      /**
       * @description coverage kind discriminator (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "exact";
      /**
       * Has Data
       * @description whether the exact observation_count has observations in the resolved window, or in full history when window is absent
       */
      has_data: boolean;
      /**
       * Observation Count
       * @description exact distinct (date, facet) observation pairs for resolved stat_vars and entities in the resolved window, or full history when window is absent
       */
      observation_count: number;
      /**
       * Evidence
       * @description provenance of observation_count. 'facet_metadata': the count comes from the graph's facet index and no observation series was delivered for this spec in this payload. 'observed': a preview series was delivered for this spec in this payload, and observation_count is still the facet-index count, now backed by fetchable data. A streaming response's `response` event ships before any observation fetch, so it always carries 'facet_metadata'; its trailing `observations` event carries the series. dfo-apis wire field outside the spec-kit contract.
       * @default facet_metadata
       */
      evidence?: ("facet_metadata" | "observed") | (string & {});
      /**
       * Dimensions
       * @description optional per-facet breadth dimensions; the observations dimension is window-narrowed to agree with observation_count when window is set, lifetime otherwise
       */
      dimensions?: components["schemas"]["BreadthDim"][] | null;
      /** @description the date window this count applies to */
      window?: components["schemas"]["TimeWindow"] | null;
    };
    /**
     * CoverageModel
     * @description A frame's row and dimension counts and its applied window.
     *
     *     `recent_years`, `elected_year` and `fullest_year` set the frame's one year beside the
     *     years around it (`datasets_api.manifest.year_coverage`). They are counted once, when
     *     the version is minted, and stored with it, all three or none, so every read of the
     *     version states the same ones. A `None` member is left out of every dump.
     */
    CoverageModel: {
      /** Rows */
      rows: number;
      /** Dimensions */
      dimensions: components["schemas"]["CoverageDimension"][];
      /** Window */
      window?: {
        [key: string]: unknown;
      } | null;
      /**
       * Recent Years
       * @description three calendar years, newest first, each with the counts the coverage index held of the series the frame's run read when the version was minted. They end at the newest year a counted series held up to the year the index was built in, so a year after the frame's can hold data the frame leaves out. Stated for a latest window and for a named year at or after the year a latest window serves, and absent for an earlier named year
       */
      recent_years?: components["schemas"]["YearCoverage"][] | null;
      /**
       * Elected Year
       * @description the year a latest window served when the version was minted. It is the frame's year under a latest window. A frame of a named year after it holds a year a latest window passes over
       */
      elected_year?: number | null;
      /** @description the year holding the most series of the ten calendar years ending at the newest of `recent_years`, stated when it is earlier than those three and the frame's year holds under the share of its series a latest window's year must hold */
      fullest_year?: components["schemas"]["YearCoverage"] | null;
    };
    /**
     * CreateComponentBody
     * @description The create route's body. `write_token` is checked by `write_component`, which refuses a
     *     malformed token, or one sent with `composition_id` "new", as `request_invalid`.
     */
    CreateComponentBody: {
      /** Intent */
      intent: {
        [key: string]: unknown;
      };
      /** Composition Id */
      composition_id?: string | null;
      /**
       * Write Token
       * @description a cmw_ token this client minted for the new component: "cmw_" + secrets.token_urlsafe(16) or an equivalent CSPRNG, 22 url-safe base64 characters after the prefix. It becomes the component's write token and keys the create: a retry with the same write_token, intent and composition_id returns the first create's reply, and a different request with it is refused as request_invalid. Mint a new one for each create. Not allowed with composition_id "new".
       */
      write_token?: string | null;
    };
    /**
     * CreateReplyResponse
     * @description `POST /api/presentation/components`'s 201 body. It carries
     *     `WriteReplyResponse`'s fields plus this door's own `affordance` line
     *     naming the freshly minted component's revise and read routes.
     */
    CreateReplyResponse: {
      /**
       * Component Id
       * @description the newly minted component's own id
       */
      component_id: string;
      /**
       * Revision
       * @description the first revision a create mints, always 1
       */
      revision: number;
      /**
       * Catalog Version
       * @description the catalogue release this revision minted under
       */
      catalog_version: string;
      /**
       * Composition Id
       * @description the composition this component belongs to, null outside one
       */
      composition_id: string | null;
      /**
       * Composition Revision
       * @description the composition's current head revision, null outside one
       */
      composition_revision: number | null;
      /**
       * Changed
       * @description always empty, since a create carries no prior intent to compare against
       */
      changed: components["schemas"]["ChangedFieldModel"][];
      /** @description the closed, token-capped fact summary this revision reports */
      fact_summary: components["schemas"]["FactSummaryModel"];
      /**
       * Resolved Payload
       * @description the revision's stored resolved payload, verbatim: the catalogue envelope {schema_version, catalog_version, component_id, revision, provenance, component}, validated against the catalogue release's envelope schema (dfo-spec-kit envelope.schema.json) when minted. GET /api/presentation/release serves the pinned release's envelope_schema and the component_schemas its component field $refs by $id; every payload this door serves carries that pinned catalog_version.
       */
      resolved_payload: {
        [key: string]: unknown;
      };
      /**
       * Affordance
       * @description this door's own line naming the revise and read routes for this component
       */
      affordance: string;
      /**
       * Write Token
       * @description the cmw_ token that grants revising this component, sent back as the x-dfo-write-token header. A server-minted token appears only in this reply; a token the create sent as write_token is echoed, and a replayed create returns it again.
       */
      write_token: string;
      /**
       * Composition Write Token
       * @description the cpw_ token that grants creating components into the composition this create started with composition_id "new", sent back as the x-dfo-write-token header. Present only on that create.
       */
      composition_write_token?: string | null;
    };
    /**
     * GraphDataBuilds
     * @description The data builds this process serves, each null where it is unknown or absent.
     */
    DataBuilds: {
      /**
       * Graph Generation
       * @description the graph generation token: the graph service's Cloud Run revisions last read, joined with +; null while unknown
       */
      graph_generation?: string | null;
      /**
       * Origin Catalogue
       * @description build id of the origin catalogue this request is bound to
       */
      origin_catalogue?: string | null;
      /**
       * Coverage Index
       * @description build id of the series coverage index; null when none is loaded
       */
      coverage_index?: string | null;
      /**
       * Code Index
       * @description content hash of the packaged code index export
       */
      code_index?: string | null;
    };
    /**
     * DatasetEntry
     * @description A Dataset and the admitted provenances that belong to it. A provenance with
     *     no Dataset forms its own entry, keyed by the provenance, so `ref` and `label`
     *     are the provenance's and `provenances` holds that one provenance.
     *
     *     The card facts (`description`, `license_type`, `update_cadence`,
     *     `years_covered`, `source_url`) equal the same members of
     *     `GET /api/graph/documentation/{ref}` for the graph the loaded catalogue
     *     build read. They are null on UN System Data Commons entries.
     */
    DatasetEntry: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
      /** Provenances */
      provenances: components["schemas"]["ProvenanceEntry"][];
      /**
       * Description
       * @description its sole Provenance's description, as `details.description`; null when it has several
       */
      description: string | null;
      /**
       * License Type
       * @description licence label every Provenance agrees on, as `license.type`; null when they disagree or one has none
       */
      license_type: string | null;
      /**
       * Update Cadence
       * @description release cadence label every Provenance agrees on, as `license.update_cadence`; null when they disagree or one has none
       */
      update_cadence: string | null;
      /**
       * Years Covered
       * @description `YYYY` or `YYYY-YYYY` span of its Provenances' observation dates, as `scope_and_units.years_covered`; null when either end is unknown
       */
      years_covered: string | null;
      /**
       * Source Url
       * @description the publication's page, as `details.source_url`: the Dataset's url, else its sole Provenance's
       */
      source_url: string | null;
    };
    /** DatasetNode */
    DatasetNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "dataset";
      dataset: components["schemas"]["SourceBlock"];
    };
    /**
     * DatasetResubmitInput
     * @description Re-resolve every part of a multi-variable result in one request, so an
     *     edit to one part cannot leave the other parts' composed sentence or fold
     *     stale (see `envelope.make_response` / `conjoin.combine_regions`, the
     *     combiner every entry kind here is routed through).
     *
     *     `entries` supplies one entry per response part, in response part order;
     *     each entry edits against its own base, never a dataset-level one. There
     *     is no spec registry, so every entry carries its full identity and this
     *     door reads no server-side state.
     */
    DatasetResubmitInput: {
      /**
       * @description discriminator for dataset-level re-resolution across every part (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "dataset_resubmit";
      /**
       * Entries
       * @description one entry per response part, in response part order; a single-entry request whose entry is an identity re-resolves exactly that one part
       */
      entries: (
        | components["schemas"]["ResubmitIdentityEntry"]
        | components["schemas"]["ResubmitCandidatesEntry"]
        | components["schemas"]["ResubmitPlaceholderEntry"]
        | components["schemas"]["ResubmitParsedEntry"]
      )[];
      /**
       * Raw Query
       * @description original query text, for echo only; does not affect resolution
       */
      raw_query?: string | null;
    };
    /** DatasetVersion */
    DatasetVersion: {
      /** Content Version */
      content_version: string;
      /**
       * Base Content Version
       * @description the raw version a derived version (a full groupby collapse, a party-totals cut, or both) was rendered from. Null on every other version
       */
      base_content_version: string | null;
      /**
       * Rendering
       * @description plain: a raw version, which is also what a groupby sum or a party-totals cut that left the frame unchanged is stored under. groupby: a collapse, summed by `groupby`, of the frame or of its party-totals cut when `without_party_totals` is true. without_party_totals: the frame without its party totals, unsummed. not_recorded: a derived version with no linked file recording its options
       */
      rendering: ("plain" | "groupby" | "without_party_totals" | "not_recorded") | (string & {});
      /** @description the groupby a collapse was summed by, as its file's rendering records it. Null unless `rendering` is groupby */
      groupby: components["schemas"]["GroupbyOptions"] | null;
      /**
       * Without Party Totals
       * @description true when the derived version's frame leaves out the group totals of its open party roles, as its file's rendering records it. Absent when false
       * @default false
       */
      without_party_totals?: boolean;
    };
    /** DatasetVersionsPage */
    DatasetVersionsPage: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** Spec Id */
      spec_id: string;
      /**
       * Versions
       * @description stored versions that are not revoked, newest first
       */
      versions: components["schemas"]["DatasetVersion"][];
      /**
       * Next Cursor
       * @description continues the list after this page's last version; null when complete
       */
      next_cursor: string | null;
      /**
       * Complete
       * @description true when this page reaches the end of the list
       */
      complete: boolean;
    };
    /**
     * DateRange
     * @description The first and last dates of the points an answer serves for a StatVar.
     */
    DateRange: {
      /**
       * Start
       * @description first served date, e.g. '2012'
       */
      start?: string | null;
      /**
       * End
       * @description last served date, e.g. '2022'
       */
      end?: string | null;
    };
    /**
     * DeclinedAnswer
     * @description A resolve response to a question search does not answer.
     */
    DeclinedAnswer: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1. Required on every response.
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** @description what the response was understood to be answering */
      query_echo: components["schemas"]["QueryEcho"];
      /** @description run health, warnings, timing, build stamp */
      diagnostics: components["schemas"]["Diagnostics"];
      /**
       * @description discriminator for a response to a question search does not answer (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "declined";
      /**
       * Reason
       * @description why search declined: 'out_of_scope' when no part of the question asks for a published statistic about a place, a population or a financial flow; 'requires_analysis' when the subject is in scope but the question asks for an argument and names no data to show
       */
      reason: ("out_of_scope" | "requires_analysis") | (string & {});
      /** @description the place the question named, when it named a country */
      scope: components["schemas"]["Scope-Output"];
    };
    /**
     * DefinitePart
     * @description One unambiguous answer was resolved for this part.
     */
    DefinitePart: {
      /**
       * Variable Text
       * @description the variable text this part answers, in the order asked. This part's position in Resolution.parts equals the same variable_index every SSE event keyed by variable_index uses (ShapeEvent, StepEvent, SentenceEvent). Every dataset_resubmit entry kind (identity, candidates, placeholder, and parsed through its nested ParsedPart) requires its own posted variable_text, so this field is always the posted text echoed back onto the rebuilt part, never null. Null only when the whole posted query was empty or whitespace-only (raw_text door), which refuses variable_not_resolved before extraction runs and so has no text to name.
       */
      variable_text?: string | null;
      /**
       * Separate
       * @description true when this part was asked beside the others to be compared with them. A client resubmitting an identity, candidate set, or placeholder posts this flag on that entry to preserve the comparison. Two parts marked separate that resolve to one reading carry the same spec_id and stay two parts. False, the default, is omitted
       * @default false
       */
      separate?: boolean;
      /**
       * Warnings
       * @description this part's own run-health signals. A part folded into an earlier part's spec (see DefinitePart.spec) carries binding_folded alone. The merged spec's own resolved warnings live only on the first part that carries it. An unfolded part carries the warnings raised while resolving this part, plus observations_omitted on a candidates part when response_options.include_observations was set.
       */
      warnings?: components["schemas"]["Warning"][];
      /** @description this part's own latency breakdown, where by_step names only the phases this part ran and total sums them, leaving out the shape_* stages nested inside shape. Excludes the shared, once-per-request steps (e.g. extract), which diagnostics.timing_ms.by_step carries once for the whole request; distinct too from diagnostics.timing_ms.total, the whole request's wall-clock elapsed time. */
      timing_ms?: components["schemas"]["Timing"] | null;
      /**
       * Rendered Sentence
       * @description a human-readable string. For candidates, a header naming how many readings there are ('3 readings.'), then each shown candidate's heading and a byline led by the source and span that set it apart; for no_data, a heading in the same claim form naming the entity, measure, and counterpart that were checked. Either ends with the text of this part's departures, in order, and a candidates part's then closes with its assumptions clause. For a definite part this stays null or omitted: the confirmation sentence (heading and byline) lives at spec.resolved.rendered_sentence, and its departures reach the envelope's composed sentence.
       */
      rendered_sentence?: string | null;
      /**
       * Sentence Plan
       * @description the ordered token form of rendered_sentence, present whenever it is. For a definite part this stays null or omitted. spec.resolved.sentence_plan carries the confirmation sentence's own plan instead.
       */
      sentence_plan?: components["schemas"]["SentenceToken"][] | null;
      /** @description the ParsedPart that reproduces this part's own resolution inputs -- the same entities, resolved time window, unit text, and source text the engine actually used to resolve this one leg -- so a client holding this part alone can copy it straight into a fresh ParsedInput.parts entry and re-resolve it faithfully, without flattening it into the whole query's variable_text the way variable_text alone would. Canonical, not verbatim: for a raw_text part, time_text is the equivalent phrase this door's own time grammar recognises (e.g. '2015 to 2020'), not the user's original words, since the engine's date extraction keeps only the structured window and discards the phrasing. Null whenever this part has no faithful echo to give. On a dataset_resubmit entry's identity/candidates/placeholder kinds, which post an identity or stub rather than a phrase and have no per-part resolution inputs to echo -- a dataset_resubmit parsed entry, genuinely re-resolved from its own posted ParsedPart, carries a real one like any parsed-door part. Also null when this leg's entity was bound to a directional role axis (origin/destination) and no door-supplied role named that axis, since an echo without the axis would resubmit the request with that entity reversed. Also null when one of this leg's own inputs does not fit ParsedPart's own field caps, since a truncated echo would misrepresent what was actually resolved. */
      restatement?: components["schemas"]["ParsedPart"] | null;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
      /**
       * Departures
       * @description every way this part's answer differs from what its request asked, ordered by how much each changes the number: closest_match, measure_not_applied, operation_not_applied, breakdown_not_applied, entity_unavailable, year_unavailable, modelled_values, group_read_as_members, direction_discarded, direction_inferred, scope_limited. [] when the answer is what was asked. A client that renders its own sentence reads them here; each one's text also closes the sentence that carries this part (see Departure.text). A warning on the same part reports run health and stays separate
       */
      departures?: components["schemas"]["Departure"][];
      /**
       * Assumptions
       * @description every value the engine filled that the request did not ask for, in clause order. Declared defaults come first, in the order of the Spec's trace.slot_filters, then open roles, then the place scope. A declared default is a slot the request left open that its code system's or shape's declared default fixed, named by the bound code's full label. An open role is a flow role no request word asked for, read across every entity on it with data. It is either a role the role scope default filled (resolved.scope on that axis), whatever its member count, served as one series per member where the shape declares the role, or a role the heading states with no entity of its own ('from 164 providers', 'owed to all creditors'), served as the total over its members. A role the identity binds in entities or lists in open_roles, that one of the part's operations runs over ('top 5 donors'), or that the request's words asked every member of ('all donors'), is asked. The place scope is a request that named no place, read across every place with data. Every door fills assumptions. A definite part reads them from its Spec, a candidates part carries the items every list in CandidatesPart.reading_assumptions holds alike, text included, and no_data and unsupported parts carry []. A dataset_resubmit identity entry posts every slot bound, so its part states the items of the entry's assumptions echo that still hold (see ResubmitIdentityEntry.assumptions), and a candidates entry reads each reading with its candidate's echo (see ResubmitCandidate.assumptions). The sentence that carries this part closes with them as one segment='assumption' clause ('Assumed: official development assistance; every provider.'), after its departures. [] when the answer fills nothing
       */
      assumptions?: components["schemas"]["Assumption"][];
      /**
       * @description one answer was resolved (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      status: "definite";
      /** @description the resolved Spec answering this part. Parts whose specs share a spec_id are one reading of the data, the same series, entities and years. A later part that folds into an earlier part's spec carries binding_folded. A part posted with separate: true never folds and keeps its own part, so two separate parts can carry one spec_id by request. Parts sharing a spec_id can differ in assumptions, so a client never dedupes parts by spec_id */
      spec: components["schemas"]["Spec"];
    };
    /**
     * DefinitionMembersRequest
     * @description Body of `POST /api/datasets/{id}/members`. It may carry the canonical `definition` a
     *     search response gives for `id`, so the route answers before any mint registers it.
     *
     *     A registered id needs no `definition`. A supplied one is admitted as a mint admits a
     *     `spec_id` sidecar: `definition.spec_id` must equal the path id, and the identity must hash
     *     to it. Nothing is written.
     */
    DefinitionMembersRequest: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version?: 1;
      definition?: components["schemas"]["CanonicalDefinition"] | null;
    };
    /** DefinitionModel */
    DefinitionModel: {
      /** Schema Version */
      schema_version: number;
      /** Spec Id */
      spec_id: string;
      /**
       * Identity
       * @description the identity-core document, shaped as search.models.identity.BaseIdentity and published at GET /api/search/schema
       */
      identity: {
        [key: string]: unknown;
      };
    };
    /**
     * DefinitionOptionsRequest
     * @description Body of `POST /api/datasets/{id}/options`. It carries the canonical `definition` a search
     *     response gives for `id`, so the options route answers for an id no mint has registered.
     *
     *     The route admits and registers the definition as a `spec_id` mint registers its sidecar.
     *     `definition.spec_id` must equal the path id, and the identity must hash to it.
     */
    DefinitionOptionsRequest: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version?: 1;
      definition: components["schemas"]["CanonicalDefinition"];
    };
    /**
     * DefinitionResponse
     * @description The register door's response: the verified
     *     identity, echoed back whole.
     */
    DefinitionResponse: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version: 1;
      definition: components["schemas"]["CanonicalDefinition"];
    };
    /**
     * GraphDefinitionText
     * @description The graph's prose for one part of a definition.
     */
    DefinitionText: {
      /** @description the part the text defines */
      of: components["schemas"]["NodeRef"];
      /** Text */
      text: string;
    };
    /**
     * Departure
     * @description One way this part's answer differs from what its request asked, stated
     *     for people in `text` and for code in `code`, `asked`, and `shown`.
     *
     *     Departures live on the part (`_PartBase.departures`).
     *     `spec.resolved.rendered_sentence` states what the answer is, and a
     *     departure states how that differs from the request that produced it.
     */
    Departure: {
      /**
       * Code
       * @description what kind of departure this is. 'closest_match': the answer shows the nearest measure the graph holds, not the one asked; a client draws a muted 'Closest match:' lead before the heading, and on a candidates part, whose readings stand in for a measure with no data, once before the first reading. 'measure_not_applied': a named measure qualifier was not applied. 'operation_not_applied': an operation the request named (a share, a ranking) was not run, so the amounts behind it are shown. 'breakdown_not_applied': a breakdown the request named was not applied, so the total is shown. 'entity_unavailable': an entity the request named holds no values in the series the answer reads, one departure per role; for a role the request named as a group, asked is the request's words for the group and the text counts the members without values; the text names any source holding values there that Search does not read. 'year_unavailable': a named year or range falls outside the years served. 'modelled_values': the served values are modelled or estimated. 'group_read_as_members': a named group was read as its member entities; on a flow role the text names the amounts the group's published total counts that no member holds, and, for a group whose published total is not its members' sum, says the source publishes its own figure for the group. 'direction_discarded': a flow direction the request's own words named was not applied. 'direction_inferred': a place the request named without a direction is read on the one direction that holds data, which over names. 'scope_limited': a no_data answer's check covered only values the engine chose, which the request did not name; its text names only what the check covered ('This check covered only ODA.')
       */
      code:
        | (
            | "closest_match"
            | "measure_not_applied"
            | "operation_not_applied"
            | "breakdown_not_applied"
            | "entity_unavailable"
            | "year_unavailable"
            | "modelled_values"
            | "group_read_as_members"
            | "direction_discarded"
            | "direction_inferred"
            | "scope_limited"
          )
        | (string & {});
      /**
       * Binding Ref
       * @description the identity binding whose edit clears this departure ('when:' for a year, 'how:<property dcid>' for a measure value, 'where:' or 'origin:' for a role's entities, 'unit:' for the price basis); null for a departure no binding edit clears, such as an operation the engine does not run. A client links the departure to the sentence token carrying the same binding_ref when the plan has one; a candidates or no_data plan, and a how slot the heading leaves silent, may carry no such token
       */
      binding_ref?: string | null;
      /**
       * Asked
       * @description what the request named, in its own wording; null when it named nothing
       */
      asked?: string | null;
      /**
       * Shown
       * @description what the answer shows instead, as the heading states it; null when nothing
       */
      shown?: string | null;
      /**
       * Text
       * @description the departure as one or two short sentences for people: 'You asked for 2030. The data ends in 2024, so this shows 1973 to 2024.' On a no_data part no text claims the part shows anything. The envelope's composed sentence carries the same text as a segment='departure' token after its part's heading and byline, and so does the rendered_sentence of a part that is not definite
       */
      text: string;
    };
    /**
     * DeploymentFacetPolicy
     * @description This deployment's own default-facet policy: what an unbound facet
     *     axis falls back to once `default_facet_policies_live` (a graph-declared,
     *     per-StatVar policy) is `false`. See `docs/datasets-facet-policy.md`.
     */
    DeploymentFacetPolicy: {
      /**
       * Policy
       * @description the deployment default policy's own id
       */
      policy: string;
      /**
       * Version
       * @description the policy id's own version
       */
      version: string;
    };
    /**
     * DescribedProperty
     * @description The open dimension a values page lists, and its label (`null` where none is known).
     */
    DescribedProperty: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
    };
    /**
     * DescribedValue
     * @description One value of an open dimension, its label (`null` where none is known), and how many of
     *     the version's variables with data hold it.
     */
    DescribedValue: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
      /** Variables */
      variables: number;
    };
    /**
     * DescriptionValuesPage
     * @description One page of `GET /api/datasets/{id}/{content_version}/description/values`: the values
     *     the version's record holds for one open dimension, most variables first, ties ordered by
     *     dcid. `next_cursor` continues the list after the page's last value and is `null` on its
     *     last page, where `complete` is true.
     */
    DescriptionValuesPage: {
      property: components["schemas"]["DescribedProperty"];
      /** Items */
      items: components["schemas"]["DescribedValue"][];
      /** Next Cursor */
      next_cursor: string | null;
      /** Complete */
      complete: boolean;
    };
    /**
     * DiagnosticModel
     * @description One manifest diagnostic: a fact about how this response was produced that a developer
     *     reads and a dataset's description leaves out, since it states nothing about the data.
     *     `processing_level_undeclared` and `origin_catalogue_stale` are the codes it carries.
     */
    DiagnosticModel: {
      /** Code */
      code: string;
      /** Severity */
      severity: string;
      /** Message */
      message: string;
    };
    /**
     * Diagnostics
     * @description Run health, warnings, timing, and build stamp.
     */
    Diagnostics: {
      /**
       * Engine Build
       * @description the commit sha the image was built from, the same value the x-dfo-commit response header carries; distinct from schema_version
       */
      engine_build: string;
      /**
       * Trace Id
       * @description this request's trace_id, shared verbatim with every RFC 9457 problem-details body and the SSE stream's `done` event
       */
      trace_id: string;
      /**
       * Warnings
       * @description degraded-mode, applied-signal, partial-graph signals
       */
      warnings: components["schemas"]["Warning"][];
      /** @description latency breakdown */
      timing_ms?: components["schemas"]["Timing"] | null;
      /**
       * Llm Usage
       * @description per-request LLM token counts {input_tokens, output_tokens, cached_tokens}
       */
      llm_usage?: {
        [key: string]: number;
      } | null;
      /**
       * Timed Out
       * @description True when the pipeline's soft deadline truncated this result to a partial response; False when it ran to completion. None on the SSE response event (whose `done` event carries the authoritative flag instead) -- only resolve_async's buffered ResolveResponse populates this, since a buffered caller has no `done` event of its own to read.
       */
      timed_out?: boolean | null;
    };
    /**
     * DimensionNoun
     * @description What one member of a flow dimension is called, and several of them.
     */
    DimensionNoun: {
      /** Singular */
      singular: string;
      /** Plural */
      plural: string;
    };
    /**
     * DocumentErrorEntry
     * @description A Markdown document the source carries that this door could not serve.
     *     The member it fills is empty and named in `gaps`.
     */
    DocumentErrorEntry: {
      /**
       * Member
       * @description the wire path the document fills
       */
      member:
        | ("transformation_log" | "version_history" | "methodology.description" | "data_notes")
        | (string & {});
      /**
       * Line
       * @description 1-based line in the decoded document where the problem starts, or null
       */
      line: number | null;
      /**
       * Reason
       * @description the template rule the document breaks
       */
      reason:
        | (
            | "undecodable"
            | "empty_document"
            | "content_outside_section"
            | "unexpected_heading_level"
            | "heading_not_plain_text"
            | "empty_heading"
            | "empty_section"
            | "disallowed_block"
            | "raw_html"
            | "hard_break"
            | "invalid_release_heading"
            | "missing_release_title"
            | "release_dates_not_descending"
            | "duplicate_release_date"
            | "unknown_change_kind"
            | "duplicate_change_kind"
            | "not_single_bullet_list"
            | "list_item_not_single_paragraph"
            | "document_too_large"
            | "nesting_too_deep"
            | "conflicting_values"
          )
        | (string & {});
    };
    /**
     * DownloadFacts
     * @description What a Datasets mint of this Spec's definition writes in its default file (no
     *     grouping), known before the first download. Rows and series count what the answer's
     *     read plan serves over the identity's whole window: every year for no window, the
     *     range for a range, and each series' latest year for `latest`.
     */
    DownloadFacts: {
      /**
       * Rows
       * @description the rows the definition's series serve: one per series and date, totals included. A long-layout CSV or XLSX keeps the rows where a role the Datasets options document lists in long_layout_totals holds a total out of its main table, so that table can hold fewer. Null when it could understate: a served member the coverage artifact does not hold
       */
      rows?: number | null;
      /**
       * Rows Exact
       * @description true when rows equals the mint's coverage.rows. Under a unit request rows counts only the rows the conversion keeps: at constant prices each entity's rows in the years its deflator holds, none when it lacks the base year. False when rows is an upper bound: a unit request whose conversion cannot be read from the loaded conversion tables (none loaded, served facets under several recipes or in a unit that is no currency, or no single deflator role), or a series whose facets carry no complete date list. False when rows is null
       */
      rows_exact: boolean;
      /**
       * Series
       * @description the series in the file: distinct (StatVar, entities) with a point, the mint's series_count. Null when rows is null
       */
      series?: number | null;
      /** @description the first and last years of the file's points; null when rows is null */
      window?: components["schemas"]["TimeWindow"] | null;
      /** @description the licence of the one provenance the answer serves, from the origin catalogue; null when it serves several, or the catalogue names no single licence for it */
      licence?: components["schemas"]["DownloadLicence"] | null;
    };
    /**
     * DownloadLicence
     * @description The licence of the provenance a Spec's file cites. Its terms page is on the
     *     provenance's source page.
     */
    DownloadLicence: {
      /**
       * Label
       * @description the licence's name: the `name` of the licenseType node the provenances of the provenance's source-index entry agree on
       */
      label: string;
    };
    /** EnrichmentCoverageCountsModel */
    EnrichmentCoverageCountsModel: {
      /** Entities */
      entities: number;
      /** Covered */
      covered: number;
    };
    /**
     * EnrichmentOptionModel
     * @description One `(entity column, field)` enrichment this deployment enables,
     *     with `token` naming the exact `{column}_{field}` the `columns` option
     *     accepts to request it.
     */
    EnrichmentOptionModel: {
      /** Column */
      column: string;
      /** Field */
      field: string;
      /** Token */
      token: string;
      /** State */
      state: string;
      /** Reason */
      reason?: string | null;
      coverage: components["schemas"]["EnrichmentCoverageCountsModel"];
      /** Missing */
      missing?: components["schemas"]["MissingEntityModel"][];
      /**
       * Truncated
       * @default false
       */
      truncated?: boolean;
    };
    /**
     * GraphAvailabilityEntityCounts
     * @description The distinct entities in one role, split by their kind in the code index.
     */
    EntityCounts: {
      /**
       * Parties
       * @description entities with figures of their own
       */
      parties: number;
      /**
       * Totals
       * @description entities that hold other entities' figures
       */
      totals: number;
      /**
       * Residual
       * @description entities holding figures no other entity does
       */
      residual: number;
      /**
       * Unclassified
       * @description entities the code index does not list
       */
      unclassified: number;
    };
    /**
     * EntityCoverage
     * @description How many of the window's periods one ranked entity holds.
     */
    EntityCoverage: {
      entity: components["schemas"]["StepRef"];
      /** Periods */
      periods: number;
      /** Of */
      of: number;
    };
    /**
     * EntityGroup
     * @description A named group whose members fill one entity role, as the request named it
     *     ("EU member states"). The members themselves are the role's dcids in
     *     `BaseIdentity.entities`. This records only that they were asked for as one
     *     group, so the heading can say "the 27 EU member states" after any edit that
     *     keeps the role's members. A group the graph holds no node for, read from the
     *     membership registry ("Asia (DAC)"), names the registry's id for it in
     *     `group_id`, so a resubmit restores it and the total its dataset publishes for it.
     *     A group whose `ref` is a continent or subregion
     *     that the membership policy holds or omits (`MembershipPolicy.holds_region`)
     *     reads as its countries ("the 54 countries in Africa"), whatever its graph
     *     type. `entity_type` is informational, and the reading keys on `ref`. When
     *     the role binds the total its dataset publishes
     *     for the group ("Africa (DAC)") in place of the members, `total` names that
     *     party and the role's one dcid is it. A Spec serves its groups on
     *     `ResolvedSpec.entity_groups`, and a resubmit posts them beside the identity
     *     (`ResubmitIdentityEntry.entity_groups`, `ResubmitCandidate.entity_groups`).
     */
    EntityGroup: {
      /**
       * Ref
       * @description the group's own graph node, when the graph holds one; null otherwise
       */
      ref?: string | null;
      /**
       * Label
       * @description the group's name as the request gave it, plain text
       */
      label: string;
      /**
       * Entity Type
       * @description the graph type of the group's own node, e.g. Continent, UNGeoRegion, ContinentalUnion; null when the graph holds no node for the group
       */
      entity_type?: string | null;
      /**
       * Total
       * @description the party the dataset publishes as the group's total, which the role binds in place of the members (DACAfrica for Africa); null when the role binds the members
       */
      total?: string | null;
      /**
       * Group Id
       * @description the membership registry's id for a group the graph holds no node for, e.g. groups/OECD.DAC.Region.Asia; null when ref is set or the group is no registry group
       */
      group_id?: string | null;
    };
    /**
     * EntityOptions
     * @description Candidates for one directional entity axis.
     *
     *     Parallel to SlotOptions, but for a directional *entity* (an observation
     *     endpoint) rather than a constraint-property value. A role-bearing flow may
     *     expose either its origin or destination axis here when that axis was left
     *     open. The entry's ``role`` is the routing key a client uses to promote a
     *     selected candidate into ``identity.entities`` on a dataset_resubmit entry.
     */
    EntityOptions: {
      /**
       * Entity Ref
       * @description dcid of the currently-bound directional entity; joins to an entry in SentenceToken.entity_refs. None means this role axis is open -- no entity is bound on it, and `options` is this axis's own candidate member set rather than a set the current binding could be swapped among. An open role axis omits this key entirely on both the buffered body and the SSE entity_options event, rather than emitting null -- the opposite of SlotOption.coverage's own explicit-null convention on that same SSE channel
       */
      entity_ref?: string | null;
      /** @description the flow axis these candidates apply to; present even when entity_ref is omitted so a selected candidate can be posted under the same identity.entities role */
      role: components["schemas"]["RoleAxis"];
      /**
       * Options
       * @description candidate entities, reusing SlotOption for shape parity with slot_options
       */
      options: components["schemas"]["SlotOption"][];
      /**
       * Truncated
       * @description true when options is capped or deliberately count-only, so it is not the complete known candidate set; false when every known candidate is listed
       */
      truncated: boolean;
      /**
       * Source
       * @description 'seed' for a hand-curated candidate set; 'observed' for candidates already confirmed while resolving this flow axis
       */
      source: ("observed" | "seed") | (string & {});
    };
    /**
     * GraphResolveEntity
     * @description A reference with its kind. `kind` is `null` only for a `not_held` entity, which the
     *     graph holds no node to classify.
     */
    EntityRef: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
      /** Kind */
      kind:
        | (
            | (
                | "country"
                | "continent"
                | "subregion"
                | "continental_union"
                | "place_other"
                | "aggregate"
                | "organisation"
                | "group"
                | "stat_var"
                | "code_system"
                | "code"
                | "unit"
                | "source"
                | "dataset"
                | "provenance"
                | "other"
              )
            | (string & {})
          )
        | null;
    };
    /**
     * Exclusion
     * @description A provenance a base source holds that this deployment does not admit, because
     *     another Data Commons supersedes it.
     */
    Exclusion: {
      /** Ref */
      ref: string;
      /**
       * Reason
       * @description superseded_by_dfo: an upstream copy of a dataset DFO imports. superseded_by_un_system: a UN System Data Commons agency's series replace it
       */
      reason: ("superseded_by_dfo" | "superseded_by_un_system") | (string & {});
    };
    /**
     * Expansion
     * @description Codes a hierarchical value/set binding resolved to beyond its own bound
     *     value(s): the descendant codes admitted by walking the code index's
     *     `specializationOf` closure for a dimension the index declares
     *     `hierarchical` (code_index.query.CodeIndex.descendants).
     *
     *     Additive only. Never a substitute for `binding`, and never fed into spec
     *     identity -- `BindingValue`/`BindingSet` are the sole identity-bearing wire
     *     form (see Slot.expansion's own docstring for why: identity is minted from
     *     `BindingSet.values`, built from the query's own drafted values, before
     *     resolution ever widens them). `added` never repeats a dcid already in the
     *     binding's own value(s); it holds only what expansion contributed on top.
     */
    Expansion: {
      /**
       * Added
       * @description descendant codes admitted beyond the slot's own bound value(s), in the code index's descendant-walk order. Never empty -- a slot whose expansion added nothing carries no Expansion at all (Slot.expansion is None), rather than one with added=[]
       */
      added: components["schemas"]["GraphRef"][];
    };
    /**
     * GraphFacetItem
     * @description One facet of a variable, as the `facets` list relation serves it. `ref` is the facet id,
     *     which hashes the facet's metadata.
     */
    FacetItem: {
      /** Ref */
      ref: string;
      /** Label */
      label: null;
      source: components["schemas"]["AvailabilitySource"];
      unit: components["schemas"]["NodeRef"] | null;
      measurement_method: components["schemas"]["NodeRef"] | null;
      /** Observation Period */
      observation_period: string | null;
      /** Scaling */
      scaling: string | null;
      /** First Year */
      first_year: string | null;
      /** Last Year */
      last_year: string | null;
      /** Observations */
      observations: number;
      /**
       * Places
       * @description null for a role-bearing variable
       */
      places: number | null;
    };
    /**
     * FacetNationalCurrencyBinding
     * @description The unit axis bound to each entity's own currency: at each entity `role`
     *     binds, the facets whose unit is the one currency the graph's
     *     `nationalCurrencyOf` names for it, served as published and never converted.
     *     The conversion request naming the same role (`UnitCurrencyRole`) converts
     *     each row into that currency instead.
     */
    FacetNationalCurrencyBinding: {
      national_currency: components["schemas"]["UnitCurrencyRole"];
    };
    /**
     * FacetOptions
     * @description The candidate set one facet axis (see ResolvedFacet) was chosen from:
     *     every distinct value seen on the resolved candidates' own observation
     *     facets, so a client can offer "what else could I ask for" alongside the
     *     served answer.
     *
     *     Parallel to SlotOptions/EntityOptions, reusing SlotOption for shape
     *     parity. Unlike either, source is always "observed" -- a facet axis has
     *     no curated seed taxonomy -- and no option here ever carries a populated
     *     SlotOption.coverage: there is no separate confirm step for a facet
     *     option, the observed count already ranks the list.
     */
    FacetOptions: {
      /**
       * Axis
       * @description the facet axis this option set belongs to (see FacetAxis)
       */
      axis: string;
      /**
       * Options
       * @description candidate values seen on the resolved candidates' own unfiltered observation facets, ranked by in-window observation-point count descending then ref ascending; a dcid the graph can't label falls back to the dcid itself as its own label rather than being dropped -- every value here already came off a confirmed observation facet, unlike a curated seed candidate. On the measurementMethod and unit axes, an option with no value.ref stands for the facets that declare no value on the axis, as Data Commons omits the member; it is listed only beside a declared value, ranks last among equal counts, and is pinned by posting identity.facets.<axis> as {state: 'value', ref: null}
       */
      options: components["schemas"]["SlotOption"][];
      /**
       * Truncated
       * @description true when options is bounded by SEARCH_MAX_OPTIONS rather than the full distinct set observed
       */
      truncated: boolean;
      /**
       * Source
       * @description always 'observed' -- a facet axis has no curated seed taxonomy
       */
      source: ("observed" | "seed") | (string & {});
    };
    /**
     * FacetRefBinding
     * @description A facet axis bound to a specific ref. Every axis accepts this form;
     *     the unit axis alone also accepts `FacetUnitRequestBinding`, the
     *     conversion-request form (`currency`/`prices`/`base_year`), and
     *     `FacetNationalCurrencyBinding`. A null `ref` binds the facets that declare
     *     no value on the axis, and only `NULL_REF_FACET_AXES` accept it.
     */
    FacetRefBinding: {
      /** Ref */
      ref: string | null;
    };
    /**
     * FactSummaryModel
     * @description The closed, token-capped fact summary a revision reports.
     */
    FactSummaryModel: {
      /**
       * Changed
       * @description the patch's own changed field names, empty for a create or a no-op write
       */
      changed: string[];
      /**
       * Series
       * @description every visible series this revision resolves, capped
       */
      series: components["schemas"]["FactSummarySeriesEntry"][];
      /**
       * Series Cut
       * @description how many series the series cap and the token cap together dropped from this summary
       */
      series_cut: number;
      /** @description this component's own [start, end] period window, null where its type defines none */
      window: components["schemas"]["WindowModel"] | null;
      /**
       * Unit
       * @description this component's own unit, the value its resolved payload carries: a unit's graph name (its ref when the graph has none), a converted unit, or a composed unit. A line_chart or bar_chart reports its first series' unit and a table the unit every row shares. Null where the type defines none, the rows declare none, or a table's rows differ.
       */
      unit:
        | string
        | components["schemas"]["ConvertedUnitModel"]
        | components["schemas"]["ComposedUnitModel"]
        | null;
      /**
       * Change
       * @description the stat_card's derived comparison between its two basis periods, null for every other member and for a stat_card whose intent carries no change
       */
      change: {
        [key: string]: unknown;
      } | null;
      /**
       * Source Refs
       * @description every distinct raw provenance ref a source_card's frame carries. It is null for every other member.
       */
      source_refs: string[] | null;
      /**
       * Defaults
       * @description the choices this component made where its intent left one open, empty when it made none
       */
      defaults: components["schemas"]["AppliedDefaultModel"][];
    };
    /**
     * FactSummarySeriesEntry
     * @description One `fact_summary.series[]` entry. It reports one visible series'
     *     identity, point count and formatted boundary values.
     */
    FactSummarySeriesEntry: {
      /**
       * Id
       * @description this series' own id, null when none could be assigned
       */
      id: string | null;
      /**
       * Label
       * @description this series' own display label
       */
      label: string;
      /**
       * Coordinates
       * @description this series' own dimension coordinates
       */
      coordinates: {
        [key: string]: unknown;
      };
      /**
       * Point Count
       * @description how many of this series' points carry an observed value
       */
      point_count: number;
      /**
       * First Value
       * @description this series' earliest observed value, formatted, null when it has none
       */
      first_value: string | null;
      /**
       * Last Value
       * @description this series' latest observed value, formatted, null when it has none
       */
      last_value: string | null;
    };
    /** @constant */
    FlowAccount: "provider";
    /** FormatOptionModel */
    FormatOptionModel: {
      /** Name */
      name: string;
      /** State */
      state: string;
      /** Reason */
      reason?: string | null;
    };
    /** FrameCurrent */
    FrameCurrent: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      status: "current";
      /** @description the named frame, which is its rendering's current one */
      frame: components["schemas"]["FramePair"];
    };
    /**
     * FrameDimensionMatch
     * @description One dimension of a frame's query-filtered view (`?query=` given,
     *     `dimension` absent). Its values are filtered to those matching the
     *     query.
     */
    FrameDimensionMatch: {
      /**
       * Name
       * @description this dimension's own column name
       */
      name: string;
      /**
       * Values
       * @description this dimension's own values matching the query
       */
      values: string[];
      /**
       * Matched Count
       * @description how many of this dimension's values matched the query
       */
      matched_count: number;
    };
    /**
     * FrameDimensionSummary
     * @description One dimension of a frame's structural view (`GET .../frames/{...}`
     *     with neither `dimension` nor `query` given). Its values are capped to
     *     the per-dimension listing cap.
     */
    FrameDimensionSummary: {
      /**
       * Name
       * @description this dimension's own column name
       */
      name: string;
      /**
       * Values
       * @description this dimension's own values, capped
       */
      values: string[];
      /**
       * Total Count
       * @description this dimension's own value count before capping
       */
      total_count: number;
      /**
       * Truncated
       * @description whether this dimension's values list was capped
       */
      truncated: boolean;
      /**
       * Plural
       * @description whether this frame's series hold more than one value of this dimension, a null counting as one; the estimates continuing a series hold its method, so they leave measurementMethod not plural
       */
      plural: boolean;
    };
    /**
     * FrameDimensionValuesResponse
     * @description `GET /api/presentation/frames/{spec_id}/{content_version}?dimension=`'s
     *     body. It reports one dimension's full value list, read fresh and
     *     uncapped. Given alongside `?query=`, `values` and `total_count`
     *     describe only the values matching the query.
     */
    FrameDimensionValuesResponse: {
      /**
       * Dimension
       * @description the dimension this response reports
       */
      dimension: string;
      /**
       * Values
       * @description every value this dimension carries, uncapped, or only the values matching `query` when it is given
       */
      values: string[];
      /**
       * Total Count
       * @description how many values this dimension carries, or how many match `query` when it is given
       */
      total_count: number;
    };
    /**
     * FrameFilteredViewResponse
     * @description `GET /api/presentation/frames/{spec_id}/{content_version}?query=`'s
     *     body (`dimension` absent). It reports every dimension this frame
     *     declares, filtered to values matching the query, counts kept.
     */
    FrameFilteredViewResponse: {
      /**
       * Dimensions
       * @description every dimension this frame declares, filtered
       */
      dimensions: components["schemas"]["FrameDimensionMatch"][];
      /**
       * Period Grain
       * @description this frame's own period grain
       */
      period_grain: string;
      /**
       * Coverage
       * @description this frame's own [start, end] period coverage, null if it has none
       */
      coverage: [string, string] | null;
    };
    /** FrameMoved */
    FrameMoved: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      status: "moved";
      /** @description the current frame of the named frame's rendering */
      frame: components["schemas"]["FramePair"];
    };
    /** FramePair */
    FramePair: {
      /** Spec Id */
      spec_id: string;
      /** Content Version */
      content_version: string;
    };
    /** FramePending */
    FramePending: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      status: "pending";
      /**
       * Operation Id
       * @description the queued rebuild, pollable on the operations route
       */
      operation_id: string;
      /**
       * Retry After S
       * @description seconds to wait before calling again
       */
      retry_after_s: number;
    };
    /**
     * FrameStructuralViewResponse
     * @description `GET /api/presentation/frames/{spec_id}/{content_version}`'s body
     *     with neither `dimension` nor `query` given. It reports the frame's own
     *     structural view, every dimension capped.
     */
    FrameStructuralViewResponse: {
      /**
       * Dimensions
       * @description every dimension this frame declares
       */
      dimensions: components["schemas"]["FrameDimensionSummary"][];
      /**
       * Period Grain
       * @description this frame's own period grain
       */
      period_grain: string;
      /**
       * Coverage
       * @description this frame's own [start, end] period coverage, null if it has none
       */
      coverage: [string, string] | null;
      /**
       * Series Count
       * @description how many distinct series this frame resolves
       */
      series_count: number;
    };
    /**
     * Freshness
     * @description A source's own refresh cadence, read from DCP provenance arcs that imports populate
     *     unevenly: `dc/base/WHO_COVID19` carries both `sourceReleaseFrequency` and
     *     `automaticRefreshType`, `dc/base/BIS_CentralBankPolicyRate` only the second, and
     *     `dc/base/WHO_GHO` neither. Nullability is the contract.
     *
     *     `release_frequency` is the raw `sourceReleaseFrequency` ISO 8601 duration (`P1M`);
     *     `release_frequency_label` is `materialise.cadence.cadence_label`'s display label for it
     *     (`Monthly`), or the raw token when that module does not recognise it.
     *
     *     `refresh_type` is `automaticRefreshType`'s value: how this deployment refreshes the
     *     source, such as `GCPCloudRunAutomaticRefresh`, or the sentinel `NoAutomaticRefresh`.
     */
    Freshness: {
      /** Release Frequency */
      release_frequency: string | null;
      /** Release Frequency Label */
      release_frequency_label: string | null;
      /** Refresh Type */
      refresh_type: string | null;
    };
    /**
     * GraphRef
     * @description Every graph identifier in the contract.
     */
    GraphRef: {
      /**
       * Ref
       * @description the graph identifier
       */
      ref: string;
      /**
       * Label
       * @description plain-language display name, read from the graph
       */
      label: string;
    };
    /**
     * GraphSchema
     * @description The full `GET /api/graph/schema` document.
     */
    GraphSchema: {
      /**
       * Schemas
       * @description JSON Schema of each served request and response body, keyed by name
       */
      schemas: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      /**
       * Capabilities
       * @description path of this surface's capability document
       */
      capabilities: string;
    };
    /** GroupNode */
    GroupNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "group";
      group: components["schemas"]["MembershipBlock"];
    };
    /**
     * GroupbyOptions
     * @description `options.groupby`: a safe roll-up that keeps exactly the axes named
     *     in `by`, one row per distinct combination of their values. Every other
     *     graph-declared summable axis a frame decoded is summed away, `stat_var`
     *     included. `by` names what a caller wants to see, the opposite of
     *     `groupby_sum`'s own "collapse this axis" reading. `sum` is the only op
     *     this closed reshape list allows.
     *
     *     Every `by` entry names a code system some deployment declaration marks
     *     summable, a role/entity column (`materialise.roles.KNOWN_ROLE_NAMES`),
     *     `stat_var`, or a column every frame carries regardless of shape; any
     *     other name refuses `rollup_not_summable`
     *     (`datasets_api.groupby.refuse_unknown_by_axes`). A declared axis this
     *     frame's StatVars do not decode is left out of the collapse set
     *     (`datasets_api.groupby.collapse_axes`).
     *
     *     `levels` rolls a kept hierarchical axis up to one depth of its parent
     *     chain before the sum: each code becomes its ancestor at that depth, and
     *     depth 0 is the root codes. Each key must also appear in `by`, and must
     *     be one of the capabilities document's `groupby_level_axes`
     *     (`datasets_api.render.check_options_supported`).
     */
    GroupbyOptions: {
      /** By */
      by: string[];
      /**
       * Op
       * @constant
       */
      op: "sum";
      /**
       * Levels
       * @description code system -> depth: roll each kept code up to its ancestor at that depth (0 = root codes); a code shallower than the depth stays as itself, under its own label
       */
      levels?: {
        [key: string]: number;
      } | null;
    };
    /**
     * GroupbyOptionsModel
     * @description `axes` names the axes a `groupby.by` request may keep: every other
     *     declared-summable axis a frame decoded is collapsed into it. Empty
     *     while `state` is `unavailable`.
     */
    GroupbyOptionsModel: {
      /** State */
      state: string;
      /** Reason */
      reason?: string | null;
      /** Axes */
      axes?: {
        [key: string]: unknown;
      }[];
    };
    /**
     * Headline
     * @description The exact, one-year summary of a role-bearing answer's own served
     *     population: the year `CoverageIndex.headline` (series_coverage) heads the
     *     answer with, whether that year was the one the question named, the exact
     *     observation and series count in that year alone, and how many distinct dcids
     *     each role carries in it. `series_coverage.index.Headline`'s own docstring is
     *     the source of truth for why `observations` and `series` are always equal
     *     under this schema.
     *
     *     The counts are those of the year the answer's read plan serves. Under a `latest`
     *     window that is the year its variables elect (`CoverageIndex.elected_years`), which
     *     the preview and a mint of the Spec serve too. Under a named window it is the latest
     *     year with data in that window, so a question naming 2015 to 2020 counts the latest
     *     of those years with data. `named_window` carries the years it named.
     *
     *     Attached to every role-bearing answer (named-destination confirmed and
     *     open-axis discovered alike), never to a non-role-bearing one: coverage
     *     only exists for role-bearing series (series_coverage.schema's own scope
     *     note), and computing this is a free in-memory bitmask operation, not a
     *     network read, so there is no population-size reason to withhold it from
     *     a narrow answer the way the per-series preview stays capped at 20
     *     regardless of how broad the answer is.
     */
    Headline: {
      /**
       * Year
       * @description the year the counts are for. For a latest window it is the elected year: of the three calendar years ending at the newest year a variable's series hold, at or before the year the coverage artifact was built, the newest one that at least half as many series hold as the fullest of the three, and with several variables the newest year any of them elects. For a named window it is the latest year any served series has an observation inside the window
       */
      year: number;
      /**
       * Year Named
       * @description whether the request itself named a year or a range of years, rather than defaulting to one, independent of whether those years include the shown `year`
       */
      year_named: boolean;
      /** @description the year or years the request named: equal bounds for one year, an absent bound for an open range; null when no year was named. The counts are for `year` alone, whatever this window holds */
      named_window?: components["schemas"]["TimeWindow"] | null;
      /**
       * Observations
       * @description exact observation count across served series in year
       */
      observations: number;
      /**
       * Series
       * @description exact series count with an observation in year
       */
      series: number;
      /**
       * Role Counts
       * @description distinct dcid count per role active in year, keyed by the graph's own role property dcid (e.g. financingProvider, financingRecipient) -- never by a donor/recipient label, so the wire stays aligned with Data Commons' own names
       */
      role_counts: {
        [key: string]: number;
      };
      /**
       * Recent Years
       * @description the counts for three calendar years, newest first, so a newest year with far fewer series than the years before it reads as incomplete. For a latest window they are raw counts over every series the answer holds, ending at the newest year any of them holds at or before the year the coverage artifact was built, or at the newest year any holds when none holds a year that early; `year` is one of the three: the newest year a variable heads, which is the year it elected or, for a variable that elects none, such as one of monthly data, its newest year at or before the build year. When no variable holds a year that early, each heads its newest year. `observations`, `series` and `role_counts` count only the variables heading it. For a named window they end at `year`, the first entry repeats `observations`, `series` and `role_counts`, and the earlier years count whether or not `named_window` reaches them. A year with no data is kept with zero counts. The list stops at the first year the coverage artifact represents, so it can hold fewer than three entries
       */
      recent_years: components["schemas"]["HeadlineYear"][];
    };
    /**
     * HeadlineYear
     * @description The exact counts for one calendar year of a role-bearing answer's served
     *     population: observations and series with an observation in it, and how many
     *     distinct dcids each role carries. A year with no data counts zero.
     */
    HeadlineYear: {
      /**
       * Year
       * @description the calendar year these counts are for
       */
      year: number;
      /**
       * Observations
       * @description exact observation count across served series in year
       */
      observations: number;
      /**
       * Series
       * @description exact series count with an observation in year
       */
      series: number;
      /**
       * Role Counts
       * @description distinct dcid count per role active in year, keyed by the graph's own role property dcid; a role with no dcid in the year is absent
       */
      role_counts: {
        [key: string]: number;
      };
    };
    /**
     * HealthResponse
     * @description `GET /healthz`'s own response body, shared across every surface.
     */
    HealthResponse: {
      /**
       * Status
       * @description always "ok" for a 200 response
       * @constant
       */
      status: "ok";
      /**
       * Build
       * @description the commit sha the image was built from, the same value the x-dfo-commit response header carries, "unknown" on a checkout run with no DFO_BUILD_COMMIT set
       */
      build: string;
      /**
       * Capability Version
       * @description this surface's own capability_version token
       */
      capability_version: string;
    };
    /**
     * IdentityBindingExact
     * @description A single bound dcid, denoting that code alone -- never its subtree,
     *     even where the code is a hierarchical (non-leaf) code (see
     *     `docs/identity-v1.md` in `spec-kit` for the denotation rule: `value`
     *     denotes a hierarchical code's whole subtree, `exact` denotes the code
     *     alone). Slot-only: `_build_facet_binding` refuses `exact` on a facet.
     *     No engine `Binding` arm maps onto this state and no minting site
     *     produces it -- see `IdentityBinding`'s own docstring.
     */
    IdentityBindingExact: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      state: "exact";
      /**
       * Ref
       * @description the bound dcid, denoting that code alone
       */
      ref: string;
    };
    /**
     * IdentityBindingSet
     * @description A bound dcid set, in the identity core's own binding wire shape.
     */
    IdentityBindingSet: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      state: "set";
      /**
       * Refs
       * @description the bound dcids (dfo_spec_kit sorts and de-duplicates)
       */
      refs: string[];
    };
    /**
     * IdentityBindingUnbound
     * @description An unbound slot/facet binding.
     */
    IdentityBindingUnbound: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      state: "unbound";
    };
    /**
     * IdentityBindingValue
     * @description A single bound dcid, in the identity core's own binding wire shape.
     */
    IdentityBindingValue: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      state: "value";
      /**
       * Ref
       * @description the bound dcid
       */
      ref: string;
    };
    /**
     * IdentityCurrencyRole
     * @description The role-shaped form of a unit request's `currency`: the currency of
     *     the entity bound to this spec role, resolved per row. Field-for-field mirror
     *     of the identity core's own `_CURRENCY_ROLE_KEYS`/`_CURRENCY_ROLES`
     *     (`dfo_spec_kit.identity`'s `_build_currency`, the object arm).
     */
    IdentityCurrencyRole: {
      /**
       * Role
       * @description the entity role whose bound entity's currency this request means
       */
      role: ("observationAbout" | "origin" | "destination") | (string & {});
    };
    /**
     * IdentityFacetValueAbsent
     * @description A measurementMethod or unit facet bound to no declared value:
     *     `{"state": "value", "ref": null}` asks for the facets that declare no value
     *     on the axis, the ones Data Commons serves without that member. An unbound
     *     axis admits every facet; this binding admits only those without a value.
     *     Mirrors the identity core's null facet ref (`docs/identity-v1.md` in
     *     `spec-kit`). `ref` serialises as `null` even under `exclude_none`, since
     *     the identity core refuses a value binding with neither `ref` nor `request`.
     */
    IdentityFacetValueAbsent: {
      /**
       * State
       * @default value
       * @constant
       */
      state?: "value";
      /**
       * Ref
       * @description null: the facet declares no value on this axis
       */
      ref: null;
    };
    /**
     * IdentityFacetValueRequest
     * @description A unit-axis facet bound via the request form: "serve whatever facet
     *     honours this completed currency/prices/base_year request" rather than a
     *     literal graph ref. `state` reuses the value-state spelling since this is
     *     still a single-valued binding to the identity core -- `request` is what
     *     distinguishes it from `IdentityBindingValue`'s `ref` form (see
     *     `_facet_binding_tag`, this union's discriminator).
     */
    IdentityFacetValueRequest: {
      /**
       * State
       * @default value
       * @constant
       */
      state?: "value";
      /** @description the completed unit-conversion request */
      request: components["schemas"]["IdentityUnitRequest"];
    };
    /**
     * IdentityShapeDenominatorRef
     * @description The described arm's `measurement_denominator`, resolved to a dcid.
     */
    IdentityShapeDenominatorRef: {
      /**
       * Ref
       * @description the resolved denominator StatVar's dcid
       */
      ref: string;
    };
    /**
     * IdentityShapeDenominatorUnresolved
     * @description The described arm's `measurement_denominator`, present on the graph but
     *     never resolved to a dcid (e.g. a dcid-less ProvisionalNode) -- distinct
     *     from the member being absent entirely, which means no denominator arc
     *     exists at all.
     */
    IdentityShapeDenominatorUnresolved: {
      /**
       * Unresolved
       * @description always the literal true -- the arc exists but names no dcid
       * @default true
       * @constant
       */
      unresolved?: true;
    };
    /**
     * IdentityShapePin
     * @description The pinned-ask arm of the identity core's `shape` union
     *     (`kind: "stat_var"`): a single StatVar dcid, minted by Datasets'
     *     statvar_set. See `BaseIdentity`'s cross-member validator -- when this arm
     *     is chosen, `slots` must be empty.
     */
    IdentityShapePin: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "stat_var";
      /**
       * Id
       * @description the pinned StatVar's dcid
       */
      id: string;
    };
    /**
     * IdentityShapeSchema
     * @description The described-ask arm of the identity core's `shape` union
     *     (`kind: "statvar_schema"`): up to five sparse schema members mapping 1:1
     *     onto Search's FiveTuple (see `engine.shape.identity_shape_for`, the
     *     adapter that builds this from a ShapeDraft's or a grounded wire Shape's
     *     five-tuple dcids). Minted by Search for every standard and family shape.
     *
     *     Every member is optional and sparse -- an absent member contributes no
     *     bytes, the same sparse rule the facets map follows -- but an arm
     *     describing nothing is invalid: at least one member must be present (see
     *     `_at_least_one_schema_member`).
     */
    IdentityShapeSchema: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "statvar_schema";
      /**
       * Population Type
       * @description the graph populationType dcid
       */
      population_type?: string | null;
      /**
       * Measured Property
       * @description the graph measuredProperty dcid
       */
      measured_property?: string | null;
      /**
       * Stat Type
       * @description the graph statType dcid, e.g. measuredValue
       */
      stat_type?: string | null;
      /**
       * Measurement Qualifier
       * @description the graph measurementQualifier dcid, present only when the measured property is qualified
       */
      measurement_qualifier?: string | null;
      /**
       * Measurement Denominator
       * @description the graph measurementDenominator, present only on a ratio or per-capita measure: {'ref': dcid} when resolved, {'unresolved': true} when the arc exists but names no dcid
       */
      measurement_denominator?:
        | (
            | components["schemas"]["IdentityShapeDenominatorRef"]
            | components["schemas"]["IdentityShapeDenominatorUnresolved"]
          )
        | null;
    };
    /**
     * IdentitySlot
     * @description One what/how slot's identity contribution: property dcid + binding state.
     *
     *     Never a where/when/source slot: `where` is carried by entity roles instead,
     *     `when` is carried by `requested_window` instead, and `source` is carried by
     *     `facets.provenance` instead -- all three would otherwise hash resolved
     *     graph state rather than what was actually asked. Every IdentitySlot here
     *     carries a real constraint property by construction of the shape grammar.
     */
    IdentitySlot: {
      /**
       * Property
       * @description the constraint property dcid
       */
      property: string;
      /**
       * Binding
       * @description this slot's bound state
       */
      binding:
        | components["schemas"]["IdentityBindingValue"]
        | components["schemas"]["IdentityBindingSet"]
        | components["schemas"]["IdentityBindingUnbound"]
        | components["schemas"]["IdentityBindingExact"];
    };
    /**
     * IdentityUnitRequest
     * @description A completed unit-conversion request, in the identity core's own wire
     *     shape (`dfo_spec_kit.identity`'s `_build_unit_request`) -- legal only
     *     inside a unit-axis facet binding's `request` member
     *     (`IdentityFacetValueRequest`; see `BaseIdentity`'s model validator, which
     *     refuses this form on any other axis).
     *
     *     Field-for-field mirror of the identity core's own `_UNIT_REQUEST_KEYS`
     *     schema: `currency` is upper-case ISO 4217 or a role object naming
     *     the spec role whose bound entity's currency to use (see
     *     `IdentityCurrency`; the identity core NFC-normalises a string spelling
     *     but does not case-fold, so a lower-case currency refuses here rather
     *     than silently normalising to a different meaning at hash time), `prices`
     *     is current (nominal) or constant (real, anchored to
     *     `base_year`), and `base_year` is present exactly when `prices=="constant"`
     *     -- both directions enforced below, matching the identity core's own
     *     `invalid_unit_request` pair of checks. `base_year` is `StrictInt`,
     *     matching `_require_integral_number`'s own exclusion of `bool` (a Python
     *     `int` subclass) and of numeric strings -- a lax `int` field would coerce
     *     JSON `true` to `1` and `"2023"` to `2023`, hashing a malformed request
     *     under an unintended base year instead of refusing it. Under simultaneous
     *     violations
     *     (e.g. a lower-case currency together with a missing base_year) the two
     *     layers can report a different invariant first: this model's per-field
     *     `currency` pattern validates ahead of `_base_year_matches_prices` (a
     *     `mode="after"` validator, which never runs once a field has already
     *     failed), while the identity core checks `prices`-vs-`base_year` before
     *     the currency regex. Same HTTP status/code either way -- message content
     *     only.
     */
    IdentityUnitRequest: {
      /**
       * Currency
       * @description the requested currency, upper-case ISO 4217 (e.g. 'USD'), or a role object
       */
      currency: string | components["schemas"]["IdentityCurrencyRole"];
      /**
       * Prices
       * @description 'current' (nominal) prices, or 'constant' (real, base_year-anchored) prices
       */
      prices: ("current" | "constant") | (string & {});
      /**
       * Base Year
       * @description required exactly when prices=='constant'; absent when prices=='current'
       */
      base_year?: number | null;
    };
    /**
     * IdentityWindowAll
     * @description No date signal was requested at all.
     */
    IdentityWindowAll: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "all";
    };
    /**
     * IdentityWindowLatest
     * @description An explicit latest-ask: re-resolve to whatever year is CURRENTLY latest.
     */
    IdentityWindowLatest: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "latest";
    };
    /**
     * IdentityWindowRange
     * @description A concrete requested date range; at least one bound is always present.
     */
    IdentityWindowRange: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "range";
      /**
       * Start Year
       * @description absent means open-ended start
       */
      start_year?: number | null;
      /**
       * End Year
       * @description absent means open-ended end
       */
      end_year?: number | null;
    };
    JsonValue: unknown;
    /**
     * LeftOut
     * @description One data gap: why some data was left out, how many, and of what. The caller's own
     *     selection is a parameter and never appears here.
     *
     *     A `pooled_entities` count is of the distinct parties of one pooled role, named in `role`,
     *     across all the step's inputs. Those parties are never among the entities the step kept.
     *     Only that `of` takes a `role`, and it requires one.
     */
    LeftOut: {
      /** Reason */
      reason: string;
      /** Count */
      count: number;
      /** Of */
      of: ("entities" | "periods" | "entity_periods" | "pooled_entities") | (string & {});
      /** Role */
      role?: string;
    };
    /**
     * Manifest
     * @description `trace` stays a plain dict, since `materialise.trace.ManifestTrace.to_dict()`
     *     is already this field's exact wire shape.
     *
     *     `series_count` is the number of distinct series this definition
     *     resolves, as the version's description counts them (`statistics.SeriesFigures.series`): a
     *     series and the estimates continuing it count once, though the statistics artifact holds a
     *     row for each method. `None` means a version record minted before this field existed, whose old
     *     inline `statistics` no fact carries. The per-series detail itself lives in the
     *     `series-statistics/1` Parquet artifact every door that returns a
     *     `Manifest` lists in `artifacts` whenever `series_count` is not `None`
     *     (`datasets_api.render.render_and_store_series_statistics`), never
     *     inline on this model.
     *
     *     `output_options` is `None` on a version record minted before the field
     *     existed, the same convention `series_count` uses.
     *
     *     `prepared_at` is when this version was first prepared, written once at its
     *     first mint and stored with it, so every re-mint and re-render reads the same
     *     instant.
     */
    Manifest: {
      /**
       * Schema Version
       * @default 1
       */
      schema_version?: number;
      definition: components["schemas"]["DefinitionModel"];
      /** Content Version */
      content_version: string;
      /**
       * Prepared At
       * Format: date-time
       */
      prepared_at: string;
      coverage: components["schemas"]["CoverageModel"];
      citation: components["schemas"]["CitationModel"];
      /** Trace */
      trace: {
        [key: string]: unknown;
      };
      /** Warnings */
      warnings?: components["schemas"]["WarningModel"][];
      /**
       * Diagnostics
       * @description facts about how this response was produced, for developers: a citation whose sources declare no processing level, and an origin catalogue past its staleness limit. A version stores none; each response states its own
       */
      diagnostics?: components["schemas"]["DiagnosticModel"][];
      /**
       * Artifacts
       * @description every servable artifact for this rendering, in a fixed order: every data artifact first, the series-statistics/1 artifact (rendering.statistics == 'series') last, if present. A caller selecting the data artifact should check rendering rather than take the first entry, but the order itself is a stable contract, not an accident of storage
       */
      artifacts: components["schemas"]["ArtifactEntryModel"][];
      /** Series Count */
      series_count?: number | null;
      output_options?: components["schemas"]["OutputOptionsModel"] | null;
      /**
       * Series Coverage Stamp
       * @description the series_coverage artifact stamp this request's sync-admission estimate was computed against, kept as lineage only. content_version is a pure function of the frame and does not fold this in. Not the same coverage as the 'coverage' field above (materialise.window.Coverage's row/dimension/window report)
       */
      series_coverage_stamp?: string | null;
      /** @description how long this version can still be fetched: the retention of the frame every file renders from (a derived version's base frame). Each door sets it on its response */
      retention?: components["schemas"]["RetentionModel"] | null;
    };
    /**
     * GraphResolveMatched
     * @description The listed text the input matched, and whether it is the entity's name, an alias, or a
     *     code. A phrase naming a group's members ("EU countries") matches as `alias`.
     */
    Matched: {
      /** Text */
      text: string;
      /** As */
      as: ("name" | "alias" | "code") | (string & {});
    };
    /**
     * GraphDefinitionMeasure
     * @description What the variable counts or sums, as the code index names it.
     */
    Measure: {
      /**
       * Label
       * @description the measure's noun phrase, such as `net disbursements`
       */
      label: string;
    };
    /**
     * MeasureAxisValue
     * @description One measure axis and the value a measure partition holds on it (see
     *     ResolvedSpec.measure_axis_values).
     */
    MeasureAxisValue: {
      /**
       * Axis
       * @description the declared measure-axis identifier (code_index.types.MeasureAxis.axis), e.g. 'measuredProperty' or a constraint-property dcid such as 'financialFlowType'
       */
      axis: string;
      /** @description the value's dcid and the measure index's label for it, e.g. Gross */
      value: components["schemas"]["GraphRef"];
    };
    /**
     * GraphMemberItem
     * @description One item of a list: its dcid and the owner's label for it, `null` where the owner holds
     *     no name.
     */
    MemberItem: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
    };
    /**
     * MembersEnvelope
     * @description `POST /api/datasets/{id}/members`'s response: the members a mint of the spec serves,
     *     resolved without materialising a frame.
     *
     *     `members` lists them sorted by `ref`, and `served_count` counts them.
     *     `family_member_count` and `family_member_digest` state the whole population the identity
     *     admits, before a broader member's dominated members are dropped, as a mint's
     *     `trace.family_member_count` and `trace.family_member_digest` state it; both are `null`
     *     when member resolution cannot state that population.
     */
    MembersEnvelope: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version: 1;
      /** Spec Id */
      spec_id: string;
      /** Members */
      members: components["schemas"]["ServedMember"][];
      /** Served Count */
      served_count: number;
      /** Family Member Count */
      family_member_count: number | null;
      /** Family Member Digest */
      family_member_digest: string | null;
    };
    /**
     * GraphMembersPage
     * @description One page of `GET /api/graph/node/{dcid}/members`.
     */
    MembersPage: {
      /**
       * Ref
       * @description the node whose list this is
       */
      ref: string;
      /** Relation */
      relation:
        | ("codes" | "children" | "datasets" | "variables" | "members" | "countries" | "facets")
        | (string & {});
      /** @description the membership projection listed; null for a relation that takes none */
      projection: components["schemas"]["Projection"] | null;
      /**
       * As Of
       * @description the date membership was read at; null for today
       */
      as_of: string | null;
      /** Items */
      items: (
        | components["schemas"]["CodeItem"]
        | components["schemas"]["FacetItem"]
        | components["schemas"]["MemberItem"]
      )[];
      /**
       * Next Cursor
       * @description the cursor for the next page; null when this page ends the list
       */
      next_cursor: string | null;
      /**
       * Complete
       * @description whether the walk reached the end of a list the owner holds in full
       */
      complete: boolean;
      /**
       * Total
       * @description the list's length; null where the list is partial
       */
      total: number | null;
      /**
       * Gaps
       * @description the code of each way the list is partial
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the list read
       */
      built_from: {
        [key: string]: string;
      };
    };
    /**
     * GraphMembershipBlock
     * @description A group's or region's membership under its declared authority.
     */
    MembershipBlock: {
      authority: components["schemas"]["Authority"];
      /**
       * As Of
       * @description the date the read asked for; null for today
       */
      as_of: string | null;
      /**
       * Effective Date
       * @description the latest membership change on or before the date; null for an undated membership
       */
      effective_date: string | null;
      /** Projections */
      projections: components["schemas"]["ProjectionCount"][];
    };
    /** Methodology */
    Methodology: {
      /**
       * Description
       * @description how the publisher collects and compiles the data, as CommonMark
       */
      description: string | null;
    };
    /**
     * MintOptions
     * @description Rendering-only, never hashed into identity. `format`/`bundle`/`pivot`/
     *     `columns`/`groupby`/`without_party_totals` are this deployment's live rendering surface. A
     *     `groupby.by` entry names a code system some deployment declaration
     *     marks summable, a role/entity column, `stat_var`, or a column every
     *     frame carries regardless of shape; any other name refuses
     *     `rollup_not_summable` (`datasets_api.groupby.refuse_unknown_by_axes`).
     *     A declared axis this frame did not decode is simply absent from the
     *     collapse-set computation, not an error (see
     *     `datasets_api.groupby.collapse_axes`); an unsafe collapse refuses
     *     `rollup_not_summable` too, naming the axis and precondition
     *     (`materialise.reshape.groupby_sum`,
     *     `datasets_api.groupby.refuse_stat_var_collision`,
     *     `datasets_api.groupby.refuse_decode_gaps`). A `columns` entry naming a
     *     recognised-but-disabled enrichment field refuses `capability_unavailable`.
     *     `columns` selects the table and decoded columns it names. A list that names
     *     only enrichment fields selects nothing: every default column stays,
     *     decoded columns included, and the enrichments are added. A list that mixes
     *     a table column with an enrichment selects. Without a pivot, a list that
     *     names no decoded column keeps all of them, `status` is accepted and left
     *     out, `<role>_label` is written by default (a list naming it keeps
     *     `<role>`), and the written order follows the long layout
     *     (`materialise.projection`) whatever order the list names.
     *
     *     `layout: "frame"` writes a bare parquet file in the frame layout instead
     *     of the long layout: the frame's grammar columns as reshaped, with
     *     decoded axes as `stat_var_<code_system>`, `status` kept, and a converted
     *     unit as its JCS request text. `columns` then selects over those columns,
     *     as it does for pivot output. It refuses with `bundle: true`, a `pivot`,
     *     or a format other than parquet.
     *
     *     `without_party_totals: true` leaves out the rows whose party, on a flow party role the
     *     served identity binds no entity on, the code index declares a group total
     *     (`datasets_api.party_totals`). It runs on the frame before any reshape, so a `groupby`
     *     sums members alone. A cut that leaves rows out mints a version of its own, as a `groupby`
     *     collapse does; one that leaves nothing out serves the frame's own version.
     */
    MintOptions: {
      /**
       * Format
       * @default csv
       */
      format?: ("csv" | "xlsx" | "parquet") | (string & {});
      /**
       * Bundle
       * @default true
       */
      bundle?: boolean;
      groupby?: components["schemas"]["GroupbyOptions"] | null;
      pivot?: components["schemas"]["PivotOptions"] | null;
      /** Columns */
      columns?: string[] | null;
      /**
       * Without Party Totals
       * @default false
       */
      without_party_totals?: boolean;
      /** Layout */
      layout?: "frame" | null;
    };
    /**
     * MintRequest
     * @description Body of `POST /api/datasets`: one `input` and the render `options`.
     */
    MintRequest: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** Input */
      input: components["schemas"]["SpecIdInput"] | components["schemas"]["StatVarSetInput"];
      options?: components["schemas"]["MintOptions"];
    };
    /** MissingEntityModel */
    MissingEntityModel: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
    };
    /**
     * GraphAvailabilityNationalCurrency
     * @description The units that are each covered place's own currency.
     */
    NationalCurrency: {
      /** Currencies */
      currencies: number;
      /** Places */
      places: number;
    };
    /**
     * NearestRealSpec
     * @description A nearest_real suggestion: a full Spec found by relaxing one constraint
     *     binding and re-confirming the result against the live graph.
     *
     *     Graph-re-confirmed only, never fabricated. See relaxation for which
     *     binding was dropped to find it.
     */
    NearestRealSpec: {
      /**
       * Spec Id
       * @description deterministic hash of (shape + canonical slot bindings); permalink-safe, dedup key, golden-comparison handle, cache key
       */
      spec_id: string;
      /** @description the canonical definition this Spec was resolved from: {schema_version, identity}, the same shape Unsupported.definition uses. definition.identity is the identity-core projection this spec_id was minted from, serialised once and never re-derived; hashing it reproduces spec_id by construction. Post definition.identity back byte-for-byte as ResubmitIdentityPayload.identity to edit this Spec. Directional entities remain nested in identity.entities. */
      definition: components["schemas"]["SpecDefinition"];
      /** @description the engine's report of what it did with the ask: stat_vars, entities, coverage, trace, and every other display/diagnostic field. Never hashed; see ResolvedSpec */
      resolved: components["schemas"]["ResolvedSpec"];
      /** @description the definition part this suggestion relaxed, and the value(s) it dropped */
      relaxation: components["schemas"]["Relaxation"];
    };
    /**
     * NoData
     * @description Outcome when no grounded result can be returned.
     */
    NoData: {
      /**
       * Reason
       * @description why nothing could be returned, in contract resolution order. "entity_not_resolved" means a named entity could not be resolved to a graph node; "entity_ambiguous" means a named entity matched more than one graph candidate and none could be preferred over the others, distinct from "entity_not_resolved", where no node matched at all; "entity_role_not_admitted" means a named entity resolved to exactly one graph node, but no role any candidate shape declares admits that node's graph type -- the entity is real, just not the kind of thing this query's data is reported for; "entity_set_too_large" means every named entity resolved, but the places the request names, counting the members of each group or region among them and summed over the roles they sit on, exceed what the engine binds in one request -- distinct from every other entity_* reason, where one entity, not the size of the set, is what failed; "variable_not_resolved" means no StatVar matched the variable text (e.g. an absent posted stat_var_dcid or entity, or no measure match at all); "role_not_resolved" means the query names a role the engine could not resolve; "unit_not_resolved" means the unit binder could not classify a token in the requested unit phrase against its lexicons; "no_matching_slice" means the measure matched fine, but the requested combination has no corresponding data series -- the constructed/derived variable does not exist in the graph at all. Covers an identity resubmit refine edit with no confirmable sibling StatVar for the edited slice, and a dev-finance scheme x purpose x recipient combination that was never published as a series, on raw-text and resubmit alike; "binding_mismatch" means the variable resolved and graph-confirmed StatVars exist, but none satisfies the requested slot bindings, either because a resolved value on a bound property mismatched or because the StatVar's value on a bound property is present but could not be read (an unresolvable dcid); distinct from "no_matching_slice" (the combination was never published at all) and "variable_not_resolved" (no StatVar matched at all); "denominator_not_available" means the query asks for a normalised form (per person, per area, a rate or a share) or names a denominator, and the matched series is not in that form or divides by another base; "no_observations" means a StatVar WAS confirmed to exist but has no observation at the resolved entity (it exists, but not data here); "facet_not_available" means observations exist at the entity, none under the requested facet values; "role_incompatible" means the role is real, and the StatVar does not declare it; "role_signature_incompatible" means the resolved StatVars carry incompatible role signatures and no partition into candidates was possible; "source_code_not_held" means no variable held under the part's source_code by a source search serves can answer the part: no served source holds the code, the part's sources exclude every source that does, or the code's variables cannot answer the part as asked; "source_code_ambiguous" means two of the part's sources hold its source_code; "source_code_shares_variable" means the source_code's variables answer other codes of its source too, so search cannot serve the code alone; "qualifier_not_bound" means the variable resolved to a series family, but a narrowing term the request's text named bound no constraint slot: no code system in the packaged index carries it, or its registered rows landed in no binding
       */
      reason:
        | (
            | "source_not_resolved"
            | "source_ambiguous"
            | "source_code_not_held"
            | "source_code_ambiguous"
            | "source_code_shares_variable"
            | "entity_not_resolved"
            | "entity_ambiguous"
            | "entity_set_too_large"
            | "entity_role_not_admitted"
            | "variable_not_resolved"
            | "role_not_resolved"
            | "unit_not_resolved"
            | "rate_coverage_gap"
            | "no_matching_slice"
            | "binding_mismatch"
            | "denominator_not_available"
            | "no_observations"
            | "facet_not_available"
            | "role_incompatible"
            | "role_signature_incompatible"
            | "qualifier_not_bound"
          )
        | (string & {});
      /** @description why this refusal fired, present only for reason=rate_coverage_gap (the structured door's same-named ProblemDetails extension); omitted on every other reason */
      cause?: components["schemas"]["Cause"] | null;
      /**
       * Category
       * @description derived from reason, never independently settable: "entity_not_resolved", "entity_ambiguous", "entity_set_too_large", "entity_role_not_admitted", "variable_not_resolved", "role_not_resolved", "source_not_resolved", "source_ambiguous", "source_code_not_held", "source_code_ambiguous", "source_code_shares_variable", and "unit_not_resolved" are "unresolved" (the request could not be read into the graph); every other code is "absent" (the read request names a place holding nothing)
       * @default absent
       */
      category?: ("unresolved" | "absent") | (string & {});
      /**
       * Message
       * @description the plain-language sentence for reason, naming the query terms it concerns where the reason has them (the indicator, place, or category wording), so a client can show a person the reason beside its code. Every no_data part the engine returns sets it. Clients must not parse it
       */
      message?: string | null;
      /**
       * Nearest Real
       * @description optional; up to two real, grounded specs found by relaxing one constraint at a time and re-confirming against the live graph. Each carries its own relaxation naming the definition part relaxed and the value(s) it dropped. Shaped by response_options and banded by confidence like any returned spec. Distinct from flagged_match (the elected variable itself) and alternate_match (a different variable). nearest_real varies the SAME variable's own constraints, never the variable.
       */
      nearest_real?: components["schemas"]["NearestRealSpec"][] | null;
      /**
       * Gate
       * @description optional; the failed quality gate's code from the platform registry, one of the three registry gate codes (no_member_has_data_at_place, no_member_asserts_bound_properties, only_alternate_has_data). The single home for the code regardless of which near-match field carries the Spec: present exactly when flagged_match or alternate_match is present, except a role_incompatible refusal before or during materialise whose flagged_match records the confirmed elected identity without a gate (role incompatibility prevents an availability verdict), a qualifier_not_bound refusal, whose flagged_match records the graph-confirmed elected spec without a gate because the qualifier guard refuses before an availability verdict exists, or a denominator_not_available refusal, whose flagged_match records the elected spec the form or denominator check refused. Absent on every other no_data outcome. At most one of flagged_match and alternate_match is present at a time.
       */
      gate?:
        | (
            | (
                | "no_member_has_data_at_place"
                | "no_member_asserts_bound_properties"
                | "only_alternate_has_data"
              )
            | (string & {})
          )
        | null;
      /** @description optional; the elected variable's own Spec, present whenever gate fired and a groundable identity exists for the elected shape, or for a role_incompatible, qualifier_not_bound or denominator_not_available refusal that records its graph-confirmed identity without a gate: role incompatibility prevents an availability verdict, the qualifier guard refuses before one exists, and the denominator check refuses the series for its form, not its data. See gate for which check failed. available_at_place is False and confidence is low on gate=no_member_has_data_at_place; both stay at their not-assessed default (None) on gate=no_member_asserts_bound_properties, since there is no resolved place to be unavailable at. Absent on gate=only_alternate_has_data, where no groundable Spec for the elected shape exists; alternate_match carries the substitute the engine found instead. Distinct from nearest_real, up to two constraint-RELAXED specs that DO have data nearby. flagged_match is the elected variable itself, unavailable as the request asked for it. */
      flagged_match?: components["schemas"]["Spec"] | null;
      /** @description optional; a categorically different, data-bearing variable the request did not elect, present exactly when gate == 'only_alternate_has_data'. elected_count still counts the variable the request actually asked for; alternate_match is the one substitute the engine found nearby with observations of its own. Distinct from flagged_match (the elected variable itself, present on the other two gates) and from nearest_real (up to two constraint-relaxed variants of the SAME variable). alternate_match always names a different variable. */
      alternate_match?: components["schemas"]["Spec"] | null;
      /**
       * Elected Count
       * @description optional; how many StatVars the request actually elected. Present whenever the elected shape's variable identity was graph-confirmed, whatever no_data reason or gate the outcome ultimately carries. None when the outcome stops short of a graph-confirmed identity altogether (variable_not_resolved, role_not_resolved, role_signature_incompatible, and binding_mismatch all resolve no StatVar to count). Counts the SAME variable as flagged_match whenever flagged_match is present. On gate=only_alternate_has_data, where flagged_match is absent, elected_count still counts the variable the request elected, distinct from alternate_match's different variable.
       */
      elected_count?: number | null;
      /**
       * Entity Terms
       * @description the query entity text responsible for an entity-resolution outcome, in query order: every entity the engine could not resolve for entity_not_resolved, every ambiguous wording for entity_ambiguous, every resolved-but-unadmitted entity for entity_role_not_admitted, or every name whose flow direction the query leaves untold for role_not_resolved. Empty for every other no_data reason. This structured list is the client-facing source of those terms; rendered_sentence may quote the same wording for people, but clients must not parse it.
       */
      entity_terms?: string[];
      /**
       * Ambiguous Entities
       * @description every ambiguous wording responsible for an entity_ambiguous outcome, in query order, each paired with the graph candidates it could name. Empty for every other no_data reason. Invariant: every group's `text` equals some restatement.entities[i].text on the same part. Additive to entity_terms, which carries the same wordings as bare strings; rendered_sentence is unaffected by this field and quotes the same wordings and candidate names for people, but clients must not parse it.
       */
      ambiguous_entities?: components["schemas"]["AmbiguousEntityGroup"][];
      /**
       * Source Terms
       * @description the source wordings responsible for a source-resolution outcome, in query order: every included wording that matched no admitted source for source_not_resolved, every ambiguous wording for source_ambiguous, and the part's source_code for source_code_not_held, source_code_ambiguous and source_code_shares_variable. Empty for every other no_data reason. rendered_sentence may quote the same wording for people, but clients must not parse it.
       */
      source_terms?: string[];
      /**
       * Ambiguous Sources
       * @description every ambiguous source wording responsible for a source_ambiguous outcome, in query order, each paired with the admitted sources it could name, and for source_code_ambiguous the part's source_code paired with the provenances holding it. Empty for every other no_data reason. A client posts the matching entry of options.
       */
      ambiguous_sources?: components["schemas"]["AmbiguousSourceGroup"][];
      /**
       * Unit Alternatives
       * @description the currencies a unit_not_resolved outcome offers, in the binder's order: the candidate ISO codes for an ambiguous currency name with no declared alias (XOF, XAF and CHF for 'francs'), or the role shapes for a role-relative currency phrase beside entities on two roles. Absent on every other outcome, and on a unit_not_resolved outcome the binder offers no candidates for
       */
      unit_alternatives?: components["schemas"]["UnitAlternative"][] | null;
      /**
       * Unbound Qualifiers
       * @description the ResolvedQualifier entries responsible for a qualifier_not_bound outcome, in query order: every entry from flagged_match.resolved.trace.query_qualifiers whose disposition is not "bound" ("unbound": a named code row exists but no final binding covers it; "no_vocabulary": the text names no code at all), then, for a part naming or leaving out sources, each source it could not bind, an "unbound" entry under the source's label whose named holds the source's references. Empty for every other no_data reason. This structured list is the client-facing source of which terms went unrecognised, alongside each one's own disposition; rendered_sentence may quote the same wording for people, but clients must not parse it.
       */
      unbound_qualifiers?: components["schemas"]["ResolvedQualifier"][];
      /** @description the denominator the question named and the one the flagged match divides by, set on every denominator_not_available refusal the engine returns after electing a series; null for every other no_data reason. A client can offer the flagged match, or fetch its nearest_real level and the denominator asked and divide them */
      denominator?: components["schemas"]["NoDataDenominator"] | null;
      /**
       * Options
       * @description one ready request per choice of an entity_ambiguous, source_ambiguous, source_code_ambiguous, role_not_resolved or unit_not_resolved refusal, in query then candidate order. An entity option pins the candidate on every row with the ambiguous wording and every entity that resolved to one node; named groups, sets read as members and other ambiguous wordings stay unpinned, so a second ambiguity refuses again with the first pick kept. A candidate that is a group's own node, asked for its members, posts the group's registry name with no dcid, and has no option when no registry name resolves to the group alone. A source option sets the candidate's ref on the ambiguous mention; a source-code option names the holding provenance as the part's only included source. A role option states a direction for every name the question left unstated, so that every axis the shape declares a role on and the part does not ask open holds a place, offered while that gives at most six readings. A unit option names one of unit_alternatives in place of the ambiguous currency words. An option whose part breaks the ParsedPart bounds, or states a direction its own wording contradicts, is left out. Empty for other reasons; when the part's inputs exceed the ParsedPart bounds; on a role_not_resolved refusal with more than six readings, with no reading that leaves a place on every such axis, whose readings were all read with none holding data, or that the shape refused before placing names; and on a unit_not_resolved refusal without unit_alternatives
       */
      options?: components["schemas"]["NoDataOption"][];
    };
    /**
     * NoDataDenominator
     * @description The denominators a denominator_not_available refusal compared: the one the question
     *     named and the one its flagged match divides by -- NoData.denominator.
     */
    NoDataDenominator: {
      /** @description the denominator the question named, as the search read it from the bases the candidate series divide by; null when the question named none, or named one that no candidate series divides by */
      asked?: components["schemas"]["GraphRef"] | null;
      /** @description the denominator the flagged match divides by; null when it states none (a level such as an amount in US dollars, or a series whose name alone gives its base) */
      found?: components["schemas"]["GraphRef"] | null;
    };
    /**
     * NoDataOption
     * @description One answer to the choice a no_data refusal asks for: the words it settles, a label
     *     for people, and the request that settles them. It is one entry of NoData.options.
     */
    NoDataOption: {
      /**
       * Mentions
       * @description the request's own words this option settles, in query order: the ambiguous entity wording, the ambiguous source wording, the part's source_code, the part's unit_text, or for role_not_resolved every name whose direction the option states
       */
      mentions: string[];
      /**
       * Label
       * @description the choice in words for a menu: the candidate's display name, prefixed 'Excluding' for a source the part excludes; for role_not_resolved the direction the option reads, such as 'France to Germany' or 'To Kenya and Uganda'; for a role currency the role's currency, such as "recipient's currency". Clients must not parse it
       */
      label: string;
      /** @description a one-part parsed input settling this choice only. Post it unchanged as the input of /api/search/resolve; its one part is a dataset_resubmit parsed entry's part. A second ambiguous wording refuses again. Whether data exists for it is not checked */
      data_query: components["schemas"]["ParsedInput"];
    };
    /**
     * NoDataPart
     * @description Nothing could be returned for this part.
     */
    NoDataPart: {
      /**
       * Variable Text
       * @description the variable text this part answers, in the order asked. This part's position in Resolution.parts equals the same variable_index every SSE event keyed by variable_index uses (ShapeEvent, StepEvent, SentenceEvent). Every dataset_resubmit entry kind (identity, candidates, placeholder, and parsed through its nested ParsedPart) requires its own posted variable_text, so this field is always the posted text echoed back onto the rebuilt part, never null. Null only when the whole posted query was empty or whitespace-only (raw_text door), which refuses variable_not_resolved before extraction runs and so has no text to name.
       */
      variable_text?: string | null;
      /**
       * Separate
       * @description true when this part was asked beside the others to be compared with them. A client resubmitting an identity, candidate set, or placeholder posts this flag on that entry to preserve the comparison. Two parts marked separate that resolve to one reading carry the same spec_id and stay two parts. False, the default, is omitted
       * @default false
       */
      separate?: boolean;
      /**
       * Warnings
       * @description this part's own run-health signals. A part folded into an earlier part's spec (see DefinitePart.spec) carries binding_folded alone. The merged spec's own resolved warnings live only on the first part that carries it. An unfolded part carries the warnings raised while resolving this part, plus observations_omitted on a candidates part when response_options.include_observations was set.
       */
      warnings?: components["schemas"]["Warning"][];
      /** @description this part's own latency breakdown, where by_step names only the phases this part ran and total sums them, leaving out the shape_* stages nested inside shape. Excludes the shared, once-per-request steps (e.g. extract), which diagnostics.timing_ms.by_step carries once for the whole request; distinct too from diagnostics.timing_ms.total, the whole request's wall-clock elapsed time. */
      timing_ms?: components["schemas"]["Timing"] | null;
      /**
       * Rendered Sentence
       * @description a human-readable string. For candidates, a header naming how many readings there are ('3 readings.'), then each shown candidate's heading and a byline led by the source and span that set it apart; for no_data, a heading in the same claim form naming the entity, measure, and counterpart that were checked. Either ends with the text of this part's departures, in order, and a candidates part's then closes with its assumptions clause. For a definite part this stays null or omitted: the confirmation sentence (heading and byline) lives at spec.resolved.rendered_sentence, and its departures reach the envelope's composed sentence.
       */
      rendered_sentence?: string | null;
      /**
       * Sentence Plan
       * @description the ordered token form of rendered_sentence, present whenever it is. For a definite part this stays null or omitted. spec.resolved.sentence_plan carries the confirmation sentence's own plan instead.
       */
      sentence_plan?: components["schemas"]["SentenceToken"][] | null;
      /** @description the ParsedPart that reproduces this part's own resolution inputs -- the same entities, resolved time window, unit text, and source text the engine actually used to resolve this one leg -- so a client holding this part alone can copy it straight into a fresh ParsedInput.parts entry and re-resolve it faithfully, without flattening it into the whole query's variable_text the way variable_text alone would. Canonical, not verbatim: for a raw_text part, time_text is the equivalent phrase this door's own time grammar recognises (e.g. '2015 to 2020'), not the user's original words, since the engine's date extraction keeps only the structured window and discards the phrasing. Null whenever this part has no faithful echo to give. On a dataset_resubmit entry's identity/candidates/placeholder kinds, which post an identity or stub rather than a phrase and have no per-part resolution inputs to echo -- a dataset_resubmit parsed entry, genuinely re-resolved from its own posted ParsedPart, carries a real one like any parsed-door part. Also null when this leg's entity was bound to a directional role axis (origin/destination) and no door-supplied role named that axis, since an echo without the axis would resubmit the request with that entity reversed. Also null when one of this leg's own inputs does not fit ParsedPart's own field caps, since a truncated echo would misrepresent what was actually resolved. */
      restatement?: components["schemas"]["ParsedPart"] | null;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
      /**
       * Departures
       * @description every way this part's answer differs from what its request asked, ordered by how much each changes the number: closest_match, measure_not_applied, operation_not_applied, breakdown_not_applied, entity_unavailable, year_unavailable, modelled_values, group_read_as_members, direction_discarded, direction_inferred, scope_limited. [] when the answer is what was asked. A client that renders its own sentence reads them here; each one's text also closes the sentence that carries this part (see Departure.text). A warning on the same part reports run health and stays separate
       */
      departures?: components["schemas"]["Departure"][];
      /**
       * Assumptions
       * @description every value the engine filled that the request did not ask for, in clause order. Declared defaults come first, in the order of the Spec's trace.slot_filters, then open roles, then the place scope. A declared default is a slot the request left open that its code system's or shape's declared default fixed, named by the bound code's full label. An open role is a flow role no request word asked for, read across every entity on it with data. It is either a role the role scope default filled (resolved.scope on that axis), whatever its member count, served as one series per member where the shape declares the role, or a role the heading states with no entity of its own ('from 164 providers', 'owed to all creditors'), served as the total over its members. A role the identity binds in entities or lists in open_roles, that one of the part's operations runs over ('top 5 donors'), or that the request's words asked every member of ('all donors'), is asked. The place scope is a request that named no place, read across every place with data. Every door fills assumptions. A definite part reads them from its Spec, a candidates part carries the items every list in CandidatesPart.reading_assumptions holds alike, text included, and no_data and unsupported parts carry []. A dataset_resubmit identity entry posts every slot bound, so its part states the items of the entry's assumptions echo that still hold (see ResubmitIdentityEntry.assumptions), and a candidates entry reads each reading with its candidate's echo (see ResubmitCandidate.assumptions). The sentence that carries this part closes with them as one segment='assumption' clause ('Assumed: official development assistance; every provider.'), after its departures. [] when the answer fills nothing
       */
      assumptions?: components["schemas"]["Assumption"][];
      /**
       * @description nothing to return (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      status: "no_data";
      /** @description the reason */
      no_data: components["schemas"]["NoData"];
    };
    /**
     * GraphNodeRef
     * @description A graph reference. `label` is `null` when the target is not held, carries no `name`, or
     *     carries only a `name` equal to its own dcid.
     */
    NodeRef: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
    };
    /**
     * GraphNodesRequest
     * @description `dcids`: 1 to `NODES_MAX_DCIDS` node dcids read as one batch, in one DCP-read
     *     executor job. Each dcid matches the GET route's `{dcid}` path syntax and its 512-character
     *     ceiling.
     */
    NodesRequest: {
      /** Dcids */
      dcids: string[];
    };
    /**
     * NodesResponse
     * @description `nodes` is index-aligned with the request's `dcids`: a repeated dcid repeats its
     *     entry. Each entry is the body `GET /api/graph/node/{dcid}` returns for that dcid, or a
     *     `not_held` entry where that route answers 404.
     */
    NodesResponse: {
      /** Nodes */
      nodes: (
        | (
            | components["schemas"]["StatVarNode"]
            | components["schemas"]["CodeSystemNode"]
            | components["schemas"]["CodeNode"]
            | components["schemas"]["GroupNode"]
            | components["schemas"]["CountryNode"]
            | components["schemas"]["ContinentNode"]
            | components["schemas"]["SubregionNode"]
            | components["schemas"]["ContinentalUnionNode"]
            | components["schemas"]["PlaceOtherNode"]
            | components["schemas"]["OrganisationNode"]
            | components["schemas"]["AggregateNode"]
            | components["schemas"]["UnitNode"]
            | components["schemas"]["SourceNode"]
            | components["schemas"]["DatasetNode"]
            | components["schemas"]["ProvenanceNode"]
            | components["schemas"]["OtherNode"]
          )
        | components["schemas"]["NotHeldEntry"]
      )[];
    };
    /**
     * GraphNotHeldEntry
     * @description A batch entry for a dcid where `GET /api/graph/node/{dcid}` answers 404
     *     `node_not_held`.
     */
    NotHeldEntry: {
      /** Ref */
      ref: string;
      /**
       * Status
       * @default not_held
       * @constant
       */
      status: "not_held";
    };
    /**
     * ObservationPoint
     * @description One (date, value) pair from a resolved StatVar's observation series.
     */
    ObservationPoint: {
      /**
       * Date
       * @description the observation date, e.g. '2018'
       */
      date: string;
      /**
       * Value
       * @description the observed value; null when the graph reports a date with no value
       */
      value: number | null;
    };
    /**
     * ObservationSeries
     * @description One (stat_var, role tuple) pair's observation points, in chronological order.
     */
    ObservationSeries: {
      /** @description the StatVar these points observe */
      stat_var: components["schemas"]["SeriesStatVarRef"];
      /**
       * Entities
       * @description the role tuple this series observes -- one entry for a standard single-role series (role='observationAbout'), two for a dev-finance bilateral series (role='origin' and role='destination')
       */
      entities: components["schemas"]["SeriesEntityRef"][];
      /**
       * Axes
       * @description one entry per constraint the StatVar declares with a resolved value, ordered by property dcid; empty for a StatVar with no constraints. A client names each property from the Spec's slots
       */
      axes?: components["schemas"]["SeriesAxisRef"][];
      /**
       * Points
       * @description chronological observation points from the series' lead observation facet (see SpecObservations), plus the points of the same source's estimates continuing the series past the lead's last period when it has any -- the `modelled_values` departure marks those -- filtered to the spec's requested window when one exists; the full in-window series when SpecObservations.truncated is false, else at most the latest points (bounded by the server's preview-points setting and its per-series row limit)
       */
      points: components["schemas"]["ObservationPoint"][];
      /**
       * Total Obs
       * @description this series' SELECTED facet's in-window point count (before truncation) -- a per-series figure alongside SpecObservations.total_obs's aggregate across every series. For a scope-defaulted bulk latest-only series (no requested window), this is the coverage probe's all-time obs_count for that entity's selected facet -- the in-window count too, since no window narrows it
       */
      total_obs: number;
      /**
       * Source Refs
       * @description provenance of the lead observation facet these points were read from (the facet selected for this series -- see SpecObservations)
       */
      source_refs?: components["schemas"]["ProvenanceRef"][];
      /**
       * Facet
       * @description this series' lead observation facet, per axis (provenance/measurementMethod/unit); the estimates continuing the series keep the lead's entry; sparse -- an axis the facet carries no value for is absent, never a null placeholder. provenance here always agrees with source_refs, since both derive from the same lead facet
       */
      facet?: {
        [key: string]: components["schemas"]["SeriesFacetRef"];
      };
      /** @description what recipe and tables converted this series' points to the requested currency; absent on a series served in its native facet */
      conversion?: components["schemas"]["ObservationSeriesConversion"] | null;
    };
    /**
     * ObservationSeriesConversion
     * @description What produced a converted series' points: the recipe and table
     *     versions, and the fallback/projected markers a caller reads off them.
     *     Modelled on materialise.convert.ConversionRecord, whose own docstring
     *     this field's members mirror. Omits ConversionRecord.native_currency:
     *     a caller trusting or reproducing the number needs what recipe and
     *     tables produced it, not what currency it started from -- facet.unit
     *     already names the currency the points are actually in.
     */
    ObservationSeriesConversion: {
      /**
       * Recipe Id
       * @description the ConversionRecipe.recipe_id that produced these points
       */
      recipe_id: string;
      /** @description the Provenance node both the exchange-rate and (when present) deflator tables loaded under */
      table_provenance: components["schemas"]["SeriesFacetRef"];
      /**
       * Exchange Rate Table Version
       * @description the exchange-rate table's own version
       */
      exchange_rate_table_version: string;
      /**
       * Deflator Table Version
       * @description the deflator table's own version; absent for a current-prices conversion
       */
      deflator_table_version?: string | null;
      /**
       * Fallback Count
       * @description rows whose deflator-role entity was substituted with the recipe's fallback entity
       */
      fallback_count: number;
      /**
       * Fallback Examples
       * @description a capped, sorted sample of the substituted (entity, fallback_entity) pairs
       */
      fallback_examples?: components["schemas"]["SeriesConversionFallbackExample"][];
      /**
       * Projected Count
       * @description rows whose rate/deflator term was sourced from a projected table row
       */
      projected_count: number;
      /**
       * Projected Examples
       * @description a capped, sorted sample of the affected 'entity@year' keys
       */
      projected_examples?: string[];
    };
    /**
     * ObservationsOmission
     * @description Why a SpecObservations payload carries no series, made unconditional:
     *     every _fetch_observations call that reaches a "nothing to show" outcome
     *     sets this field instead of leaving the whole payload absent, so a client
     *     is never left guessing which of at least a dozen distinct causes
     *     produced an empty preview.
     *
     *     reason is a warning code from search.engine.region.codes (see
     *     ObservationsOmissionReason's own docstring for the closed vocabulary and
     *     why it is duplicated here rather than imported) -- the SAME code the
     *     accompanying Warning carries when one is also emitted, so a client reads
     *     one vocabulary rather than two. Not every reason accompanies a Warning:
     *     a genuinely uninteresting omission (nothing was ever there to probe)
     *     carries no diagnostic Warning of its own, but always carries this field.
     *
     *     The converse also holds, and the pairing is not exhaustive: a reason
     *     arriving as a bare Warning with `omitted` absent means partial coverage,
     *     not absence -- a fetch that delivered some series would never set this
     *     field, but can warn (`observations_probe_failed` on a partially hard-
     *     failed fetch, and `observations_timed_out` on one some of whose pairs
     *     crossed the deadline).
     *
     *     Whenever `omitted` is set, SpecObservations.series is `[]`, total_obs is
     *     `0`, and truncated is `false`, so a client reading `series ?? []` and
     *     ignoring `omitted` sees an ordinary empty result, with no schema_version
     *     bump needed to stay compatible.
     *
     *     pairs/cap: populated only for reason=="observations_preview_too_large" --
     *     the (stat_var, role_tuple) pair (or pair x elected-combination
     *     dispatch-item, or distinct-stat_var) count that was compared against the
     *     ceiling it crossed, and that ceiling itself. Lets a client render "this
     *     selection has {pairs} series, above the {cap} the preview fetches"
     *     without re-deriving either number.
     *
     *     dispatched: how many (stat_var, role_tuple) pairs this call actually
     *     dispatched. Populated for reason=="observations_no_points",
     *     "observations_probe_failed", "observations_no_matching_source", and
     *     "observations_timed_out" -- every reason a dispatch actually happened
     *     for; None for a reason reached before dispatch (e.g.
     *     "observations_nothing_to_probe").
     *
     *     empty: dispatched pairs that carried no data on their own facet.
     *     Populated only for reason=="observations_no_points".
     *
     *     hard_failed: dispatched pairs whose fetch itself failed. Populated for
     *     reason=="observations_no_points" (always 0 there -- a nonzero count
     *     means reason is "observations_probe_failed" instead) and for
     *     "observations_probe_failed" itself (the nonzero count that produced
     *     that reason); None elsewhere.
     *
     *     facet_rejected: dispatched pairs a bound facet_filter (or currency
     *     conversion) rejected. Populated for reason=="observations_no_points"
     *     (always 0 there -- a nonzero count means reason is
     *     "observations_no_matching_source" instead) and for
     *     "observations_no_matching_source" itself; None elsewhere.
     *
     *     Every field left None where the branch that produced this omission has
     *     no meaningful count for it.
     */
    ObservationsOmission: {
      /**
       * Reason
       * @description machine-readable cause, equal to the accompanying Warning's code when one fires
       */
      reason:
        | (
            | "observations_timed_out"
            | "observations_no_matching_source"
            | "observations_windowed_scope_unsupported"
            | "observations_converted_scope_unsupported"
            | "observations_no_dispatchable_facet"
            | "observations_bulk_fetch_failed"
            | "observations_probe_failed"
            | "observations_preview_too_large"
            | "observations_nothing_to_probe"
            | "observations_clients_unavailable"
            | "observations_no_points"
          )
        | (string & {});
      /**
       * Message
       * @description human-readable explanation, safe to render directly
       */
      message: string;
      /**
       * Pairs
       * @description observations_preview_too_large only: the count that was too large
       */
      pairs?: number | null;
      /**
       * Cap
       * @description observations_preview_too_large only: the ceiling it exceeded
       */
      cap?: number | null;
      /**
       * Dispatched
       * @description observations_no_points/observations_probe_failed/observations_no_matching_source/observations_timed_out: pairs actually dispatched
       */
      dispatched?: number | null;
      /**
       * Empty
       * @description observations_no_points only: dispatched pairs that carried no data on their own facet
       */
      empty?: number | null;
      /**
       * Hard Failed
       * @description observations_no_points (always 0) and observations_probe_failed: dispatched pairs whose fetch itself failed
       */
      hard_failed?: number | null;
      /**
       * Facet Rejected
       * @description observations_no_points (always 0) and observations_no_matching_source: dispatched pairs a bound facet_filter rejected
       */
      facet_rejected?: number | null;
    };
    /**
     * OpenAxisValueCount
     * @description One declared value on an open constraint axis and how many served members
     *     declare it (see OpenConstraintAxisFact.values).
     */
    OpenAxisValueCount: {
      /** @description the declared value */
      value: components["schemas"]["GraphRef"];
      /**
       * Count
       * @description how many distinct served members declare this value
       */
      count: number;
    };
    /**
     * OpenConstraintAxisFact
     * @description One constraint axis the query left open, and what this Spec's own
     *     served StatVar members exhibit on it (see ResolvedSpec.open_axis_facts):
     *     whether they agree on a single declared value or differ, what that
     *     agreed value is when one exists, how many distinct values the axis
     *     actually served, and how many declare none at all.
     */
    OpenConstraintAxisFact: {
      /**
       * Property
       * @description the constraint property dcid this fact is about
       */
      property: string;
      /**
       * Varies
       * @description False when every served member that declares a value for this axis declares the same one (including when none of them declare one at all, since declaring nothing is itself an agreeing value here, the same rule resolved.alternative_measures' own observed-partition read applies); True when they differ
       */
      varies: boolean;
      /** @description the single value every served member that declares one for this axis agrees on; present only when varies is False and at least one member declares a value, absent when varies is True or every member declares nothing */
      value?: components["schemas"]["GraphRef"] | null;
      /**
       * Distinct Count
       * @description how many distinct declared values the served members actually exhibit for this axis, not counting a member that declares nothing. 0 when every member declares nothing, 1 when varies is False and value is set. Counted over the served members' own declarations, independent of this response's observation window: a query's applied when-slot narrows which observation points are returned, not which constraint values a member declares, so this count is never scoped to that window the way an observation-count field on this contract is
       */
      distinct_count: number;
      /**
       * Undeclared Count
       * @description how many served members declare no value at all for this axis. A member whose arc names the axis but never resolved to a dcid counts here too, the same as a member that never asserted the axis at all
       */
      undeclared_count: number;
      /**
       * Values
       * @description every declared value with the number of served members declaring it, highest count first, then by dcid. Each served StatVar counts once, also after a merge of answers that serve it more than once, so the counts plus undeclared_count sum to the distinct served members. Labels as for value
       */
      values?: components["schemas"]["OpenAxisValueCount"][];
    };
    /**
     * Operation
     * @description One computation the question asks for over a part's data, which search
     *     does not perform: the part answers with the data the operation needs, and
     *     the operation rides on the part for a client to perform or hand on.
     */
    Operation: {
      /**
       * Verb
       * @description what the question asks to compute: rank, aggregate, growth, share_of, explain, forecast, or report
       */
      verb:
        | ("rank" | "aggregate" | "growth" | "share_of" | "explain" | "forecast" | "report")
        | (string & {});
      /**
       * Phrase
       * @description the query wording that asks for the operation, e.g. 'top 5 donors'; one line with no control characters or line separators, and not blank
       */
      phrase: string;
      /**
       * Over
       * @description the axis the operation runs across (place, origin, destination, category, or year); null when the verb names none, as explain does. The part leaves this axis open, so its data covers every value the operation needs
       */
      over?: (("place" | "origin" | "destination" | "category" | "year") | (string & {})) | null;
      /**
       * Target Year
       * @description the year a forecast projects to, e.g. 2050 for 'forecast aid to Ethiopia to 2050'; set only on a forecast, a four-digit year up to 2200. The raw_text door sets it only to a year after the current one, and leaves it null when the question names none; a posted value is taken as given within the bound, whatever today's date. It is kept apart from the part's time_text, the years whose data the part fetches, and does not affect resolution
       */
      target_year?: number | null;
    };
    /** OperationEnvelope */
    OperationEnvelope: {
      /**
       * Operation Id
       * @description `op_` plus the SHA-256 of the subject and its sorted member dcids, the origin catalogue build, and the rendering key. A repeat submission with the same identity joins the running operation and returns this id. Synchronous builds coalesce per API instance only.
       */
      operation_id: string;
      /** Status */
      status: ("pending" | "running" | "done" | "failed") | (string & {});
      /** Poll */
      poll?: string | null;
      /**
       * Retry After Ms
       * @description Milliseconds to wait before the next poll. Present on the 202 submit response and on every pending or running poll. Absent on a done poll. It grows as the build runs, at a quarter of the time since the operation's current submission, from 1,500 to 8,000. The `Retry-After` response header carries the same value in whole seconds, rounded up.
       */
      retry_after_ms?: number | null;
      progress?: components["schemas"]["OperationProgress"] | null;
    };
    /**
     * OperationProgress
     * @description `rows_written` against `estimate_rows`, read live off
     *     `datasets.operation` at poll time (`datasets_api.operation_store
     *     .Operation`). Present on a `pending`/`running` operation's own
     *     envelope; omitted from the `202` submit envelope (nothing has run
     *     yet) and from a terminal (`done`/`failed`) operation's own envelope,
     *     whose outcome the sibling `manifest` field, or the poll route's own
     *     `operation_failed` refusal, already carries in full.
     */
    OperationProgress: {
      /** Rows Written */
      rows_written: number;
      /** Estimate Rows */
      estimate_rows: number;
    };
    /**
     * OperationResource
     * @description `GET /api/datasets/operations/{operation_id}`'s poll response. The
     *     capability document reports `operation_envelope_active: true`, and this
     *     is the shape the route returns for a known operation id in `pending`,
     *     `running`, or `done` state. A `failed` operation raises the platform's
     *     ordinary refusal path instead (`operation_failed`), and an unknown or
     *     unauthorized-`done` id answers 404 `operation_not_found` -- neither
     *     returns this shape.
     *
     *     `manifest` is set only once `operation.status == "done"`: the same
     *     manifest a synchronous mint returns, read at poll time
     *     (`datasets_api.doors.meta`'s operations route reuses `datasets_api
     *     .doors.snapshot.read_snapshot_manifest` against the operation's own
     *     stored `subject_id`/`content_version`). `error` models a `failed`
     *     operation's outcome inline with this resource's own shape, but the
     *     door never populates it: a `failed` operation raises the platform's
     *     ordinary refusal path instead (`operation_failed`, a bare RFC 9457
     *     body, the same pattern `operation_not_found` already uses on this
     *     route -- see the registry's own `datasets.operations` mapping), so a
     *     poll never reaches this model at all once the underlying operation
     *     has failed. `error` stays declared for schema completeness -- this is
     *     a contract-stable, immutable-`$id` shape -- but no code path fills it.
     */
    OperationResource: {
      operation: components["schemas"]["OperationEnvelope"];
      /** Manifest */
      manifest?: {
        [key: string]: unknown;
      } | null;
      /** Error */
      error?: {
        [key: string]: unknown;
      } | null;
    };
    /**
     * OptionsEnvelope
     * @description `GET /api/datasets/{id}/options`'s response. It is the projection
     *     of a materialising door's manifest onto the fields this route's callers
     *     need (content_version, coverage, output_options, warnings, trace). The
     *     route serves with no rendering (`doors.definition._serve_spec_options`),
     *     so no reshape runs and `warnings` here excludes reshape-level warnings
     *     such as `enrichment_unavailable`.
     */
    OptionsEnvelope: {
      /**
       * Schema Version
       * @default 1
       */
      schema_version?: number;
      definition: components["schemas"]["DefinitionModel"];
      /** Content Version */
      content_version: string;
      coverage: components["schemas"]["CoverageModel"];
      output_options?: components["schemas"]["OutputOptionsModel"] | null;
      /** Warnings */
      warnings?: components["schemas"]["WarningModel"][];
      /** Trace */
      trace: {
        [key: string]: unknown;
      };
    };
    /**
     * OptionsFor
     * @description Which resolved entity role the options door enumerates candidates for.
     *
     *     Wrapped in its own object (rather than a bare string field) so the wire
     *     body reads `"for": {"role": "destination"}`, matching the contract's
     *     envelope shape on both the request and the echoed response.
     */
    OptionsFor: {
      /**
       * Role
       * @description the resolved entity role to enumerate candidates for (e.g. 'origin', 'destination', 'observationAbout' -- the vocabulary is derived per family, not frozen here). Deliberately a plain str, NEVER a Literal or enum: the target is checked only AFTER the posted identity resolves to StatVars, refusing option_target_invalid (422) for a role the resolved family does not carry. A Literal/enum would instead refuse an unrecognised role at the pydantic validation layer as request_invalid (400), before resolution ever runs -- do not tighten this to an enum.
       */
      role: string;
      /**
       * Scope
       * @description which candidate universe to enumerate for a role whose options are derived from the graph rather than a curated list; absent means 'peers'. 'peers' enumerates entities sharing the bound entity's own type; 'children' enumerates entities contained in it. Roles backed by a curated candidate list ignore this member, having only one universe to draw from. Naming a role alone cannot distinguish the two readings -- peers of a country and the regions within it are both 'options for observationAbout' -- and only the peers reading is recoverable from the identity, so without this member the contained-in reading is unreachable rather than merely unrequested.
       */
      scope?: (("peers" | "children") | (string & {})) | null;
    };
    /**
     * OptionsRequest
     * @description Request body for the options door (POST /api/search/options): enumerate
     *     the candidate set for one resolved entity role of a posted identity.
     *
     *     An identity block only. The door derives the identity's own StatVar
     *     population server-side (engine.options.population.options_population)
     *     rather than resolving a Spec through the resubmit path.
     *
     *     validate_by_name=False (with validate_by_alias=True, the pydantic default
     *     pairing made explicit here): the published schema declares only the alias
     *     `for`, and this model is otherwise extra="forbid", so a wire body must be
     *     rejected for posting the internal Python attribute name `for_` instead --
     *     accepting both would let a client bypass the declared schema through the
     *     implementation-detail spelling. `for_` exists only because `for` is a
     *     Python reserved word and cannot itself be an attribute name; every
     *     constructor call (internal code, tests) builds this model through the
     *     alias instead, e.g. ``OptionsRequest(identity=..., **{"for": OptionsFor(...)})``.
     */
    OptionsRequest: {
      /**
       * Schema Version
       * @description contract version the caller targets
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** @description the identity to resolve and enumerate candidate options for */
      identity: components["schemas"]["BaseIdentity"];
      /** @description which resolved entity role to enumerate candidate options for */
      for: components["schemas"]["OptionsFor"];
      /**
       * Include Coverage
       * @description when true, the engine probes each returned option for observation coverage (e.g. 'Kenya — 205 obs') and populates SlotOption.coverage; false (the default) never fires the extra probe, so this is opt-in latency, not a hidden cost on the hot path. The only resolution option this door reads -- unlike /resolve's ResolveOptions, this door has no candidate cap or sentence concept, so it carries this one field directly rather than nesting a response_options object with members it would never use.
       * @default false
       */
      include_coverage?: boolean;
    };
    /**
     * OptionsResponse
     * @description Response for POST /api/search/options: `{schema_version, diagnostics,
     *     for, options}`. Carries no semantic status: the door either refuses
     *     (through the same shared identity validation a dataset_resubmit identity
     *     entry runs) or returns options -- possibly an empty
     *     list -- with no definite/candidates/no_data three-way to report on top.
     *
     *     Omits graph_revision: no revision concept exists anywhere in src/ --
     *     nothing tracks the graph the way engine_build tracks the code build -- so
     *     stamping one here would assert a graph fact this deployment cannot back.
     *     Left out deliberately rather than filled with something untrue.
     */
    OptionsResponse: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** @description run health, warnings, timing, build stamp */
      diagnostics: components["schemas"]["Diagnostics"];
      /** @description the role this response's options were enumerated for, echoed back from the request */
      for: components["schemas"]["OptionsFor"];
      /** @description the enumerated candidate set */
      options: components["schemas"]["OptionsSet"];
    };
    /**
     * OptionsSet
     * @description The enumerated candidate set an options-door request returns.
     *
     *     Items reuse SlotOption for shape parity with slot_options/entity_options
     *     ({value, coverage}) rather than a simpler {ref, label, obs_count} shape --
     *     the richer coverage form is what the engine already serves. An
     *     empty list is itself a valid result (e.g. the current recipient's
     *     variable truly has no other recipient with data), not an error.
     *
     *     Carries no graph_revision -- see OptionsResponse's docstring for why.
     */
    OptionsSet: {
      /**
       * Items
       * @description candidate values, deterministically ordered; a dcid that failed to resolve a label is omitted rather than fabricated
       */
      items: components["schemas"]["SlotOption"][];
      /**
       * Truncated
       * @description true when items was capped before every candidate could be checked
       */
      truncated: boolean;
    };
    /** OrganisationNode */
    OrganisationNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "organisation";
      organisation: components["schemas"]["PartyBlock"];
    };
    /**
     * OtherNode
     * @description A node no other kind fits. `types` and `description` carry what the graph holds.
     */
    OtherNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "other";
    };
    /**
     * OutputOptionsModel
     * @description The reshape options this frame supports, joined from its stored
     *     `materialise.profile.OutputProfile` and the current capability
     *     document.
     */
    OutputOptionsModel: {
      /** Capability Version */
      capability_version: string;
      /** Columns */
      columns: components["schemas"]["ColumnOptionModel"][];
      /** Formats */
      formats: components["schemas"]["FormatOptionModel"][];
      bundle: components["schemas"]["BundleOptionModel"];
      /** Enrichments */
      enrichments: components["schemas"]["EnrichmentOptionModel"][];
      /**
       * Long Layout Defaults
       * @description the enrichment tokens a long-layout download writes with no columns option, in column order: every role's {role}_label, and {role}_party_kind for every role on a flow axis. Naming one in columns gives the same column once
       */
      long_layout_defaults: string[];
      /**
       * Long Layout Totals
       * @description the roles whose total rows ({role}_party_kind is total) a long-layout CSV or XLSX download keeps out of its main table. A role is listed when the definition binds it to several entities one of which the code index declares a total, or leaves it open and the code index lists a total on its axis in a dataset the definition read (any dataset, when the read selected none). A role bound to several parties holds no total row and is not listed. A bundle's CSV writes those rows to a second data file, data/<name>-totals.csv; an XLSX writes them on a second sheet, totals. A bare CSV has no README and drops them, so this list names the roles whose totals it drops. Parquet, a pivot and the frame layout keep every row. Empty when no role can hold a total row
       */
      long_layout_totals: string[];
      /** Pivots */
      pivots: components["schemas"]["PivotOptionModel"][];
      groupby: components["schemas"]["GroupbyOptionsModel"];
    };
    /**
     * ParsedEntity
     * @description One entity mentioned in a parsed part, with an optional caller-supplied role hint.
     */
    ParsedEntity: {
      /**
       * Text
       * @description the entity's text as the caller identified it
       */
      text: string;
      /**
       * Role Text
       * @description the caller's free-form role hint for this entity, when available; recognised words (case-insensitive) are 'from'/'to' and synonyms such as donor/provider/funder/source/creditor/lender/exporter for the 'from' side, recipient/beneficiary/debtor/borrower/importer for the 'to' side -- unrecognised text warns role_text_not_recognised and the entity is treated as undirected
       */
      role_text?: string | null;
      /**
       * Dcid
       * @description an optional caller-pinned dcid for this entity, naming exactly which graph node `text` refers to -- the door a client with a candidate's dcid in hand (e.g. from NoData.ambiguous_entities) posts through, instead of relying on name resolution to disambiguate `text` on its own. When present, this entity's name resolution is skipped: the pinned dcid seeds the entry's pre_resolved map directly, still confirmed against the graph. An unconfirmable dcid (absent from the graph, or present but type-less) refuses invalid_role_ref (422). `text` stays required and is not re-derived from the dcid; it is still what a rendered sentence and any further restatement echo back.
       */
      dcid?: string | null;
      /**
       * Members
       * @description true asks for the members of the set `text` names, each as its own series: the countries of a continent or UN subregion, or the members of a group. It has no effect on a single place. Text whose wording names members, such as 'EU member states', reads as true without the flag. With a pinned `dcid` it is honoured for a continent or subregion that the membership policy holds or omits, whatever the node's graph type, and refuses request_invalid for a group's own node, whose members a pin cannot supply. One part names a set once: the same `text` posted with both values refuses request_invalid
       */
      members?: boolean | null;
    };
    /**
     * ParsedInput
     * @description Pre-parsed input: one or more variable parts supplied directly by the caller,
     *     skipping natural-language extraction.
     */
    ParsedInput: {
      /**
       * @description discriminator for pre-parsed input (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "parsed";
      /**
       * Parts
       * @description one entry per variable ask; conjunctions pre-split by the caller. Parts that are byte-identical across every field collapse to one before resolution, so the response's own parts list can hold fewer entries than this list.
       */
      parts: components["schemas"]["ParsedPart"][];
      /**
       * Raw Query
       * @description original query text, for echo only; does not affect resolution
       */
      raw_query?: string | null;
    };
    /**
     * ParsedPart
     * @description One variable ask within a parsed request, with its own entities, time, unit, and source.
     */
    ParsedPart: {
      /**
       * Variable Text
       * @description the variable's text as the caller identified it
       */
      variable_text: string;
      /**
       * Entities
       * @description entities associated with this part's variable, when available; null, omitted, or an empty list all mean no entity was named for this part, resolving the variable globally/entity-less -- the same meaning a raw_text query with no extracted place carries
       */
      entities?: components["schemas"]["ParsedEntity"][] | null;
      /**
       * Time Text
       * @description this part's time expression, when available; recognised forms include a bare four-digit year, 'YYYY to YYYY' or 'YYYY-YYYY', 'from YYYY to YYYY', 'between YYYY and YYYY', a latest end as in 'between YYYY and the latest' or 'YYYY to latest', 'since YYYY', 'latest', 'latest year available', 'most recent', and 'last N years'. Anything else resolves dateless with a time_text_not_parsed warning, whose message lists every form
       */
      time_text?: string | null;
      /**
       * Unit Text
       * @description this part's requested unit or measurement basis, when available; recognised phrasing names a currency (ISO 4217 code or curated name/alias), a price basis (current or constant prices), and/or a base year (e.g. '2015 US dollars', 'constant prices, 2015 base year'). A phrase this text failed to parse cleanly resolves no_data with unit_not_resolved; a phrase the request grammar cannot express at all resolves unsupported with unit_request_unsupported. A phrase the grammar CAN express is checked against this deployment's own unit data: a currency/prices/base_year combination no unit this deployment carries expresses at all resolves unsupported with facet_binding_unsupported; one this deployment can express but that matches no candidate observation resolves no_data with facet_not_available; a match resolves definite, applying the completed request to the resolved spec's identity and carrying request_basis on resolved.facets.unit
       */
      unit_text?: string | null;
      /**
       * Sources
       * @description the data sources this part names or excludes, in query order. Empty, the part answers from the sources the engine elects. A restatement echoes each mention with the reference it resolved to
       */
      sources?: components["schemas"]["SourceMention"][];
      /**
       * Source Text
       * @description deprecated: post `sources` instead. Read as one included mention with this text, appended to `sources`
       */
      source_text?: string | null;
      /**
       * Provenance
       * @description deprecated: post `sources` instead. Read as one included mention with this ref, appended to `sources`. The served request schema lists the code index's declared datasets under this field, each with its label, description and opt-in flag
       */
      provenance?: string | null;
      /**
       * Source Code
       * @description a publisher's own series code for this part's variable, such as the World Bank's DT.TDS.DEGG.CD, when the user or a skill gives one. Compared upper-cased, it names the variables the publisher gives that code, and the part answers from them in place of matching variable_text; variable_text, entities and open_roles still choose among them. A code is never a constraint and narrows nothing else. A code whose variables cannot answer the part, because no source search serves holds it, the part's sources leave out every source holding it, or its variables cannot answer the part as asked, resolves no_data with source_code_not_held, its message naming the cause; a code two of the part's sources hold resolves no_data with source_code_ambiguous until `sources` names one; a code whose variable another code of its source also names resolves no_data with source_code_shares_variable, naming those codes
       */
      source_code?: string | null;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
      /**
       * Open Roles
       * @description the roles this part asks for member by member, at most one word per flow axis, e.g. ['creditor'] for 'debt service paid to each creditor'. Each is a role_text word: creditor, donor, recipient, debtor, origin, destination, or a synonym. Where the answer's family declares the role, the answer holds one series per member of it and its identity states the axis in open_roles; a role named in neither entities nor open_roles reads as the total over that role. An unrecognised word, or a role one of this part's entities binds through role_text, refuses request_invalid. An operation whose over is origin or destination opens that axis too
       */
      open_roles?: string[] | null;
      /**
       * Separate
       * @description true when this part is asked beside the others to be compared with them, as in 'health ODA versus education ODA': it answers as its own part and never folds into another part of the same shape (binding_folded). False, the default, folds parts that share a shape into one set answer. Two parts marked separate that resolve to one reading carry the same spec_id and stay two parts
       * @default false
       */
      separate?: boolean;
    };
    /**
     * GraphPartyBlock
     * @description An organisation's or aggregate's detail block.
     */
    PartyBlock: {
      /**
       * Roles
       * @description the role properties a node of these types can fill, by the role ranges the graph declares (rangeIncludes and its subClassOf closure); null when that read failed
       */
      roles: string[] | null;
    };
    /**
     * PeriodCoverage
     * @description How many entities one period's total covers.
     */
    PeriodCoverage: {
      /** Period */
      period: string;
      /** Entities */
      entities: number;
    };
    /** PinRequest */
    PinRequest: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /**
       * Artifact Digest
       * @description the exact bytes to pin, e.g. 'sha256:3e7a...'
       */
      artifact_digest: string;
    };
    /** PinResponse */
    PinResponse: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version?: 1;
      pinned: components["schemas"]["PinnedCoordinates"];
    };
    /** PinnedCoordinates */
    PinnedCoordinates: {
      /**
       * Id
       * @description the spec_id from the path
       */
      id: string;
      /** Content Version */
      content_version: string;
      /** Artifact Digest */
      artifact_digest: string;
      /** Pinned At */
      pinned_at: string;
    };
    /**
     * PivotOptionModel
     * @description One ordered `(index, columns)` pivot pair. `varying` is populated
     *     for a `pivot_not_unique` refusal caused by a duplicate key group. A
     *     stringification collision, where distinct `columns` values share an
     *     output column name, is also `unavailable` as `pivot_not_unique`, with
     *     no `varying` since no duplicate key group exists. `width` and `cells`
     *     are populated only when the pair is feasible.
     */
    PivotOptionModel: {
      /** Index */
      index: string;
      /** Columns */
      columns: string;
      /** State */
      state: string;
      /** Reason */
      reason?: string | null;
      /** Varying */
      varying?: components["schemas"]["VaryingColumnModel"][] | null;
      /** Width */
      width?: number | null;
      /** Cells */
      cells?: number | null;
      /** Unavailable Formats */
      unavailable_formats?: components["schemas"]["UnavailableFormatModel"][] | null;
    };
    /**
     * PivotOptions
     * @description `options.pivot`: long-to-wide, `index` and `columns` each naming
     *     exactly one column.
     */
    PivotOptions: {
      /** Index */
      index: string;
      /** Columns */
      columns: string;
    };
    /**
     * GraphPlaceBlock
     * @description A place's detail block. `membership` is set for a region the membership policy holds.
     */
    PlaceBlock: {
      /**
       * Contained In
       * @description the containedInPlace targets
       */
      contained_in: components["schemas"]["NodeRef"][];
      membership: components["schemas"]["MembershipBlock"] | null;
    };
    /**
     * PlaceCounts
     * @description What DFO holds at one country. For aid, `donors` counts the donors to
     *     the country and `recipients` the recipients of its own aid.
     */
    PlaceCounts: {
      /**
       * Publishers
       * @description distinct sources with data at the country
       */
      publishers: number;
      /**
       * Variables
       * @description distinct StatVars with data at the country
       */
      variables: number;
      aid: components["schemas"]["AidCounts"];
    };
    /** PlaceOtherNode */
    PlaceOtherNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "place_other";
      place_other: components["schemas"]["PlaceBlock"];
    };
    /**
     * GraphPriceBasis
     * @description Current or constant prices, with the base year of constant prices when known.
     */
    PriceBasisWords: {
      /** Prices */
      prices: ("current" | "constant") | (string & {});
      /** Base Year */
      base_year: number | null;
    };
    /**
     * Projection
     * @description A named cut of a membership by member class.
     */
    Projection:
      | ("countries" | "other_states" | "territories" | "former_states" | "institutions")
      | (string & {});
    /**
     * GraphProjectionCount
     * @description One projection of a membership and its member count at the block's date.
     */
    ProjectionCount: {
      projection: components["schemas"]["Projection"];
      /**
       * Count
       * @description members under the projection; null when the authority does not record it
       */
      count: number | null;
      /**
       * Complete
       * @description false when the authority does not record the projection, or is known to hold it only in part (`membership_incomplete`)
       */
      complete: boolean;
    };
    /**
     * ProvenanceEntry
     * @description One admitted provenance: its dcid and the provenance table's name for it.
     */
    ProvenanceEntry: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
    };
    /** ProvenanceNode */
    ProvenanceNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "provenance";
      provenance: components["schemas"]["SourceBlock"];
    };
    /**
     * ProvenanceRef
     * @description A provenance on the wire: its dcid and label, the source behind it, the
     *     Data Commons its data comes from, and the route of its document, which
     *     follows from the dcid. `label`, `source` and `data_commons` come from the
     *     origin catalogue's provenance table. A provenance the table does not list
     *     carries its graph label and neither `source` nor `data_commons`, and is
     *     omitted when the graph has no label for it.
     */
    ProvenanceRef: {
      /**
       * Ref
       * @description the graph identifier
       */
      ref: string;
      /**
       * Label
       * @description plain-language display name, read from the graph
       */
      label: string;
      /** @description the organisation behind the provenance */
      source?: components["schemas"]["SourceRef"] | null;
      /** @description the Data Commons the provenance's data comes from */
      data_commons?: components["schemas"]["search__models__grammar__DataCommonsRef"] | null;
      /**
       * Documentation
       * @description the Graph API route of the provenance's document, GET /api/graph/documentation/{dcid}
       */
      documentation?: string;
    };
    /** PublishFrameRequest */
    PublishFrameRequest: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /**
       * Spec Id
       * @description the derived frame's own op-spec hash id, ops_-prefixed
       */
      spec_id: string;
      /**
       * Content Version
       * @description the derived frame's own toolkit content version, ocv_-prefixed
       */
      content_version: string;
      /**
       * Role Keys
       * @description `dfo_frame_grammar.Frame.build`'s own `role_keys` argument; empty is a valid subject-only frame with no role columns, `build_frame` accepts it, so no minimum is imposed here. Bounded at 16 entries, each at most 1024 characters, a schema fact rather than a deployment ceiling -- see this module's own docstring
       */
      role_keys: string[];
      /**
       * Rows
       * @description `dfo_frame_grammar.Frame.build`'s own `rows` argument; empty is a valid frame (an analysis verb whose filter matches nothing produces exactly this), `build_frame` accepts it, so no minimum is imposed here. Each row is bounded at 22 keys; the outer list is bounded at 1000000 rows, a fixed schema backstop, well above doors.publish's own fixed PUBLISH_MAX_ROWS that actually governs `len(rows)` at publish time -- see this module's own docstring for why the two are not the same kind of cap. A cell is a scalar, or under `unit` alone a mapping of scalars bounded at 3 entries or a composed unit, `numerator` over `denominator`, each a unit ref, a mapping of scalars, or `{stat_var}` -- see this module's own docstring for the shapes refused at parse time
       */
      rows: {
        [key: string]:
          | {
              [key: string]:
                | string
                | {
                    [key: string]: string;
                  }
                | {
                    [key: string]: string | number | boolean | null;
                  };
            }
          | {
              [key: string]: string | number | boolean | null;
            }
          | (string | number | boolean | null);
      }[];
      /**
       * Input Content Versions
       * @description every input frame's own frame-grammar content_version this derived frame was computed from. Bounded at 256 entries, a schema fact rather than a deployment ceiling -- see this module's own docstring
       */
      input_content_versions: string[];
      /** @description the recipe that produced this frame. The door stores it beside the version, outside the body a republish is compared on, so a republish may add one to a frame published without it and may omit one the frame already holds */
      recipe?: components["schemas"]["Recipe"] | null;
      /**
       * Steps
       * @description the frame's step records, one per operation that computed it, in order, in the shape of dfo-spec-kit's step schema. `op` is any operation name. At most 62 steps and 65536 bytes of canonical JSON; step ids are distinct, an input that names a step names an earlier one, and only a `retrieve` step's `input` names a version, which at least one does. The versions `retrieve` steps name are the frame's root inputs, which `input_content_versions`, the immediate input frames, need not list. Absent when the publish carries none
       */
      steps?: components["schemas"]["Step"][] | null;
    };
    /** PublishFrameResponse */
    PublishFrameResponse: {
      /**
       * Schema Version
       * @default 1
       * @constant
       */
      schema_version?: 1;
      published: components["schemas"]["PublishedFrameCoordinates"];
    };
    /** PublishedFrameCoordinates */
    PublishedFrameCoordinates: {
      /** Spec Id */
      spec_id: string;
      /** Content Version */
      content_version: string;
      /** Artifact Digest */
      artifact_digest: string;
      /**
       * Created
       * @description true when this call newly recorded the version row; false when an identical publish of this exact pair had already been recorded (the idempotent replay path)
       */
      created: boolean;
    };
    /**
     * QueryEcho
     * @description What the response was understood to be answering.
     */
    QueryEcho: {
      /**
       * Entry Path
       * @description which input was used
       */
      entry_path: ("raw_text" | "parsed" | "dataset_resubmit") | (string & {});
      /**
       * Raw Query
       * @description the original query text, when one was supplied
       */
      raw_query?: string | null;
      /**
       * Normalized Query
       * @description normalised query text, when extraction ran
       */
      normalized_query?: string | null;
      /**
       * Extract Skipped
       * @description true when the extraction step was skipped for this request
       */
      extract_skipped: boolean;
    };
    /**
     * RawTextInput
     * @description Natural-language query input. The engine extracts, resolves, and grounds it.
     */
    RawTextInput: {
      /**
       * @description discriminator for natural-language query input (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "raw_text";
      /**
       * Query
       * @description the user's natural-language request
       */
      query: string;
    };
    /** Recipe */
    Recipe: {
      /**
       * Schema Version
       * @description recipe schema version; exactly 1
       * @constant
       */
      schema_version: 1;
      /**
       * Normal Form Hash
       * @description hash of the recipe's normal form, in which every derived input is replaced by its own recipe, every root by its dataset spec_id and rendering, and every literal a rolling overlay governs is dropped. Two frames replayed from one recipe on different data share it
       */
      normal_form_hash: string;
      /**
       * Replay Key
       * @description hash of the normal form hash, the root dataset pairs, and the execution identity. It names the one frame replayed from them
       */
      replay_key: string;
      /**
       * Execution Identity
       * @description the engine, grammar, and reduction versions that ran the recipe
       */
      execution_identity: string;
      /**
       * Tree
       * @description the op-spec tree, opaque here; analysis-mcp owns its shape
       */
      tree: {
        [key: string]: components["schemas"]["JsonValue"];
      };
      /**
       * Roots
       * @description how each root dataset was minted, opaque here; analysis-mcp owns its shape
       */
      roots: components["schemas"]["JsonValue"][];
      /** @description the rolling anchor, or null for a recipe with no rolling period */
      anchor?: components["schemas"]["RecipeAnchor"] | null;
    };
    /**
     * RecipeAnchor
     * @description The period a rolling recipe's `latest` resolved to, and the series it left out.
     */
    RecipeAnchor: {
      /**
       * Period
       * @description a period label at the frame's grain
       */
      period: string;
      /**
       * Rule
       * @description the anchor rule: the newest period at least half of the series hold
       * @constant
       */
      rule: "half1";
      /** Left Out */
      left_out: components["schemas"]["RecipeLeftOutSeries"][];
    };
    /**
     * RecipeLeftOutSeries
     * @description One series a rolling anchor left out: it holds no row at the anchor period.
     *
     *     `coordinates` must name the series, since a reader labels it from them: they hold
     *     `stat_var`, or at least one entity-role column, which is any column other than the frame
     *     grammar's fixed columns (`stat_var`, `time_period`, `value`, `unit`, `status`) and its
     *     facet identity columns (`measurementMethod`, `provenance`). Empty coordinates, and
     *     coordinates of only those other columns, are refused.
     */
    RecipeLeftOutSeries: {
      /**
       * Root
       * @description index of the population the series belongs to, in the order of the recipe's populations: one per root dataset
       */
      root: number;
      /**
       * Coordinates
       * @description the series' dimension values, column name to value. Holds `stat_var` or at least one entity-role column
       */
      coordinates: {
        [key: string]: string;
      };
      /**
       * Label
       * @description the series' display name. Optional: a reader of the recipe resolves the name from `coordinates` when it is absent
       */
      label?: string | null;
    };
    /** RecipeWriteResponse */
    RecipeWriteResponse: {
      /** Spec Id */
      spec_id: string;
      /** Content Version */
      content_version: string;
      /**
       * Created
       * @description true when this call stored the recipe; false when the frame already held a recipe with the same normal_form_hash and replay_key
       */
      created: boolean;
    };
    /**
     * RefreshFrameRequest
     * @description The frame to refresh. An `ops_` id is accepted by the grammar and refused
     *     `frame_not_refreshable`.
     */
    RefreshFrameRequest: {
      /** Spec Id */
      spec_id: string;
      /** Content Version */
      content_version: string;
    };
    /**
     * RegisterRequest
     * @description `POST /api/datasets/register`'s body: one canonical `definition`.
     *     `unsupported_schema_version` (the top-level `schema_version` field's own
     *     refusal) and any other shape failure surface through the platform's
     *     generic `RequestValidationError` handling.
     */
    RegisterRequest: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1
       * @constant
       */
      schema_version: 1;
      /** @description the canonical definition to register */
      definition: components["schemas"]["CanonicalDefinition"];
    };
    /**
     * RelatedMeasure
     * @description One other StatVar from the StatVarGroup this Spec's one StatVar belongs to (see
     *     ResolvedSpec.related_measures), with data at the Spec's places.
     *
     *     `definition` is minted from the member's own five-tuple and constraint values, with this
     *     Spec's entities and requested window and no facets, since a unit or source this Spec
     *     pins belongs to its own measure. Post `definition` back as `identity` on a
     *     dataset_resubmit identity entry to switch onto this measure.
     */
    RelatedMeasure: {
      /** @description the StatVar this measure reads, labelled with its graph name, or its dcid when it has none */
      stat_var: components["schemas"]["GraphRef"];
      /** @description the measure's own {schema_version, spec_id, identity} */
      definition: components["schemas"]["SpecDefinition"];
    };
    /**
     * Relaxation
     * @description Which definition part a nearest_real suggestion relaxed to find data.
     *
     *     Captured at the point a constraint binding is dropped and the resulting,
     *     widened request is re-confirmed against the live graph (see
     *     NearestRealSpec). Names the definition part relaxed (axis + the
     *     constraint property it carried) and the value(s) it dropped.
     */
    Relaxation: {
      /**
       * Axis
       * @description the slot axis whose binding was relaxed
       */
      axis: ("what" | "how" | "where" | "when" | "source") | (string & {});
      /**
       * Property Dcid
       * @description the constraint property dcid the relaxed slot carried, when one exists
       */
      property_dcid?: string | null;
      /**
       * Dropped Value Dcids
       * @description the taxonomy member dcid(s) the relaxed binding dropped
       */
      dropped_value_dcids: string[];
    };
    /**
     * ReleaseDocumentResponse
     * @description `GET /api/presentation/release`'s body. It carries the pinned
     *     catalogue release's own identity and the vocabulary a client needs
     *     to mount tools without a second, out-of-band fetch of the catalogue
     *     bundle.
     */
    ReleaseDocumentResponse: {
      /**
       * Catalog Version
       * @description the catalogue release this deployment serves
       */
      catalog_version: string;
      /**
       * Schema Version
       * @description the envelope schema version this release resolves against
       */
      schema_version: number;
      /**
       * Member Types
       * @description every component type this release's catalogue defines
       */
      member_types: string[];
      /**
       * Constraint Ids
       * @description every constraint id this release's registry enforces
       */
      constraint_ids: string[];
      /**
       * Retry Modes
       * @description `retry_modes` is the headline mode per code, and the per-response `retryable` boolean is the authoritative value for every code. `schema_invalid` and `frame_unavailable` vary by cause, and `request_invalid` is always false although its headline mode is `correct_and_retry`.
       */
      retry_modes: {
        [key: string]: string;
      };
      /**
       * Envelope Schema
       * @description the envelope JSON Schema this release's assembler validates a minted envelope against; every create/revise/read body's `resolved_payload` conforms to it
       */
      envelope_schema: {
        [key: string]: unknown;
      };
      /**
       * Component Schemas
       * @description each member type's own component JSON Schema, keyed by member type. `envelope_schema`'s `component` field `$ref`s these schemas by their own `$id`, which otherwise resolves nowhere, so a client validating `resolved_payload` resolves those `$ref`s against this map
       */
      component_schemas: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      /**
       * Intent Schemas Tolerant
       * @description each member type's own tolerant intent schema
       */
      intent_schemas_tolerant: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
      /**
       * Minimal Intents
       * @description each member type's own minimal legal intent
       */
      minimal_intents: {
        [key: string]: {
          [key: string]: unknown;
        };
      };
    };
    /**
     * ReleaseModel
     * @description One release of a source's DFO pipeline.
     */
    ReleaseModel: {
      /**
       * Date
       * @description the release date, YYYY-MM-DD
       */
      date: string;
      /**
       * Title
       * @description the release title, plain text
       */
      title: string;
      /** Changes */
      changes?: components["schemas"]["ChangeModel"][];
    };
    /**
     * RenderBody
     * @description The frame to draw the revision on.
     */
    RenderBody: {
      frame: components["schemas"]["RenderFrame"];
    };
    /** RenderFrame */
    RenderFrame: {
      /** Spec Id */
      spec_id: string;
      /** Content Version */
      content_version: string;
    };
    /** ReplayedFrameResponse */
    ReplayedFrameResponse: {
      /** Spec Id */
      spec_id: string;
      /** Content Version */
      content_version: string;
    };
    /**
     * Resolution
     * @description A resolve response that resolved the question into data: one part per
     *     variable asked, in query order, each a complete outcome carrying its own
     *     status and payload.
     *
     *     A single-variable query is one part, so `status` reads that one part's
     *     status directly. A query in which extraction found no variable is also
     *     one part, whose `variable_text` is the whole query text.
     *
     *     `status` below is a computed field that rides in every serialised
     *     response body without being a settable input, so this class stays a
     *     plain `BaseModel`, which allows unknown fields. `StrictModel` forbids them,
     *     which would make `Resolution.model_validate` reject its own `model_dump()`
     *     output, breaking every round-trip a client or this codebase does on a
     *     fetched response body. A posted `status` is ignored and recomputed.
     *
     *     Usage::
     *
     *         resp = RESOLVE_RESPONSE_ADAPTER.validate_python(obj)
     *         if resp.kind == "resolution":
     *             resp.status          # "definite" | "candidates" | "no_data" | "unsupported" | "mixed"
     *             resp.parts[0].status  # this part's own status
     */
    Resolution: {
      /**
       * Schema Version
       * @description contract schema version; exactly 1 for v1. Required on every response.
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /** @description what the response was understood to be answering */
      query_echo: components["schemas"]["QueryEcho"];
      /** @description run health, warnings, timing, build stamp */
      diagnostics: components["schemas"]["Diagnostics"];
      /**
       * @description discriminator for a response that resolved the question into data (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      kind: "resolution";
      /**
       * Parts
       * @description one entry per variable asked, in query order
       */
      parts: (
        | components["schemas"]["CandidatesPart"]
        | components["schemas"]["DefinitePart"]
        | components["schemas"]["NoDataPart"]
        | components["schemas"]["UnsupportedPart"]
        | UnknownPart
      )[];
      /**
       * Rendered Sentence
       * @description the envelope-level confirmation sentence describing the whole query, composed across every part's own sentence in query order. When every contributing part is definite, their headings join into one sentence. A qualifier axis (where, when, or source, each a wire value of axis, plus origin, identified by role=='origin' instead since SentenceAxis has no 'origin' member) whose bound value agrees across every contributing part is stated once after the joined phrases, a possessive lead every part shares opens the sentence once, and the byline follows once. A qualifier that differs stays inline in each part's own phrase. The response falls back to one sentence per part, each part's own text left exactly as that part rendered it, when a part is still resolving, when the parts' bylines differ, or when a differing qualifier's connective opens with a comma (a period range). A part still resolving contributes up to three tokens of its own: an optional prefix text token, its own variable_text as an editable slot, and a text token stating the outcome. A lone part that is not definite composes to exactly that part's own sentence. After the headings and bylines, each part's departures follow in part order as segment='departure' tokens carrying that part's part_index. This is the one sentence that writes out a definite part's departures. The parts' assumptions close the sentence as segment='assumption' tokens. A joined sentence takes one clause, each item carrying the part_index of its part and an item two parts share carrying none. A sentence written part by part takes each part's own clause after its departures. There, a part whose sentence and clause both repeat an earlier part's is stated once with it, that sentence and clause carrying no part_index, followed by each part's own departures, and a part whose clause differs keeps its own sentence. On a mixed resolution with at least one definite part, the sentence opens 'Answered N of M parts.', where N counts the definite parts, folded ones included, and M is len(parts).
       */
      rendered_sentence?: string | null;
      /**
       * Sentence Plan
       * @description the ordered token form of rendered_sentence, present under the same condition; null or omitted otherwise. Composed the same way rendered_sentence is, from every part's own sentence_plan -- see SentenceToken.part_index for how a client recovers which parts[i] each variable phrase and attached qualifier belongs to, and which tokens are shared skeleton (an inter-phrase connective, a hoisted shared qualifier, the terminal '.', or the shared ' ' the per-part fallback puts between two sentences) rather than any one part's own. On a mixed resolution with at least one definite part, the plan opens with two segment='coverage' tokens carrying no part_index, 'Answered N of M parts.' and ' '. A mixed resolution with no definite part has no opener.
       */
      sentence_plan?: components["schemas"]["SentenceToken"][] | null;
      /**
       * Skills
       * @description every skill named by any Spec.resolved.skills across this response's parts, keyed by id -- each id any Spec carries is a key here, and each key's front matter is carried once regardless of how many Specs name it. Present under response_options.include_skills; null when the option is off, {} when it is on and no Spec matched anything.
       */
      skills?: {
        [key: string]: components["schemas"]["Skill"];
      } | null;
      /**
       * Status
       * @description the parts' shared status when every part agrees, or 'mixed' when two or more parts differ; derived from parts, never independently settable
       */
      readonly status:
        ("definite" | "candidates" | "no_data" | "unsupported" | "mixed") | (string & {});
    };
    /**
     * ResolutionTrace
     * @description Consolidated record of how the query was understood.
     */
    ResolutionTrace: {
      /**
       * Resolved Entities
       * @description every entity
       */
      resolved_entities: components["schemas"]["GraphRef"][];
      /**
       * Resolved Sources
       * @description every dataset/source (a Data Commons provenance)
       */
      resolved_sources: components["schemas"]["ProvenanceRef"][];
      /**
       * Slot Filters
       * @description each applied bind decision, slot by slot
       */
      slot_filters: components["schemas"]["ResolvedFilter"][];
      /**
       * Query Qualifiers
       * @description each narrowing term the request's text named, and what became of it (see ResolvedQualifier). Defaulted empty: a dataset_resubmit identity entry carries no query text to re-derive this from, and every hand-built fixture and same-shape merge that predates this field still validates.
       */
      query_qualifiers?: components["schemas"]["ResolvedQualifier"][];
      /**
       * Requested Window
       * @description the date window originally requested (query intent), independent of coverage narrowing; None when no date was requested. The literal "latest" means the query explicitly asked for the most-recent/current value -- distinct from None (no date signal at all), since a resubmit of a "latest" spec must re-resolve to whatever year is CURRENTLY latest, not pin to the year this response happened to resolve. spec_id is anchored on this value, not on the served window, so identity stays stable across a resubmit even when coverage narrows the dates. Preserve the returned Spec.definition.identity when resubmitting; if editing it, carry this value at ResubmitIdentityPayload.identity.requested_window to keep that stability.
       */
      requested_window?: components["schemas"]["TimeWindow"] | "latest" | null;
      /**
       * Capability Version
       * @description the deployment capability version that produced this Spec, shared verbatim with GET /api/search/capabilities and every problem-details body's own capability_version. None only in hand-built fixtures that predate this field; every engine-produced Spec populates it.
       */
      capability_version?: string | null;
      /** @description what the default price-basis reading did before bind (see TraceDefaultReading); None when no bind ran for this Spec, as on a resubmit, or in hand-built fixtures that predate this field */
      default_reading?: components["schemas"]["TraceDefaultReading"] | null;
      /**
       * Stated Form
       * @description the normalised form the quantity read found in the question when no wording pattern named one ("debt to GDP" asks for a rate), and which the answer was then checked against; None when a wording pattern named the form, when the question asks for none, and when no bind ran for this Spec
       */
      stated_form?:
        (("per_person" | "per_head_base" | "per_area" | "rate" | "share") | (string & {})) | null;
      /** @description always absent: conversion is recorded per series in resolved.observations.series[].conversion (see TraceConversion) */
      conversion?: components["schemas"]["TraceConversion"] | null;
    };
    /**
     * ResolveOptions
     * @description Optional resolution parameters the caller may supply.
     */
    ResolveOptions: {
      /**
       * Include Option Coverage
       * @description when true, the engine probes each top-level interpretation and candidate Spec's slot_options for observation coverage (e.g. 'Kenya — 205 obs') and populates SlotOption.coverage; false/absent (the default) never fires the extra probes, so this is opt-in latency, not a hidden cost on the hot path. Delivery differs by transport, for every input kind: over SSE (Accept: text/event-stream), coverage arrives via trailing slot_options/entity_options events emitted after the response event, and the response event's own Spec.resolved.slot_options / entity_options stay coverage=null; on the buffered JSON body, coverage is embedded directly in the returned Spec. Spec.resolved.facet_options is computed whether or not this is set; over SSE with this set, it arrives in trailing facet_options events instead of the response event.
       */
      include_option_coverage?: boolean | null;
      /**
       * Include Observations
       * @description when true (the default is false -- absent also means false), the engine populates Spec.resolved.observations with the resolved answer's observation values: the full series when small enough, otherwise a bounded latest-points preview. This per-spec fetch runs only after the engine commits to a definite spec, including a promoted candidate; a multi-candidate response keeps per-candidate metadata and coverage without fetching observations. Delivery mirrors include_option_coverage's transport split: over SSE, observations arrive via a trailing observations event emitted after the response event, and the response event's own Spec.resolved.observations stays null or omitted; on the buffered JSON body, observations are embedded directly in the returned Spec.
       */
      include_observations?: boolean | null;
      /**
       * Include Skills
       * @description when true (the default is false -- absent also means false), the engine matches every resolved Spec's bound graph nodes (its shape's structural anchors and the dcids its bound constraint slots name) and its selected provenance (facets.provenance.ref, when one provenance serves every series) against the shared skills index and populates Spec.resolved.skills with the matching skill ids: skills matched through a graph node first, nearest-attachment-first, then skills matched only through the provenance, by id; [] when nothing matched. The response's own skills map then carries every named skill's front matter once, keyed by id. When the shared skills index has not yet built a first snapshot, the response carries the skills_index_unavailable diagnostics warning instead and no Spec gets a populated skills field; when a snapshot is available but its own build may have left out a published skill or served one excluded or understated (a read stopped at a budget or bound, the build's content budget ran out before a skill's turn, or a build step failed), the response instead carries the skills_index_incomplete diagnostics warning alongside whatever matches it did serve; a part with no resolved spec (no_data, unsupported) carries the part-scoped skills_not_matchable warning, since it binds no graph nodes to match against.
       */
      include_skills?: boolean | null;
    };
    /**
     * GraphResolveResponse
     * @description `results` is index-aligned with the request's `texts`.
     */
    ResolveResponse: {
      /** Results */
      results: components["schemas"]["ResolveResult"][];
    };
    /**
     * GraphResolveResult
     * @description One text's outcome. `input` echoes the text; fields a status does not use are `null`.
     *
     *     - `resolved`: `entity`, `matched` and `reading`. A group or region adds `projection`,
     *       `member_count` and `members`: the list route's link, or the members inline (at most
     *       256) when the request expanded them. The three are `null` for a region the membership
     *       policy does not hold.
     *     - `ambiguous`: `candidates`, in the resolver's order.
     *     - `not_found`: `near_matches`, hints for a person; a program should pick none by id.
     *     - `not_held`: `entity`, the id the resolver named, which does not open on the node route.
     *
     *     `reading` is `members` when the text names a group's members ("EU countries"), else
     *     `entity`.
     */
    ResolveResult: {
      /** Input */
      input: string;
      /** Status */
      status: ("resolved" | "ambiguous" | "not_found" | "not_held") | (string & {});
      entity: components["schemas"]["EntityRef"] | null;
      matched: components["schemas"]["Matched"] | null;
      /** Reading */
      reading: (("members" | "entity") | (string & {})) | null;
      projection: components["schemas"]["Projection"] | null;
      /** Member Count */
      member_count: number | null;
      /** Members */
      members: string | components["schemas"]["NodeRef"][] | null;
      /** Candidates */
      candidates: components["schemas"]["EntityRef"][] | null;
      /** Near Matches */
      near_matches: components["schemas"]["EntityRef"][] | null;
    };
    /**
     * ResolvedEntity
     * @description One resolved entity on the wire, under `resolved.entities`: the flat
     *     projection of the engine's own `Entity` -- `ref`/`entity_type` collapse from
     *     a `GraphRef` to a bare dcid/label pair, and `role` collapses from the
     *     engine's richer role model to the role-key string it already derives from
     *     (the identity core's own vocabulary, so this never adds a second mapping).
     */
    ResolvedEntity: {
      /**
       * Ref
       * @description the resolved entity's dcid
       */
      ref: string;
      /**
       * Label
       * @description plain-language display name
       */
      label?: string | null;
      /**
       * Entity Type
       * @description e.g. Country, AdministrativeArea1, Organization
       */
      entity_type?: string | null;
      /**
       * Role
       * @description the role key this entity plays; observationAbout, origin, or destination
       */
      role: ("observationAbout" | "origin" | "destination") | (string & {});
      /**
       * Confidence
       * @description the engine's confidence in this entity resolution; None when not assessed -- no entity-resolution confidence signal exists yet, so this ships None on every entity today
       */
      confidence?: (("high" | "medium" | "low") | (string & {})) | null;
    };
    /**
     * ResolvedFacet
     * @description One facet axis's resolved value on a Spec (see ResolvedSpec.facets):
     *     which value backed the answer's observations, and why.
     *
     *     basis is always present. ref/label are present when one distinct value
     *     served every carried series; selection carries "per_series" in their
     *     place when the carried series select different values on this axis --
     *     never alongside ref/label. request_basis joins either shape, present
     *     only on the unit axis, only when unit was bound through the request form
     *     (currency/prices/base_year), one basis value per member the request
     *     named.
     *
     *     Fields are flat and optional, validated by a model validator, rather
     *     than a discriminated ref/selection union. basis and request_basis are
     *     shared by both the single-ref and per-series shapes, so a union would
     *     duplicate them across arms for a mechanical gain (moving the
     *     ref/selection XOR to the type level) without expressing the
     *     request_basis-only-on-unit constraint, since that constraint is about
     *     which AXIS a ResolvedFacet lives under (see ResolvedSpec.facets), not
     *     its ref/selection shape. This is also response-only data, never
     *     deserialized from untrusted client bytes, so a runtime validator is
     *     the right tool for catching an illegal engine-side construction.
     */
    ResolvedFacet: {
      /**
       * Basis
       * @description 'bound' when this axis was constrained by the request, 'declared_default' when an unbound axis was completed from a declared deployment policy, 'fallback' when neither applies and the deployment policy supplied the value: facets holding a point in the requested years first, then DFO's facets for a variable both DFO and base Data Commons hold, then the most places or role tuples covered there, then the most requested years the span covers, then most observations, then the latest observation, then a deterministic tie-break
       */
      basis: ("bound" | "declared_default" | "fallback") | (string & {});
      /**
       * Ref
       * @description the axis's resolved dcid, present when one distinct value served every carried series; absent when selection is 'per_series'
       */
      ref?: string | null;
      /**
       * Label
       * @description best-effort display label for ref; present only alongside ref
       */
      label?: string | null;
      /**
       * Currency
       * @description unit axis only, alongside ref: the ISO 4217 code of the currency ref is denominated in, from the graph's currency units (CurrencyUSD, USDollar and the base Data Commons Currency members such as INR); absent when ref is no currency. The sentence reads it: US dollars go to the byline's unit token, any other currency stays in the heading
       */
      currency?: string | null;
      /** @description provenance axis only, alongside ref: the organisation behind the provenance, from the origin catalogue */
      source?: components["schemas"]["SourceRef"] | null;
      /** @description provenance axis only, alongside ref: the Data Commons the provenance's data comes from */
      data_commons?: components["schemas"]["search__models__grammar__DataCommonsRef"] | null;
      /**
       * Documentation
       * @description provenance axis only, alongside ref: the Graph API route of the provenance's document, GET /api/graph/documentation/{dcid}
       */
      documentation?: string | null;
      /** @description provenance axis only, alongside ref: whose account of a flow the provenance gives, when ref is a dataset the code index declares; 'provider' when it reports flows as their providers record them */
      account?: components["schemas"]["FlowAccount"] | null;
      /**
       * Selection
       * @description 'per_series' when the carried series select different values on this axis; present in place of ref/label, never alongside them
       */
      selection?: "per_series" | null;
      /**
       * Request Basis
       * @description per-member basis (currency/prices/base_year) for a unit axis bound through the request form; present only on the unit axis, alongside either ref/label or selection
       */
      request_basis?: {
        [key: string]: ("bound" | "declared_default" | "fallback") | (string & {});
      } | null;
    };
    /**
     * ResolvedFilter
     * @description One applied bind decision, slot by slot.
     */
    ResolvedFilter: {
      /** @description the slot identity */
      key: components["schemas"]["SlotKey"];
      /**
       * Binding Kind
       * @description which binding state was applied
       */
      binding_kind: ("value" | "set" | "unbound") | (string & {});
      /**
       * Refs
       * @description the bound graph objects (empty for unbound)
       */
      refs: components["schemas"]["GraphRef"][];
      /**
       * Provenance
       * @description whether the bind call's own election produced this value, a code row recognised in the query's own text forced it, or the measure-family election forced it on an axis the binder left open
       * @default binder
       */
      provenance?:
        ("binder" | "text_recognized" | "measure_elected" | "declared_default") | (string & {});
    };
    /**
     * ResolvedQualifier
     * @description One narrowing term the request's text named, and what became of it.
     *
     *     The term's text can come from the variable phrase, from the verbatim
     *     `query_text`, or from an admitted qualifier tie (see
     *     `_resolve_query_qualifiers`). `text` is the verbatim span of whichever
     *     source named it. `named` is every code row -- any system -- that span
     *     names in the packaged index;
     *     empty when the text names no code at all (a `no_vocabulary` term). `slot`
     *     is the constraint property dcid of the `slot_filters` entry whose
     *     binding consumed the term, or, on an `"unbound"` value the answer's shape
     *     has a slot for but leaves unmet, that slot's property; `None` otherwise.
     *     `disposition` is
     *     `"bound"` when some final binding on a named row's code system covers
     *     it (that row or a descendant), `"unbound"` when a row was named but no
     *     binding covers it, and `"no_vocabulary"` when the term names no code at
     *     all -- an LLM-reported phrase (`bind`'s own `unplaced` output) that no
     *     taxonomy in this deployment's index can express.
     *
     *     `start` and `end` locate the term in the part's variable phrase. `evidence` says what
     *     read it, and `None` means a code's label or synonym matched the term as the query
     *     spelled it, the reading every recognised span records:
     *
     *     - `"label"` and `"synonym"` name a match on a code's label or synonym; no record sets
     *       them, since a recognised span records `None`.
     *     - `"model"` marks a phrase the bind model read through a code it chose from the
     *       phrase's candidate menu, a lexical hit of the menu or a descendant of one
     *       (`phase_rank_bind._model_records`); `named` holds the chosen codes.
     *     - `"uncovered"` marks words no reader covers beside a recognised code
     *       (`phase_rank_bind._coverage_records`), recorded `"unbound"` with that code's rows as
     *       `named`.
     *     - `"unavailable"` marks a code term the elected shape cannot apply: one naming only
     *       codes no shape can bind, or, on a part naming a dataset, one no row of that dataset
     *       holds (`phase_rank_bind._unavailable_qualifiers`), recorded `"unbound"`.
     *     - `"unsupported"` marks an exclusion or comparison phrase no binding expresses
     *       (`phase_rank_bind._unsupported_records`), recorded `"no_vocabulary"`.
     *
     *     `operation` and `selected` describe how the term's codes combine with
     *     another term's on one code system, and the codes it asked for before that
     *     combination simplified.
     */
    ResolvedQualifier: {
      /**
       * Text
       * @description verbatim span of the source text that named the term: variable_text, query_text, or a dropped qualifier phrase
       */
      text: string;
      /**
       * Named
       * @description every code row the span names in the packaged index, any code system; empty when none did
       */
      named: components["schemas"]["GraphRef"][];
      /**
       * Slot
       * @description property dcid of the slot_filters entry whose binding consumed this term, or, on an unbound value the answer's shape has a slot for but leaves unmet, that slot's property; None otherwise
       */
      slot?: string | null;
      /**
       * Disposition
       * @description "bound" when a final binding covers a named row (or a descendant of one); "unbound" when a row was named but no binding covers it; "no_vocabulary" when the term names no code at all
       */
      disposition: ("bound" | "unbound" | "no_vocabulary") | (string & {});
      /**
       * Start
       * @description character offset where the term starts in the variable phrase
       */
      start?: number | null;
      /**
       * End
       * @description character offset where the term ends in the variable phrase
       */
      end?: number | null;
      /**
       * Evidence
       * @description what read the term: a code label or synonym, the bind model, "uncovered" for words no reader covers beside a recognised code, "unavailable" for a code no table holds, "unsupported" for a distinction no binding expresses
       */
      evidence?:
        | (
            | ("label" | "synonym" | "model" | "uncovered" | "unavailable" | "unsupported")
            | (string & {})
          )
        | null;
      /**
       * Operation
       * @description how the term's codes combine with another term's on one code system: a union of both, or a refinement to the narrower
       */
      operation?: (("union" | "refinement") | (string & {})) | null;
      /**
       * Selected
       * @description the codes the term asked for before the combination simplified them
       */
      selected?: components["schemas"]["GraphRef"][];
    };
    /**
     * ResolvedScope
     * @description The full member set of an entity axis this Spec's request left unnamed
     *     (see ResolvedSpec.scope).
     *
     *     ``axis`` is observationAbout when place defaulting expanded a place-less
     *     request, and origin or destination when directional-role defaulting
     *     expanded a role-bearing request. ``members`` lists the entities on that axis
     *     the answer's read plan serves, the ones a coverage breadth dimension for the
     *     same axis counts. members is the single-element ["Earth"] list when the query
     *     resolved as a worldwide total.
     *     The response-level diagnostics may include place_scope_defaulted or
     *     role_scope_defaulted for such resolution, but those warnings are not a
     *     per-Spec one-to-one representation of this field. The scope lives outside
     *     BaseIdentity, the spec hash, and resolved.entities: a resubmit of the
     *     same definition rediscovers it from the live graph.
     */
    ResolvedScope: {
      /**
       * Axis
       * @description the role-keyed axis the request left unnamed and the engine defaulted
       */
      axis: ("observationAbout" | "origin" | "destination") | (string & {});
      /**
       * Members
       * @description every entity on axis this Spec's read plan serves, sorted by ref; each carries role == axis and a best-effort label/entity_type from a batched graph read, None when the graph has neither
       */
      members: components["schemas"]["ResolvedEntity"][];
    };
    /**
     * ResolvedSpec
     * @description What the graph held at resolution time: the engine's report of what it
     *     did with the ask. Meant for display and diagnostics, never hashed;
     *     `Spec.spec_id` depends only on `Spec.definition.identity`. Beside the
     *     contract's own `resolved` member list (`stat_vars`, `inapplicable_slots`,
     *     `unresolved_slots`, `entities`, `coverage`, `headline`, `facets`, `observations`,
     *     `rendered_sentence`/`sentence_plan`, `slot_options`/`entity_options`,
     *     `trace`, `confidence`), this also carries the engine's own supersets
     *     (`shape`, `slots`, `available_at_place`) that slot_options/sentence_plan
     *     join against and the eval harness scores.
     */
    ResolvedSpec: {
      /** @description the structural family chosen */
      shape: components["schemas"]["Shape"];
      /**
       * Slots
       * @description one entry per slot the shape defines, each in a binding state
       */
      slots: components["schemas"]["Slot"][];
      /**
       * Inapplicable Slots
       * @description the slots whose property none of the resolved StatVars declares, listed by property dcid; empty when every slot applies. Joins to resolved.slots[*].key.property.ref. Applicability is graph state, so it is reported here and the slot itself reads 'unbound' in the definition either way. It is never a member of BaseIdentity, never hashed.
       */
      inapplicable_slots?: string[];
      /**
       * Unresolved Slots
       * @description the slots whose property is present but unresolved on at least one resolved StatVar (the graph asserted a value for this axis but could not resolve it to a dcid), listed by property dcid; empty when no such slot exists. Joins to resolved.slots[*].key.property.ref, and is disjoint from inapplicable_slots: a property is either never asserted by any resolved StatVar (inapplicable_slots), present but unreadable on one (this field), or neither (a genuinely open axis). The slot itself reads 'unbound' in the definition in every one of these cases; it is never a member of BaseIdentity, never hashed.
       */
      unresolved_slots?: string[];
      /** @description resolved StatVar(s) inside the region, and the scope they were drawn from */
      stat_vars: components["schemas"]["ResolvedStatVars"];
      /**
       * Entities
       * @description resolved entities the data is about; may be empty if where is unbound
       */
      entities: components["schemas"]["ResolvedEntity"][];
      /**
       * Entity Groups
       * @description the named group each role's entities stand for, keyed by the role key the entities above carry: each group whose members are exactly the entities definition.identity binds on that role. The heading names a role by its group and member count ('the 27 EU member states') in place of its members. None when no role was asked for as a group
       */
      entity_groups?: {
        [key: string]: components["schemas"]["EntityGroup"];
      } | null;
      /**
       * Coverage
       * @description observation footprint
       */
      coverage:
        | components["schemas"]["CoverageExact"]
        | components["schemas"]["CoverageBreadth"]
        | components["schemas"]["CoverageBare"];
      /** @description exact latest-year summary for a role-bearing answer (see Headline); None for a non-role-bearing Spec, which coverage above already answers exactly or approximately enough that no separate latest-year summary is computed */
      headline?: components["schemas"]["Headline"] | null;
      /** @description the rows, series, years and licence of the file a mint of this Spec writes (see DownloadFacts). None when the Spec has no read plan: a no-data answer, or same-shape parts merged into one Spec */
      download?: components["schemas"]["DownloadFacts"] | null;
      /**
       * Coverage Stamp
       * @description the coverage artifact's own data-version stamp this Spec's role-bearing population and headline were confirmed against (series_coverage.CoverageManifest.stamp); None for a non-role-bearing Spec, which never consults coverage. The graph-derived analogue of this stamp (graph_generation) is not itself a wire field; this is coverage's own, published because coverage is a second, independently-versioned data source an answer can be stale against
       */
      coverage_stamp?: string | null;
      /** @description the full member set of an entity axis this Spec's resolution defaulted (see ResolvedScope): observationAbout for place defaulting, or origin/destination for directional-role defaulting. Response-level diagnostics may carry place_scope_defaulted or role_scope_defaulted, but warning presence is not an exact per-Spec equivalence; None when this Spec did not default an entity axis */
      scope?: components["schemas"]["ResolvedScope"] | null;
      /**
       * Facets
       * @description the facet axis values of the series this Spec's read plan serves, the series its observations carry (see ResolvedFacet); the same whether or not observations are included or deferred to a trailing SSE event. Sparse, meaning an axis no served series carries is omitted, never a null placeholder. {} when the Spec serves no series
       */
      facets?: {
        [key: string]: components["schemas"]["ResolvedFacet"];
      };
      /** @description the observation values behind coverage above; None when not resolved for this Spec (e.g. no entity to probe, or response_options.include_observations is false), when ResolveOptions.include_observations opts into deferred SSE delivery (populated instead via a trailing observations event, mirroring slot_options/entity_options' own coverage-probe transport split), or for a candidates-status entry, nearest_real, or flagged_match spec (this iteration only populates it on a primary definite answer). */
      observations?: components["schemas"]["SpecObservations"] | null;
      /**
       * Slot Options
       * @description the candidate set each bound slot was chosen from, one entry per slot with a non-empty taxonomy; omits when/source and any slot with no observed or seeded values. spec_id does not depend on this field, so it never affects permalinks or dedup.
       */
      slot_options?: components["schemas"]["SlotOptions"][];
      /**
       * Entity Options
       * @description candidate sets for directional origin or destination axes. An entry whose entity_ref is omitted describes an axis the role-bearing query left open; its role selects the identity.entities key for a resubmit, and the matching role_axis_facts entry reports that axis's member count. An entry with an entity_ref describes alternatives to a bound axis. Empty when the family has no directional entity-option concept. spec_id does not depend on this field.
       */
      entity_options?: components["schemas"]["EntityOptions"][];
      /**
       * Facet Options
       * @description the candidate set each facet axis (provenance/measurementMethod/unit) was chosen from, one entry per axis with at least one value observed on the resolved candidates' unfiltered facets; an axis with no observed value is omitted, never an empty entry. Computed for every definite Spec and every candidate. Over SSE with response_options.include_option_coverage set, the entries arrive as trailing facet_options events and this list stays empty. Unlike slot_options, this has no bind-time baseline to fall back to. spec_id does not depend on this field.
       */
      facet_options?: components["schemas"]["FacetOptions"][];
      /**
       * Rendered Sentence
       * @description the editable confirmation sentence for this spec, present on every Spec a part shows; None on an equivalent_readings entry. It holds the heading and the byline only (see SentenceToken.segment): 'Germany's gross ODA disbursements to Kenya, 1973 to 2024. Current US dollars · OECD Creditor Reporting System (CRS).' It states what this Spec is and nothing about the request that produced it, so it reads the same after a dataset_resubmit and serves as the Spec's label. The part that carries this Spec states how it departs from the request (_PartBase.departures)
       */
      rendered_sentence?: string | null;
      /**
       * Sentence Plan
       * @description the ordered token form of rendered_sentence, tying its tokens to definition parts; present under the same condition, None otherwise. Every token's segment is 'heading' or 'byline'
       */
      sentence_plan?: components["schemas"]["SentenceToken"][] | null;
      /** @description consolidated record of how the query was understood */
      trace: components["schemas"]["ResolutionTrace"];
      /**
       * Confidence
       * @description qualitative, relative retrieval confidence for this interpretation; None when not assessed. Bands are heuristic and may be retuned without a schema-version bump.
       */
      confidence?: (("high" | "medium" | "low") | (string & {})) | null;
      /**
       * Basis
       * @description why the part offers this Spec as one of its candidates: 'structural', a reading that differs from the elected one only on a stat type, price basis or denominator the request leaves open; 'nominated', a reading the model named as a genuine reading of the request's phrase; 'twin', an equivalent reading of the elected one, offered where the elected one holds no data; 'direction', the same reading with the other direction for a place the request names without one, which a client shows as a direction prompt. The elected reading, listed first, carries none. None on a definite answer and on every Spec outside CandidateSet.specs.
       */
      basis?: (("structural" | "nominated" | "twin" | "direction") | (string & {})) | null;
      /**
       * Available At Place
       * @description whether this spec has lifetime availability at the resolved place, independent of the coverage window. True = confirmed at place; False = the variable matched but has no observation here (the flagged_match case); None = not assessed (no place entity, or a named family such as dev-finance). CoverageExact.has_data may be False for a requested window even when this field is True.
       */
      available_at_place?: boolean | null;
      /**
       * Equivalent Readings
       * @description other StatVar(s) confirmed to encode the same real-world indicator as this Spec. Each entry is a full Spec carrying identity and the material needed to re-resolve onto it: its definition.identity, spec_id, and resolved StatVar dcids provide everything ResubmitIdentityPayload requires. Its rendered_sentence, sentence_plan, facet_options, and observations come from re-resolving onto it on a dataset_resubmit identity entry, not from this response. This Spec's own answer stands on its own regardless. Switching to a named entry is optional, offered for its source vocabulary's own coverage. None when no such encoding is known. Never a member of BaseIdentity, never hashed, and never populated on its own entries in turn. An entry's own equivalent_readings is always empty.
       */
      equivalent_readings?: components["schemas"]["Spec"][] | null;
      /**
       * Skills
       * @description ids of the skills this Spec's bound graph nodes and selected provenance call for, matched against the shared skills index, most specific first: skills matched through a graph node by hop, then breadth, and skills matched only through the provenance last; present under the include_skills option. None = the request did not ask; [] = it asked and nothing matched.
       */
      skills?: string[] | null;
      /**
       * Alternative Measures
       * @description every other measure this Spec could equally answer with -- either another populated partition from the same family as the one this Spec's own served rows exhibit (retrieval.bound_values.observed_measure_family), or a genuinely distinct also_plausible candidate whose only difference from this Spec is measured_property (measurement_denominator held equal), folded in here instead of left as a second candidates entry -- each with its own identity, a disambiguating label, and the axis of the sentence token whose menu offers it: 'what' entries are the measure switch beside measure_label below, 'unit' entries the price-basis options of the byline's unit token (binding_ref 'unit:'). A partition or folded candidate with no authored label is left out. None when this Spec's shape carries no measure family at all and no measure-sibling candidate was folded in, or its served rows span more than one partition; a served partition with every sibling unlabelled, or with none, still publishes []. Never a member of BaseIdentity, never hashed.
       */
      alternative_measures?: components["schemas"]["SpecAlternativeMeasure"][] | null;
      /**
       * Measure Label
       * @description the readable label for the measure partition this Spec's own served rows exhibit, composed the same way as each 'what' alternative_measures entry's label: what a switch built from those entries would show as currently selected. It names no price basis ('gross disbursements', not 'gross disbursements (nominal)'). Current or constant prices belong to the unit, which the byline's unit token states. None under the same condition alternative_measures is None
       */
      measure_label?: string | null;
      /**
       * Measure Label Axes
       * @description the declared measure-axis identifiers (code_index.types.MeasureAxis.axis, e.g. 'measuredProperty', 'measurementQualifier', or a constraint-property dcid such as a financial-flow-type or netting-basis axis) that measure_label was composed from. Every axis the served partition carries a value on is included here, whether or not its value appears in measure_label's own text. A renderer uses this to keep a bound how-slot sharing one of these property dcids from repeating what measure_label already said. Always [] when measure_label is None.
       */
      measure_label_axes?: string[];
      /**
       * Measure Axis Values
       * @description each axis in measure_label_axes with the value the served partition holds on it, in the same order, including values the query never named (a declared default such as Gross or Nominal). Labels come from the measure index. Always [] when measure_label is None. Never a member of BaseIdentity, never hashed.
       */
      measure_axis_values?: components["schemas"]["MeasureAxisValue"][];
      /** @description the StatVarGroup related_measures come from: the smallest group this Spec's one StatVar belongs to that holds 2 to 40 members, ties broken by group dcid. None when related_measures is None or [] */
      related_group?: components["schemas"]["GraphRef"] | null;
      /**
       * Related Measures
       * @description up to 5 other members of related_group with data at every place this Spec names (and in its requested years when it names a range), ordered by the years they share with this Spec's StatVar there, then by dcid. Only a definite Spec that serves exactly one StatVar, has no measure family (measure_label is None) and names places with no roles carries a list; [] when no group qualifies or no other member has data there. None for any other Spec, and when the graph reads failed or ran past their deadline. Never a member of BaseIdentity, never hashed.
       */
      related_measures?: components["schemas"]["RelatedMeasure"][] | null;
      /**
       * Open Axis Facts
       * @description one entry per constraint axis this Spec's own served StatVar members declare (an arc naming the property, resolved or not) that the query left unbound, each naming the axis's property and what those members exhibit on it: whether they agree on a value (varies=False) or differ (varies=True), and undeclared_count for how many declare none at all. None when this Spec's served members declare no constraint property the query left open at all. This is distinct from an open axis every member declares nothing for, which still publishes its own entry (varies=False, undeclared_count equal to the served member count). Never a member of BaseIdentity, never hashed.
       */
      open_axis_facts?: components["schemas"]["OpenConstraintAxisFact"][] | null;
      /**
       * Role Axis Facts
       * @description one entry per directional role axis (origin/destination) this role-bearing Spec's query left open, naming the axis and the member population its own confirmation already resolved (see RoleAxisFact). None when this Spec is not role-bearing, or is role-bearing but every role axis its shape declares carries a bound entity. Never a member of BaseIdentity, never hashed.
       */
      role_axis_facts?: components["schemas"]["RoleAxisFact"][] | null;
      /** @description the currencies and price bases a unit request can convert this answer to. Null when the served members' unit is no currency, no conversion recipe converts them (a stock, a series not in nominal prices, or a provenance that declares no recipe), the recipe's tables lack the native currency's rate in a served year, so nothing converts, or no conversion catalogue is loaded, which the part's unit_conversion_unavailable warning states. Never a member of BaseIdentity, never hashed. */
      unit_conversion?: components["schemas"]["UnitConversion"] | null;
    };
    /**
     * ResolvedStatVars
     * @description `resolved.stat_vars` on the wire: how many StatVars the answer holds, how many a
     *     Datasets mint of the Spec's definition serves, and the dates the answer serves over
     *     them. The members themselves stay off the wire; `POST /api/datasets/{id}/members`
     *     lists the ones a mint serves.
     *
     *     member_count is the population confirmed to carry observations at this
     *     resolve's own probe entities, not resolved.shape.member_count's
     *     bindings-admitted population. The two differ for two reasons. A member the
     *     shape's bindings admit can carry no observation at the resolved place. And on
     *     a role-bearing shape the answer reads one role class of the admitted members:
     *     where a total stands for its breakdowns the breakdowns are folded into it, so a
     *     donor-only answer can state 255 admitted members beside 1 confirmed while every
     *     one of the 255 holds data. On a standard (non-role-bearing) shape this population can itself
     *     be a floor: the packaged code index does not source members for every
     *     shape family, so a shape outside it falls back to its recall sample, the
     *     members recall found, and member_count cannot exceed what that sample
     *     admitted. An answer naming one member of a family too large for one read stops
     *     reading once that member is confirmed, so member_count counts the members read: "latest
     *     life expectancy data" reads the family's total and not its other 350 members. A
     *     where-axis merge (same_shape.py, "population
     *     of Kenya and Uganda") publishes max() of its members' own member_count
     *     rather than the sum, since the same StatVar is typically confirmed at
     *     every member's own place and summing would double-count the
     *     intersection -- max() is a true lower bound of the union. member_count_exact
     *     records which of these applies.
     *
     *     served_count is the mint's own count, a function of the definition alone: the
     *     StatVars a Datasets mint of `definition` serves, the length of its
     *     `trace.resolved_stat_vars`. It is stated whenever Search settled the membership the
     *     mint resolves: a family the code index decides, or a family the mint's member walk
     *     settled for this definition. Null when Search answers from members it could not
     *     settle, which the part flags with a `membership_unverified` warning.
     */
    ResolvedStatVars: {
      /**
       * Member Count
       * @description how many members are confirmed to carry observations at this resolve's own probe entities; see this model's own docstring for how this differs from resolved.shape.member_count
       */
      member_count: number;
      /**
       * Member Count Exact
       * @description True when member_count is a true total; False when it is a floor -- the population being at least member_count large, not exactly member_count -- because it was measured over a capped recall sample, because the probe stopped once the answer's member was confirmed, or because it is a where-axis merge's max() of its members' own counts rather than a computed union. Defaults to True, correct for a caller that has not measured otherwise
       * @default true
       */
      member_count_exact?: boolean;
      /**
       * Served Count
       * @description how many StatVars a Datasets mint of this Spec's definition serves, the length of its trace.resolved_stat_vars; 1 for a single series. Null when the membership is unsettled: Search answered from members the mint may not serve, and the part carries membership_unverified
       */
      served_count?: number | null;
      /** @description the earliest first date and latest last date of the points the answer's read plan serves over its StatVars; null when it serves none */
      data_date_range?: components["schemas"]["DateRange"] | null;
      /**
       * Source Codes
       * @description the publisher series codes of the StatVars the answer serves, sorted by provenance then code and without repeats; left out when no served StatVar has a code. They identify the series a publisher files these StatVars under, and the answer is the same with or without them. A code names the whole answer only where its entry is exact
       */
      source_codes?: components["schemas"]["SourceCode"][];
    };
    /**
     * ResubmitCandidate
     * @description One candidate identity within a `candidates` dataset_resubmit entry. The
     *     engine derives its StatVar members as it does for an identity entry.
     */
    ResubmitCandidate: {
      /** @description this candidate's complete identity */
      identity: components["schemas"]["BaseIdentity"];
      /**
       * Entity Groups
       * @description the named group each role's entities were asked for as, keyed by entity role key. Post a prior Spec's resolved.entity_groups beside any identity derived from that Spec. A group is kept when it posts a dcid and the graph's members of that node are exactly the identity's entities on the role; any other group, including one on a role the identity binds no entity on, is dropped
       */
      entity_groups?: {
        [key: string]: components["schemas"]["EntityGroup"];
      } | null;
      /**
       * Assumptions
       * @description the assumptions of the reading this candidate rebuilds, echoed as the response gave them, which are the candidates part's reading_assumptions under the reading's spec_id. The rebuilt reading's reading_assumptions entry states the echoed items that still hold, each worded from the rebuilt reading by the rule ResubmitIdentityEntry.assumptions states, and the rebuilt part's assumptions are the items every reading_assumptions list holds alike. An item the echo lacks is not stated, so an edit of a defaulted slot to another value drops that default, and [], the echo of a reading that stated none, states none. None, the default, means the client echoes nothing for this reading, which yields what a fresh request would: no declared default, since the posted identity binds every slot, and the open roles and place scope the reading reads
       */
      assumptions?: components["schemas"]["Assumption"][] | null;
    };
    /**
     * ResubmitCandidatesEntry
     * @description One part re-materialised from a posted set of competing candidate
     *     identities, through the promote path, in posted order, always. `ordering`
     *     names the display rule this set already used, restated rather than
     *     recomputed: the order rests on the bind model's election and the availability
     *     reads of the first answer, which do not round-trip -- see `Ordering` and
     *     `outcomes.CandidateSet`. This entry carries no
     *     `max_candidates` field: `CandidateSet.max_candidates` on the response is
     *     not posted back and is always server-computed, never client-supplied.
     */
    ResubmitCandidatesEntry: {
      /**
       * @description discriminator for a candidate-set dataset_resubmit entry (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      entry_kind: "candidates";
      /**
       * Variable Text
       * @description this part's variable text, echoed back onto the rebuilt part
       */
      variable_text: string;
      /**
       * Ordering
       * @description how `candidates` below was ordered when this set was first produced; echoed back verbatim onto the rebuilt candidates part, never recomputed
       */
      ordering: ("broadest_first" | "intent_rank") | (string & {});
      /**
       * Truncated
       * @description echoed back verbatim onto the rebuilt candidates part -- see CandidateSet.truncated for what this flags
       */
      truncated: boolean;
      /**
       * Candidates
       * @description the competing candidates to re-materialise, in posted order, always -- the rebuilt CandidateSet.specs preserves this exact order. Refused request_invalid, at the engine rather than here, when the posted count exceeds this deployment's own ceiling -- readable in advance as caps.max_candidates from GET /api/search/capabilities
       */
      candidates: components["schemas"]["ResubmitCandidate"][];
      /**
       * Separate
       * @description true when this part is asked beside the others to be compared with them; it is kept apart from same-shape sibling parts. False, the default, folds parts that share a shape into one set answer
       * @default false
       */
      separate?: boolean;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
    };
    /**
     * ResubmitIdentityEntry
     * @description One part re-resolved from a single identity -- the payload
     *     `ResubmitIdentityPayload` carries, plus the text echo and operations every
     *     dataset_resubmit entry needs.
     */
    ResubmitIdentityEntry: {
      /**
       * @description discriminator for a single-identity dataset_resubmit entry (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      entry_kind: "identity";
      /**
       * Variable Text
       * @description this part's variable text, echoed back onto the rebuilt part
       */
      variable_text: string;
      /** @description the complete identity. Post a prior Spec.definition.identity byte-for-byte for a no-op resubmit; change nested members, including entities.origin or entities.destination, to edit that definition */
      identity: components["schemas"]["BaseIdentity"];
      /**
       * Entity Groups
       * @description the named group each role's entities were asked for as, keyed by entity role key. Post a prior Spec's resolved.entity_groups beside any identity derived from that Spec. A group is kept when it posts a dcid and the graph's members of that node are exactly the identity's entities on the role; any other group, including one on a role the identity binds no entity on, is dropped
       */
      entity_groups?: {
        [key: string]: components["schemas"]["EntityGroup"];
      } | null;
      /**
       * Separate
       * @description true when this part is asked beside the others to be compared with them; it is kept apart from same-shape sibling parts. False, the default, folds parts that share a shape into one set answer
       * @default false
       */
      separate?: boolean;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
      /**
       * Assumptions
       * @description the assumptions of the part this entry rebuilds, echoed as the response gave them. For a definite part these are its assumptions. For a reading picked from a candidates part they are that part's reading_assumptions under the reading's spec_id. The rebuilt part states the echoed items that still hold, each worded from the rebuilt answer: a declared_default whose slot (binding_ref) still binds the echoed refs, an open_role whose axis the answer still reads across every member with no entity of the identity's, and a place_scope on an answer that still names no place. An item the echo lacks is not stated, since the posted identity or its edit asked for it. An edit of a defaulted slot to another value therefore drops that default, and [], the echo of a part that stated none, states none. None, the default, means the client echoes nothing, and the part states what a fresh request would: no declared default, since the posted identity binds every slot, and the open roles and place scope the answer reads. The engine cannot tell an echoed default from one the caller writes for a slot it chose itself, and states such an item while the slot binds its refs. An echo shapes only the caller's own response
       */
      assumptions?: components["schemas"]["Assumption"][] | null;
    };
    /**
     * ResubmitParsedEntry
     * @description One part genuinely re-resolved through the parsed door's own per-part
     *     path, from a client-edited restatement of a sibling's own resolution
     *     inputs (`Part.restatement`) -- re-parsed, where `placeholder` only
     *     restates a stub. `part` already carries a required `variable_text` and
     *     its own `operations`, so this entry needs no separate top-level echo
     *     fields the way the other three kinds do. Costs one LLM bind per edit, the
     *     door's one entry kind that touches the LLM client at all.
     */
    ResubmitParsedEntry: {
      /**
       * @description discriminator for a re-parsed dataset_resubmit entry (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      entry_kind: "parsed";
      /** @description this part's resolution inputs -- normally a prior response part's own Part.restatement, posted back verbatim or edited, and resolved through the same per-part machinery the parsed door uses */
      part: components["schemas"]["ParsedPart"];
    };
    /**
     * ResubmitPlaceholderEntry
     * @description One part restated as a stub from a no_data/unsupported outcome the
     *     client already holds -- zero graph round-trips, zero LLM calls. Carried
     *     forward unresolved so its sibling parts' composed sentence and fold can
     *     still be computed across the whole dataset; the engine stamps a
     *     part-scoped `part_restated` info warning on the rebuilt part.
     */
    ResubmitPlaceholderEntry: {
      /**
       * @description discriminator for a stub dataset_resubmit entry (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      entry_kind: "placeholder";
      /**
       * Variable Text
       * @description this part's variable text, echoed back onto the rebuilt part
       */
      variable_text: string;
      /**
       * Status
       * @description which stub outcome to restate for this part
       */
      status: ("no_data" | "unsupported") | (string & {});
      /**
       * Reason
       * @description the NoData.reason to restate onto the rebuilt part; required when status is no_data, refused when status is unsupported
       */
      reason?:
        | (
            | (
                | "source_not_resolved"
                | "source_ambiguous"
                | "source_code_not_held"
                | "source_code_ambiguous"
                | "source_code_shares_variable"
                | "entity_not_resolved"
                | "entity_ambiguous"
                | "entity_set_too_large"
                | "entity_role_not_admitted"
                | "variable_not_resolved"
                | "role_not_resolved"
                | "unit_not_resolved"
                | "rate_coverage_gap"
                | "no_matching_slice"
                | "binding_mismatch"
                | "denominator_not_available"
                | "no_observations"
                | "facet_not_available"
                | "role_incompatible"
                | "role_signature_incompatible"
                | "qualifier_not_bound"
              )
            | (string & {})
          )
        | null;
      /**
       * Code
       * @description the reason, a code from the platform registry, to restate onto the rebuilt part's Unsupported.code; required when status is unsupported, refused when status is no_data
       */
      code?: string | null;
      /**
       * Separate
       * @description true when this part is asked beside the others to be compared with them; it is kept apart from same-shape sibling parts. False, the default, folds parts that share a shape into one set answer
       * @default false
       */
      separate?: boolean;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
    };
    /**
     * RetentionModel
     * @description How long a version can still be fetched, which `datasets_api.retention` computes when a
     *     door serves the version. No stored body holds it.
     */
    RetentionModel: {
      /**
       * Pinned
       * @description whether the frame the version's files render from is in the pinned tier, which has no expiry
       */
      pinned: boolean;
      /**
       * Held Until
       * @description when the working-tier frame stops being guaranteed, 30 days after it was stored. A download of the frame after `held_until`, while its bytes survive, renews it for 30 days. After it, a file selector or download link request that must render its file again renews the frame for 30 days if the frame's bytes survive, and otherwise refuses `artifact_expired`. A rebuild of unchanged data through `GET /api/datasets/{id}` or `POST /api/datasets` stores the frame again. Absent when pinned. It can be in the past
       */
      held_until?: string | null;
    };
    RoleAxis: ("origin" | "destination") | (string & {});
    /**
     * RoleAxisFact
     * @description One directional role axis (origin or destination) a role-bearing
     *     Spec's query left open, and what this Spec's own confirmation already
     *     knows about its member scope (see ResolvedSpec.role_axis_facts).
     *
     *     Unlike OpenConstraintAxisFact, a role axis has no declared value of its
     *     own that could vary across served members -- the axis is a place a flow
     *     entity binds, not a constraint members assert -- so this carries no
     *     varies/undeclared_count of its own; it carries only what a role axis
     *     genuinely has: a population size and whether that population is known.
     */
    RoleAxisFact: {
      /** @description which flow axis this fact is about */
      role: components["schemas"]["RoleAxis"];
      /**
       * Member Count
       * @description how many entities this axis' open scope resolves to. None when the count could not be established without a read this response chose not to make (e.g. a discovered opposite axis whose own role index was omitted after a cap trip); the fact still publishes in that case, naming the axis as open with an explicit unknown rather than staying silent about it
       */
      member_count: number | null;
      /**
       * Members Available
       * @description whether the member list this count summarises is itself known and could be enumerated (e.g. through entity_options or the options door), not just counted. False exactly when member_count is None
       */
      members_available: boolean;
    };
    /**
     * GraphRootEntry
     * @description A place to start listing from, with the length of its list.
     */
    RootEntry: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
      /**
       * Count
       * @description codes for a code system, members under the default projection for a group or region, Datasets for a source
       */
      count: number;
    };
    /**
     * GraphRoots
     * @description `GET /api/graph/roots`: where to start listing. Each list is ordered by dcid.
     */
    Roots: {
      /** Code Systems */
      code_systems: components["schemas"]["RootEntry"][];
      /** Groups */
      groups: components["schemas"]["RootEntry"][];
      /** Regions */
      regions: components["schemas"]["RootEntry"][];
      /** Sources */
      sources: components["schemas"]["RootEntry"][];
      /**
       * Built From
       * @description the build of each table the document read
       */
      built_from: {
        [key: string]: string;
      };
    };
    /**
     * Scope
     * @description The `scope` block a mint request may carry. On a `spec_id` input each
     *     supplied member replaces the stored spec's value for that member whole,
     *     and an omitted member keeps the spec's value. On a `statvar_set` input,
     *     which has no stored spec, an omitted member is unbound (everything).
     *     `window` narrows the result to `all`, `latest`, or a
     *     `start_year`/`end_year` range. `entities` binds role names to non-empty
     *     lists of dcids (a role's values must each be non-empty and must not
     *     contain `+` or `,`). `facets` binds a known axis (`provenance`,
     *     `measurementMethod`, `unit`) to a specific ref, or `measurementMethod`
     *     or `unit` to a null ref. The `unit` axis alone may instead carry a
     *     conversion request (`FacetUnitRequestBinding`) or ask for each entity's
     *     own currency (`FacetNationalCurrencyBinding`).
     */
    "Scope-Input": {
      /**
       * Window
       * @description the years to serve. Replaces the spec's window whole
       */
      window?:
        | (
            | components["schemas"]["WindowAll"]
            | components["schemas"]["WindowLatest"]
            | components["schemas"]["WindowRange"]
          )
        | null;
      /**
       * Entities
       * @description role name to dcids. Replaces the spec's whole entity binding. A role this map omits is unbound, so a client narrowing one role repeats the spec's other roles, and {} unbinds every bound role. An open role the map binds is no longer open
       */
      entities?: {
        [key: string]: string[];
      } | null;
      /**
       * Facets
       * @description axis to binding. Replaces the spec's whole facet binding
       */
      facets?: {
        [key: string]:
          | components["schemas"]["FacetRefBinding"]
          | (
              | components["schemas"]["UnitCurrentPricesRequestBinding"]
              | components["schemas"]["UnitConstantPricesRequestBinding"]
            )
          | components["schemas"]["FacetNationalCurrencyBinding"];
      } | null;
    };
    /**
     * AnswerScope
     * @description What a catalogue or declined answer was scoped to. Titled apart from the
     *     datasets API's own `Scope`, which the composed app's OpenAPI also publishes.
     */
    "Scope-Output": {
      /** @description the country the question named, when the engine confirmed it as a country; null when the question named no place or named one that is not a confirmed country */
      place?: components["schemas"]["GraphRef"] | null;
    };
    /**
     * ScopeAndUnits
     * @description `countries` is always `[]`. `years_covered` is filled where the graph
     *     has it. `currencies` lists every currency unit the coverage index gives the
     *     source's Provenances, sorted, and `granularity` is filled where it gives
     *     one period and axis pair for the source.
     */
    ScopeAndUnits: {
      /** Countries */
      countries: string[];
      /** Years Covered */
      years_covered: string | null;
      /** Granularity */
      granularity: string | null;
      /** Currencies */
      currencies: string[];
    };
    /**
     * SentenceToken
     * @description One token in the ordered sentence plan: a "text" token (invariant
     *     wording such as a connective, a bare separator, the terminal period, or a
     *     departure sentence) or a "slot" token (a slot- or entity-bound phrase, or
     *     the wording of an ambiguous entity).
     *
     *     ``rendered_sentence`` (the flat string) is the plain concatenation of every
     *     token's ``text``, in order. The two are computed together and cannot drift.
     *     A "slot" token with nothing bound appears too, with ``text=""``: the same
     *     token structure serves a loading skeleton (before binding is known) and the
     *     final sentence (after it is). The first non-empty token's text is
     *     capitalised.
     *
     *     Every token belongs to one ``segment``. The heading states what the answer
     *     is: actor, measure noun, counterpart, and period, in possessive order, one
     *     slot token per axis ("Germany's gross ODA disbursements to Kenya, 1973 to
     *     2024"). A unit that changes the magnitude (per capita, percent of GDP, PPP
     *     international dollars) stays in the heading. The byline follows it: the
     *     latest-year label when one applies, the plain unit with its price basis
     *     ("current US dollars", "constant 2022 US dollars") as a slot token with
     *     axis "unit", the source, and, when the identity binds measurementMethod, the
     *     method as a slot token with axis "method". Departures come next, then the
     *     assumptions clause, and both sit only on a part's or the envelope's sentence, so
     *     ``spec.resolved.sentence_plan`` carries neither.
     */
    SentenceToken: {
      /**
       * Kind
       * @description 'text' is invariant wording: a connective carrying its own surrounding whitespace (' for ', ' to '), a possessive suffix ("'s"), a bare ' '/', ' separator, the terminal '.', or a departure sentence; 'slot' is a slot- or entity-bound phrase, or on an entity_ambiguous no_data plan the ambiguous wording itself, which a client hangs the candidate menu on. A client that does not recognise a kind should render its text as plain text regardless.
       */
      kind: ("text" | "slot") | (string & {});
      /**
       * Text
       * @description the rendered text for this token; empty string for a slot with nothing bound
       */
      text: string;
      /**
       * Axis
       * @description the grammatical axis this token fills, when kind=='slot': one of the request-slot axes, 'unit' for the byline's unit of measure, or 'method' for the byline's measurement method, which no request slot carries. The unit token's binding_ref is 'unit:', and its options are the Spec's resolved.alternative_measures entries with axis 'unit': the price-basis siblings (current and constant prices) where the graph holds both. The method token appears only when the identity binds measurementMethod (a ref, a null ref, or a set), after the source token; its binding_ref is 'method:', its text the bound method's label without a trailing full stop or 'No stated method' for a null ref, and its options the Spec's facet_options entry with axis 'measurementMethod'
       */
      axis?:
        (("what" | "how" | "where" | "when" | "source" | "unit" | "method") | (string & {})) | null;
      /**
       * Segment
       * @description the part of the sentence this token belongs to: 'coverage' (the 'Answered N of M parts.' a mixed envelope sentence opens with, never on a part's or a Spec's own plan), 'heading' (what the answer is), 'byline' (latest-year label, unit, source, and a bound method), 'departure' (the text of one Departure on the same part, never on a Spec's own plan), or 'assumption' (the closing clause naming what the answer assumed, from the parts' assumptions, never on a Spec's own plan). A client styles each segment as a block; the plain join of every token's text still equals rendered_sentence
       * @default heading
       */
      segment?: ("coverage" | "heading" | "byline" | "departure" | "assumption") | (string & {});
      /**
       * Property Dcid
       * @description the constraint property dcid this token renders, when one exists; null or omitted for property-less axes (when/source), for a shape-label fallback phrase with no backing slot, and for entity-role tokens with no backing where slot. Set on a 'destination' entity-role token when the shape declares a where slot backing that axis (e.g. dev-finance).
       */
      property_dcid?: string | null;
      /** @description origin/destination when this token renders a directional entity role (the flow's two endpoints read back), or the directional scope an unbound where slot resolved to. entity_refs is the discriminator: non-empty on the entity read-back, empty on the unbound-where-slot fallback. binding_ref is not: an entity read-back carries binding_ref too whenever the shape declares a where slot backing the 'destination' axis (e.g. dev-finance), the same condition under which the unbound-where-slot fallback always carries it, so a present binding_ref value never separates the two. Both kinds join to the Spec.resolved.entity_options entry on the same role. A third token sits on an entity_ambiguous no_data plan, which has no Spec: the ambiguous wording, with the role the request gave it (null when it gave none), no entity_refs and no binding_ref, and text equal to one NoData.ambiguous_entities[i].text on the same part. The client titles that wording's candidate menu by this role and posts the pick's entry of NoData.options. */
      role?: components["schemas"]["RoleAxis"] | null;
      /**
       * Binding Ref
       * @description join key correlating this token to its Spec.resolved.slots / SlotOptions entry: 'axis:property_dcid', i.e. SlotKey.as_ref() (matching Slot.key and SlotOptions.key). Set for a slot-backed token, and also for a 'destination' entity-role token when the shape declares a where slot backing that axis (e.g. dev-finance) -- see entity_refs for the entity side of that token. The byline's unit token carries 'unit:', which no slot backs; its options are the resolved.alternative_measures entries with axis 'unit'. The byline's method token carries 'method:', which no slot backs either. Null or omitted for plain connective text, a shape-label fallback phrase with no backing slot, and 'origin'/unbacked-'destination' entity-role tokens.
       */
      binding_ref?: string | null;
      /**
       * Entity Refs
       * @description entity dcids this token renders, set on the entity read-back, one of the two token kinds role marks (see role's own docstring for the other, the unbound-where-slot fallback, which leaves entity_refs empty even though it too carries role) -- a directional entity read-back has no Spec.resolved.slots entry of its own, though a 'destination' token may additionally carry binding_ref when a backing where slot exists (e.g. dev-finance); one dcid per entity in the token's group, in the same order as the entities joined into this token's text -- e.g. a 'destination' token reading 'Ethiopia, Kenya, and Uganda' carries all three dcids, so a client can tell a 3-entity answer from a 1-entity one without parsing rendered text. Empty when role is unset, and this emptiness, not binding_ref, is the join rule that separates the two role-bearing kinds.
       */
      entity_refs?: string[];
      /**
       * States
       * @description the refs a heading or byline slot token states, so a client edits each from this token: its own binding_ref, then each binding the renderer left silent because this token's text already says it. Refs read as binding_ref does ('how:crsTypeOfFlow', 'where:', 'origin:', 'unit:'), plus 'axis:<property dcid>' for a measure axis no slot carries ('axis:nettingBasis'). The measure noun states the measure axes its label or authored noun carries, the how values it names, and the agreed open axes beside it; a StatVar name or graph name states the how values it folds. The byline's unit token states 'unit:' and, when it names a price basis, the measurementQualifier axis. The byline's source token states 'source:', which is also its binding_ref where the answer binds a source slot. The byline's method token states 'method:', its binding_ref, and while the identity binds no method no token states 'method:'. Empty on a token with empty text, on text tokens, and outside heading and byline slot tokens. Within one part, no ref appears on two tokens with text. A bound slot, an unbound slot with options, or a role that no token states is stated nowhere in the sentence (a boolean member, an adjectival fold dropped whole, an open role with no count), and a client offers it apart from the sentence with its current value. On the envelope plan a token with no part_index states its refs for every part it stands for
       */
      states?: string[];
      /**
       * Distinguishes
       * @description true when this token's text differs from the same-bucket text on another candidate in the same CandidateSet; null or omitted on every other token, including every token on a Spec rendered outside a candidate set
       */
      distinguishes?: boolean | null;
      /**
       * Part Index
       * @description this token's position in Resolution.parts, when this plan is the envelope-level composed sentence (Resolution.sentence_plan) and this token belongs to exactly one part's own contribution -- a variable phrase token, or a qualifier attached to it because it did not agree across every part, or a token of a part composed as its own sentence. Null carries four distinct readings a client must not conflate: on a part's own plan (DefinitePart.spec.resolved.sentence_plan, or the candidates/no_data/unsupported sentence_plan on _PartBase) the field has no meaning at all and is never set; on a composer-minted token, it means the token belongs to the sentence as a whole rather than to any one part (the Oxford-joined ' and '/', ', the plan's own terminal '.', the shared ' ' the per-part fallback puts between two sentences, the 'coverage' opener, and an assumptions clause's lead, separators and '.' when no one part carries every item it names are all such tokens); on a token every contributing part states alike and the join states once (a hoisted qualifier on the where, when, or source axis, each a wire value of axis, or the origin role, identified by role=='origin' instead since SentenceAxis has no 'origin' member; a shared possessive lead; the shared byline; or a heading or byline token of a part a later part folded into, binding_folded, which both parts state) it means the token no longer describes a single variable; and on an 'assumption' item it means more than one part assumed it, and each part's own assumptions list says which.
       */
      part_index?: number | null;
    };
    /**
     * GraphAvailabilitySeries
     * @description A source's facets sharing a measurement method, period and scaling.
     */
    Series: {
      /** @description null when no facet states a method: no stated method */
      measurement_method: components["schemas"]["NodeRef"] | null;
      /** Observation Period */
      observation_period: string | null;
      /** Scaling */
      scaling: string | null;
      /** First Year */
      first_year: string | null;
      /** Last Year */
      last_year: string | null;
      /**
       * Places
       * @description null for a role-bearing variable
       */
      places: number | null;
      /** Observations */
      observations: number;
      units: components["schemas"]["UnitsFold"];
      binding: components["schemas"]["Binding"];
    };
    /**
     * SeriesAxisRef
     * @description One constraint of a series' StatVar (see ObservationSeries.axes).
     */
    SeriesAxisRef: {
      /**
       * Property
       * @description the constraint property's dcid, e.g. 'crsPurpose'
       */
      property: string;
      /**
       * Ref
       * @description the dcid of the value the StatVar holds on property
       */
      ref: string;
      /**
       * Label
       * @description display label for ref: its graph label, else the dcid's tail split into lower-case words
       */
      label: string;
    };
    /**
     * SeriesConversionFallbackExample
     * @description One entity a converted series' recipe substituted with its own
     *     fallback entity, because the substituted entity carried no row at all
     *     in the deflator table (see ObservationSeriesConversion.fallback_examples).
     */
    SeriesConversionFallbackExample: {
      /**
       * Entity
       * @description the entity dcid absent from the deflator table
       */
      entity: string;
      /**
       * Fallback Entity
       * @description the recipe's fallback entity substituted for it
       */
      fallback_entity: string;
    };
    /**
     * SeriesEntityRef
     * @description One entity in a series' role tuple (see ObservationSeries.entities).
     */
    SeriesEntityRef: {
      /**
       * Role
       * @description observationAbout, origin, or destination
       */
      role: ("observationAbout" | "origin" | "destination") | (string & {});
      /**
       * Ref
       * @description the entity's dcid
       */
      ref: string;
      /**
       * Label
       * @description best-effort display label for ref; None when unresolved, never fabricated
       */
      label?: string | null;
      /**
       * Party Kind
       * @description on an origin or destination entity, what the party is beside the others on its side: 'party' (a country, territory or organisation), 'total' (other parties' figures, so a sum across the role that counts it counts its members twice) or 'residual' (figures no other party holds), as the code index lists it. Absent for a party the index does not list, and on observationAbout
       */
      party_kind?: (("party" | "total" | "residual") | (string & {})) | null;
    };
    /**
     * SeriesFacetRef
     * @description One axis's value on a single series' selected observation facet (see
     *     ObservationSeries.facet).
     */
    SeriesFacetRef: {
      /**
       * Ref
       * @description the facet's dcid for this axis
       */
      ref: string;
      /**
       * Label
       * @description best-effort display label for ref; None when unresolved, never fabricated
       */
      label?: string | null;
      /** @description provenance axis only: the organisation behind the provenance, from the origin catalogue; absent for a provenance the catalogue does not list */
      source?: components["schemas"]["SourceRef"] | null;
      /** @description provenance axis only: the Data Commons the provenance's data comes from; absent for a provenance the catalogue does not list */
      data_commons?: components["schemas"]["search__models__grammar__DataCommonsRef"] | null;
      /**
       * Documentation
       * @description provenance axis only: the Graph API route of the provenance's document, GET /api/graph/documentation/{dcid}
       */
      documentation?: string | null;
    };
    /**
     * SeriesStatVarRef
     * @description A series' StatVar identity ({ref, label} -- mirrors SeriesFacetRef's shape).
     */
    SeriesStatVarRef: {
      /**
       * Ref
       * @description the StatVar dcid these points observe
       */
      ref: string;
      /**
       * Label
       * @description a row's own distinguishing label: composed from ref's own constraint values when it has any beyond its shape's shared five-tuple, else ref's plain resolved display name; None when unresolved, never fabricated
       */
      label?: string | null;
    };
    /**
     * ServedMember
     * @description One StatVar a definition serves: its `dcid:`-prefixed `ref`, as the manifest trace's
     *     `resolved_stat_vars` names it, its graph `label` (`null` when the graph holds none), the
     *     `roles` it declares, and its `constraints`, each constraint property with its value
     *     (`null` when the StatVar leaves it unbound).
     */
    ServedMember: {
      /** Ref */
      ref: string;
      /** Label */
      label: string | null;
      /** Roles */
      roles: string[];
      /** Constraints */
      constraints: {
        [key: string]: string | null;
      };
    };
    /**
     * Shape
     * @description The structural family chosen for the query.
     */
    Shape: {
      /**
       * Shape Id
       * @description stable id of this structural family
       */
      shape_id: string;
      /**
       * Label
       * @description plain-language name of what the reading serves: a composed measure label, the served series' name, or the family's name
       */
      label: string;
      /** @description the graph populationType; None when the StatVar does not assert it (custom-DC imports may omit any five-tuple arc) */
      population_type?: components["schemas"]["GraphRef"] | null;
      /** @description the graph measuredProperty; None when the StatVar does not assert it (custom-DC imports may omit any five-tuple arc) */
      measured_property?: components["schemas"]["GraphRef"] | null;
      /** @description the graph statType, e.g. measuredValue; None when the StatVar does not assert it (custom-DC imports may omit any five-tuple arc) */
      stat_type?: components["schemas"]["GraphRef"] | null;
      /** @description structural anchor; present only when the measured property is qualified */
      measurement_qualifier?: components["schemas"]["GraphRef"] | null;
      /** @description a structural anchor, present only on a ratio or per-capita measure. Holds the measurementDenominator arc's target dcid for a resolved StatVar or for a dangling target that itself carries a dcid. Is None both when no denominator arc exists at all and when the arc's target carries no dcid. A null value here does not by itself establish that no denominator arc exists. Read measurement_denominator_unresolved alongside it to tell the two apart */
      measurement_denominator?: components["schemas"]["GraphRef"] | null;
      /**
       * Measurement Denominator Unresolved
       * @description true when the measurementDenominator arc is present and its target is a ProvisionalNode the graph defines no real StatVar for, whether or not that target carries a dcid. False when no denominator arc exists at all, or when the arc names a confirmed StatVar. A client should read this flag before trusting measurement_denominator on its own. A null ref is consistent with either no arc (this flag false) or a dcid-less dangling target (this flag true), and a populated ref is consistent with either a confirmed StatVar (this flag false) or a dcid-bearing dangling target (this flag true)
       * @default false
       */
      measurement_denominator_unresolved?: boolean;
      /**
       * Slot Keys
       * @description the constraint and facet slots this family exposes, in display order
       */
      slot_keys: components["schemas"]["SlotKey"][];
      /**
       * Member Count
       * @description the size of the resolved population behind this response: how many StatVars the shape's current bindings admit, narrowing as a slot binds and widening again as one is cleared
       */
      member_count: number;
      /**
       * Member Digest
       * @description lowercase sha256 hex of the RFC 8785 (JCS) canonical JSON of the sorted list of bare dcids (no 'dcid:' prefix) of the family a Datasets mint of this Spec's definition resolves, the mint's trace.family_member_digest: every row of the family the code index resolves, or every member the mint's member walk confirms when it read every candidate. Null when Search did not settle that family for this definition, and when its walk proved the members from a window it did not read to the end, so it cannot name every member of the family
       */
      member_digest?: string | null;
      /**
       * Refine Supported
       * @description true unless the shape's StatVar(s) are ratio-backed (with _AsAFractionOf_ tokens), which construct-and-confirm sibling StatVars cannot refine
       * @default false
       */
      refine_supported?: boolean;
      /**
       * Data Commons
       * @description every Data Commons holding admitted data for a member StatVar, in the order dfo, base, un_system; a Data Commons by Google variable lists dfo as well when the Observatory's own imports hold it. Empty when the engine derived the shape without its members
       */
      data_commons?: components["schemas"]["search__models__grammar__DataCommonsRef"][];
      /** @description the one source and Data Commons every member's data comes through, present only for a shape outside the Observatory's own imports whose members the origin catalogue places under exactly one source */
      upstream?: components["schemas"]["ShapeUpstream"] | null;
    };
    /**
     * ShapeUpstream
     * @description The one source, and the Data Commons serving it, behind every member of
     *     an upstream shape.
     */
    ShapeUpstream: {
      /** @description the organisation behind every member's data */
      source: components["schemas"]["SourceRef"];
      /** @description the Data Commons serving that data */
      data_commons: components["schemas"]["search__models__grammar__DataCommonsRef"];
    };
    /**
     * SimpleUnit
     * @description A unit by reference, by currency, or both, with optional words.
     *
     *     `ref` is the unit's dcid. `currency` is an ISO 4217 code, which a converted unit
     *     `{currency, prices, base_year}` names in place of a dcid. `prices` says whether money is
     *     in `current` or `constant` prices, and `base_year` names the year constant prices are
     *     expressed in; it is present exactly when prices are constant.
     */
    SimpleUnit: {
      /** Ref */
      ref?: string;
      /** Currency */
      currency?: string;
      /** Label */
      label?: string;
      /**
       * At Mint
       * @constant
       */
      at_mint?: true;
      /** Prices */
      prices?: ("current" | "constant") | (string & {});
      /** Base Year */
      base_year?: number;
    };
    /**
     * Skill
     * @description One skill's front matter on the wire, keyed by id in
     *     Resolution.skills. Mirrors skills_index.SkillFrontMatter's four
     *     members -- the search API's own wire model, not that dataclass itself,
     *     so it carries its own field descriptions the way every other response
     *     model does.
     */
    Skill: {
      /**
       * Id
       * @description the skill's stable id; the key this entry is filed under
       */
      id: string;
      /**
       * Name
       * @description the skill's declared name
       */
      name: string;
      /**
       * Description
       * @description the skill's declared description
       */
      description: string;
      /**
       * Content Version
       * @description sha256: over the skill's manifest, SKILL.md then its references in path order, so any edit to any file in the bundle changes it
       */
      content_version: string;
    };
    /**
     * Slot
     * @description One slot in the chosen shape, with its current binding state.
     */
    Slot: {
      /** @description the slot's typed identity (axis + property + label) */
      key: components["schemas"]["SlotKey"];
      /**
       * Binding
       * @description exactly one of the three binding states
       */
      binding:
        | components["schemas"]["BindingValue"]
        | components["schemas"]["BindingSet"]
        | components["schemas"]["BindingUnbound"];
      /** @description codes the resolver admitted beyond this slot's own bound value(s), when the bound value's code system is declared hierarchical; None for every other slot, including one bound on a flat code system (e.g. crsTypeOfFlow) or a property the deployment's code index does not carry at all. Reports resolution-time breadth only -- `binding` alone is what the query asked for and what spec identity hashes. */
      expansion?: components["schemas"]["Expansion"] | null;
      /**
       * Summable
       * @description true when the datasets door's `groupby` sums the family's members over this slot into one complete series: the slot's property is a code system the deployment's code index declares summable (capabilities `summable_axes`), and the dataset the family is served from declares that an observation it carries no row for reads as zero, so a member with no rows adds nothing. False for every other property, for the property that classifies a dataset's rows, and for every slot of a family whose dataset declares no such reading, where a member with no rows refuses the sum. Independent of the binding, so an unbound, set or value-bound slot reads alike. Spec identity does not hash it.
       * @default false
       */
      summable?: boolean;
    };
    /**
     * SlotKey
     * @description A slot's typed identity: axis, constraint property, and human label.
     */
    SlotKey: {
      /**
       * Axis
       * @description the slot grammar axis
       */
      axis: ("what" | "how" | "where" | "when" | "source") | (string & {});
      /** @description the constraint property that defines this slot when one exists; null or omitted for when, source, and the where-axis slot that binds the subject/destination entity directly (no constraint property backs it) */
      property?: components["schemas"]["GraphRef"] | null;
      /**
       * Label
       * @description human label, e.g. purpose, donor
       */
      label: string;
    };
    /**
     * SlotOption
     * @description One candidate value the binder had available for a slot.
     */
    SlotOption: {
      /** @description one taxonomy member or observed facet value */
      value: components["schemas"]["SlotValue"];
      /**
       * Coverage
       * @description this option's observation footprint if it were bound instead of the current value; populated when response_options.include_option_coverage is true
       */
      coverage?:
        | (
            | components["schemas"]["CoverageExact"]
            | components["schemas"]["CoverageBreadth"]
            | components["schemas"]["CoverageBare"]
          )
        | null;
      /**
       * Relation
       * @description where this option sits in a level-scoped constraint-slot menu on a code-index-carried taxonomy: 'child' or 'parent' of the slot's bound value, and 'root' for every other classification root beside a bound root; for an unbound hierarchical slot, 'root' for a classification root and 'child' for a child of the root named in parent; 'root' for every value of a flat code system. None on every other surface this type serves -- entity_options, facet_options, and the options door's OptionsSet -- none of which classify their candidates by level
       */
      relation?: (("child" | "parent" | "root") | (string & {})) | null;
      /**
       * Parent
       * @description dcid of this option's parent in a hierarchical code system, for a level-scoped constraint-slot option that has one; None for a root, for a flat code system's values, and on every surface where relation is None
       */
      parent?: string | null;
      /**
       * Member Count
       * @description how many StatVars this index holds coded directly to this option's value (not a subtree rollup), for a level-scoped constraint-slot option; None on every other surface this type serves -- entity_options, facet_options, and the options door's OptionsSet -- none of which count members from the code index
       */
      member_count?: number | null;
      /**
       * Served Rows
       * @description the rows this answer's file would hold if this option were bound instead of the current value, in the terms of ResolvedSpec.download.rows: one per series and year with a point inside the requested window, or under 'latest' one per series holding its StatVar's latest year. A series is a served StatVar carrying the option or one of its code-index descendants (the widening the binder applies to a bound value) at one entity, or donor and recipient pair. An unbound slot counts the answer's own family; a bound slot counts the family with that slot left unbound and every other binding kept. An option this answer would serve nothing for is omitted from the menu, except the slot's current value. None where the option is not counted: on entity_options, facet_options and the options door, and on a bound slot whose family needs graph reads to count, where a trailing slot_options event can supply it. A StatVar the coverage artifact does not hold adds no rows: the count covers the pick's other StatVars, and an option all of whose StatVars are missing from the artifact is omitted
       */
      served_rows?: number | null;
      /**
       * Served Rows Exact
       * @description true when served_rows equals the download.rows a pick of this option would state; false when it is an upper bound: a counted StatVar whose series sit in more than one facet group (provenance, method and unit) in the window, of which the pick's read elects one; an answer read in bulk whose pick's StatVars sit in more than one facet, since a bulk read elects one; under 'latest', a StatVar with a facet observed more often than yearly; an answer that pins a facet value; a unit request whose conversion cannot be read as download.rows_exact describes, that converts a counted series from a currency the answer does not serve, or whose options the coverage probe counts (a bound slot of a subject-place family, a candidates reading); or a series whose facets carry no complete date list. Null exactly when served_rows is null
       */
      served_rows_exact?: boolean | null;
      /**
       * Party Kind
       * @description on an origin or destination entity option, what the party is beside the others on its side: 'party' (a country, territory or organisation), 'total' (other parties' figures, so a sum across the role that counts it counts its members twice) or 'residual' (figures no other party holds), as the code index lists it. Absent for a party the index does not list, and on every other option
       */
      party_kind?: (("party" | "total" | "residual") | (string & {})) | null;
    };
    /**
     * SlotOptions
     * @description The full candidate set one slot was bound against.
     *
     *     The taxonomy the binder chose from and the options a client can offer the user
     *     are the same artifact; this is that artifact, surfaced per slot. ``key`` matches
     *     the ``SlotKey`` of the corresponding entry in ``Spec.resolved.slots`` (join on axis and
     *     ``property.ref``).
     */
    SlotOptions: {
      /** @description the slot identity this option set belongs to */
      key: components["schemas"]["SlotKey"];
      /**
       * Options
       * @description candidate values, in taxonomy order; a dcid that failed to resolve a label is omitted rather than fabricated. For a level-scoped constraint slot (relation is populated), this is the bound value's children and parent (for a bound root, its children and every other root), or, when the slot is unbound, each classification root followed by its children -- never deeper levels. A counted menu omits every option its answer would serve nothing for except the slot's current value (see SlotOption.served_rows)
       */
      options: components["schemas"]["SlotOption"][];
      /**
       * Truncated
       * @description false when options is the full known set for this slot at its current level (a curated seed taxonomy, a level-scoped taxonomy sourced from the packaged code index, or an observed taxonomy from the same source, rather than the recalled candidates); true when options is only the values observed among the resolved candidates (bounded by the recall cut, not exhaustive)
       */
      truncated: boolean;
      /**
       * Source
       * @description 'seed' for a hand-curated family taxonomy (e.g. dev-finance scheme/purpose); 'observed' for the union of values seen on the confirmed StatVars or resolved query entities
       */
      source: ("observed" | "seed") | (string & {});
    };
    /**
     * SlotValue
     * @description One taxonomy member or facet value bound to a slot.
     */
    SlotValue: {
      /** @description the graph object bound, when the value is a graph object */
      ref?: components["schemas"]["GraphRef"] | null;
      /**
       * Value Kind
       * @description what kind of value this is
       */
      value_kind: ("entity" | "enum_value" | "time_window" | "source" | "literal") | (string & {});
      /** @description present iff value_kind == time_window */
      time_window?: components["schemas"]["TimeWindow"] | null;
      /**
       * Literal
       * @description present iff value_kind == literal
       */
      literal?: string | null;
    };
    /**
     * GraphAvailabilitySourceEntry
     * @description One source's facets of the variable, and their series.
     */
    SourceAvailability: {
      source: components["schemas"]["AvailabilitySource"];
      /**
       * Places
       * @description the places covered by kind; null for a role-bearing variable, and while the places' kinds are unread (a transient gap)
       */
      places: {
        [key: string]: number;
      } | null;
      /**
       * Entities
       * @description the entities covered per graph role; null for any other variable
       */
      entities: {
        [key: string]: components["schemas"]["EntityCounts"];
      } | null;
      /** First Year */
      first_year: string | null;
      /** Last Year */
      last_year: string | null;
      /** Facets */
      facets: number;
      /** Series */
      series: components["schemas"]["Series"][];
    };
    /**
     * GraphSourceBlock
     * @description A Source, Dataset or Provenance's detail block. `documentation` is the path of the
     *     node's source document on this API.
     */
    SourceBlock: {
      /** @description the source arc's target; null when the node carries no source arc */
      publisher: components["schemas"]["NodeRef"] | null;
      /** @description the isPartOf arc's target; null when the node has no parent Dataset */
      parent: components["schemas"]["NodeRef"] | null;
      /** License */
      license: string | null;
      /** License Type */
      license_type: string | null;
      /** Url */
      url: string | null;
      /**
       * Source Data Url
       * @description the sourceDataUrl arc's value
       */
      source_data_url: string | null;
      /**
       * Description Url
       * @description the descriptionUrl arc's value
       */
      description_url: string | null;
      /**
       * Transformation Logic Url
       * @description the dataTransformationLogic arc's value: a URL to the transformation code
       */
      transformation_logic_url: string | null;
      /**
       * Last Data Refresh Date
       * @description the lastDataRefreshDate arc's value
       */
      last_data_refresh_date: string | null;
      /**
       * Next Data Refresh Date
       * @description the nextDataRefreshDate arc's value
       */
      next_data_refresh_date: string | null;
      /**
       * Earliest Observation Date
       * @description the earliestObservationDate arc's value
       */
      earliest_observation_date: string | null;
      /**
       * Latest Observation Date
       * @description the latestObservationDate arc's value
       */
      latest_observation_date: string | null;
      freshness: components["schemas"]["Freshness"];
      /** @description the Data Commons serving this provenance, from the origin catalogue; null for a provenance the catalogue does not admit, a Dataset, or a Source */
      data_commons: components["schemas"]["graph_api__origin_models__DataCommonsRef"] | null;
      /**
       * Documentation
       * @description the path of the node's source document
       */
      documentation: string;
    };
    /**
     * SourceCatalogue
     * @description The full `GET /api/graph/sources` response: DFO's sources, then the
     *     origin registry's base Data Commons entries and UN System Data Commons
     *     agencies in registry order, each with the provenances the request's
     *     origin catalogue admits under it, grouped by Dataset. UN agencies are left
     *     out when the UN origin is off. The response has no count and no pagination.
     */
    SourceCatalogue: {
      /** Sources */
      sources: components["schemas"]["SourceCatalogueEntry"][];
    };
    /**
     * SourceCatalogueEntry
     * @description One source on one Data Commons, with the datasets this deployment
     *     admits under it and the provenances it excludes. DFO provenances and UN
     *     agencies exclude nothing here.
     */
    SourceCatalogueEntry: {
      source: components["schemas"]["SourceNodeRef"];
      data_commons: components["schemas"]["graph_api__origin_models__DataCommonsRef"];
      /** Datasets */
      datasets: components["schemas"]["DatasetEntry"][];
      /** Exclusions */
      exclusions: components["schemas"]["Exclusion"][];
    };
    /**
     * SourceCode
     * @description A publisher's own series code for a StatVar, such as World Bank `DT.TDS.DEGG.CD`.
     */
    SourceCode: {
      /**
       * Provenance
       * @description the provenance dcid of the publisher that issues the code
       */
      provenance: string;
      /**
       * Code
       * @description the publisher's series code, as the publisher writes it
       */
      code: string;
      /**
       * Exact
       * @description true when the answer is the series the provenance files under this code and no other: a part naming the code as its source_code and the provenance as its source accepts this Spec as its answer. The answer reads its observations from the provenance alone, the provenance gives none of the code's StatVars another code, and every StatVar a Datasets mint of the Spec serves is one of the code's. False, the default, is omitted: the code names a StatVar the answer serves, and the answer may hold other series or data of another source
       * @default false
       */
      exact?: boolean;
    };
    /** SourceDetails */
    SourceDetails: {
      /** Name Of Source */
      name_of_source: string | null;
      /** Publisher */
      publisher: string | null;
      /** @description the origin registry's source for the documented Provenances, null unless the origin catalogue admits every one of them and they share one */
      source: components["schemas"]["SourceNodeRef"] | null;
      /** @description the Data Commons serving the documented Provenances, null unless the origin catalogue admits every one of them and they share one */
      data_commons: components["schemas"]["graph_api__origin_models__DataCommonsRef"] | null;
      /** Description */
      description: string | null;
      /** Source Url */
      source_url: string | null;
      /**
       * Source Data Url
       * @description the file the pipeline downloads, the source's `sourceDataUrl`
       */
      source_data_url: string | null;
      /**
       * Citation
       * @description the source's `licenseAttribution` text
       */
      citation: string | null;
    };
    /**
     * SourceDocumentation
     * @description The full `GET /api/graph/documentation/{dcid}` response.
     */
    SourceDocumentation: {
      details: components["schemas"]["SourceDetails"];
      license: components["schemas"]["SourceLicense"];
      scope_and_units: components["schemas"]["ScopeAndUnits"];
      methodology: components["schemas"]["Methodology"];
      /**
       * Data Notes
       * @description one caveat per entry, as CommonMark
       */
      data_notes: string[];
      usage: components["schemas"]["Usage"];
      /** Transformation Log */
      transformation_log: components["schemas"]["TransformationLogEntry"][];
      /** Version History */
      version_history: components["schemas"]["VersionHistoryEntry"][];
      /**
       * Gaps
       * @description every member path that is null or empty for this source, in spec order, e.g. 'details.citation', 'scope_and_units.countries'
       */
      gaps: string[];
      /**
       * Document Errors
       * @description each Markdown document the source carries but this door could not serve
       */
      document_errors: components["schemas"]["DocumentErrorEntry"][];
    };
    /** SourceLicense */
    SourceLicense: {
      /** Type */
      type: string | null;
      /**
       * Url
       * @description the licence text on the publisher's site, the source's `license`
       */
      url: string | null;
      /** Update Cadence */
      update_cadence: string | null;
      /** Last Update */
      last_update: string | null;
      /** Next Expected Update */
      next_expected_update: string | null;
    };
    /**
     * SourceMention
     * @description One data source a part names or excludes, as its words, a reference, or both.
     */
    SourceMention: {
      /**
       * Text
       * @description the user's words naming the source, e.g. 'IDS', 'the OECD' or 'World Bank', without the words that ask for its data ('World Bank' in 'World Bank debt data'). They are matched whole against the names of every admitted publisher, dataset and provenance, and their registered abbreviations, ignoring case, punctuation and a leading 'the'. Included words that match none resolve no_data with source_not_resolved. Excluded words that match none remove nothing and warn query_qualifier_dropped. Words that match two unrelated sources resolve no_data with source_ambiguous, listing both
       */
      text?: string | null;
      /**
       * Ref
       * @description the reference this mention names, when the caller holds one (a provenance dcid, a catalogue Dataset ref or a Source ref), such as a restatement's resolved mention or a NoData.ambiguous_sources candidate carries. It skips matching `text`. A ref the origin catalogue does not admit refuses request_invalid with a pointer to it
       */
      ref?: string | null;
      /**
       * Polarity
       * @description include to answer from this source, exclude to answer from any other. A part with an included source answers from the included sources only. A part with exclusions alone answers from every admitted source but those
       * @default include
       */
      polarity?: ("include" | "exclude") | (string & {});
    };
    /** SourceNode */
    SourceNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "source";
      source: components["schemas"]["SourceBlock"];
    };
    /**
     * GraphSourceNodeRef
     * @description A Data Commons `Source` node (`dc/s/*`). On the UN System Data Commons, where every
     *     agency sits under one source, it is the agency provenance (`undata/p/*`).
     */
    SourceNodeRef: {
      /** Ref */
      ref: string;
      /** Label */
      label: string;
    };
    /**
     * SourceRef
     * @description The organisation behind a provenance: the Source node its `source` arc
     *     names on our Data Commons and on Data Commons by Google, or the agency
     *     provenance itself on the UN System Data Commons.
     */
    SourceRef: {
      /**
       * Ref
       * @description the source's dcid
       */
      ref: string;
      /**
       * Label
       * @description the source's display name
       */
      label: string;
    };
    /**
     * Spec
     * @description The unit of meaning: one named region of the graph.
     *
     *     Reused as the definite answer, each candidate, and NoData's own
     *     flagged_match/alternate_match (a plain Spec on both). See NoData's own
     *     docstring for the failed-gate code each carries, NoData.gate, kept
     *     structurally outside every identity path. NearestRealSpec (below)
     *     subclasses Spec for NoData.nearest_real, adding the relaxation each
     *     suggestion carries. That stays structurally outside every identity path
     *     the same way (spec_id is computed from bindings, never from the model),
     *     so it cannot perturb spec_id.
     */
    Spec: {
      /**
       * Spec Id
       * @description deterministic hash of (shape + canonical slot bindings); permalink-safe, dedup key, golden-comparison handle, cache key
       */
      spec_id: string;
      /** @description the canonical definition this Spec was resolved from: {schema_version, identity}, the same shape Unsupported.definition uses. definition.identity is the identity-core projection this spec_id was minted from, serialised once and never re-derived; hashing it reproduces spec_id by construction. Post definition.identity back byte-for-byte as ResubmitIdentityPayload.identity to edit this Spec. Directional entities remain nested in identity.entities. */
      definition: components["schemas"]["SpecDefinition"];
      /** @description the engine's report of what it did with the ask: stat_vars, entities, coverage, trace, and every other display/diagnostic field. Never hashed; see ResolvedSpec */
      resolved: components["schemas"]["ResolvedSpec"];
    };
    /**
     * SpecAlternativeMeasure
     * @description One other measure this Spec could equally answer with (see
     *     ResolvedSpec.alternative_measures): either another populated partition
     *     from the same family as the one this Spec's own served rows exhibit, or
     *     a genuinely distinct also_plausible candidate whose only difference from
     *     this Spec is measured_property (measurement_denominator held equal),
     *     folded in here instead of left as a second candidates entry. Carries its
     *     own identity and a label that disambiguates it.
     *
     *     `definition` is minted by editing this Spec's own already-minted
     *     identity onto this partition's measure axes (retrieval.bound_values.
     *     mint_sibling_identity), an index-scan projection, not a resolution.
     *     Carries identity and a label only: no stat_vars, no coverage, no trace.
     *     ResolvedSpec's own required fields have no defaults, so producing one as
     *     a Spec would mean fabricating a resolution that never ran.
     *
     *     Post `definition` back as `identity` on a dataset_resubmit identity entry to
     *     switch onto this measure: the identity's own what/how slots (this
     *     partition's per-partition-declared axes included, e.g. CRS cooperation
     *     modality) name the family the packaged code index's own election
     *     recovers members from, the same recovery a resubmit of this Spec's own
     *     identity uses.
     *
     *     `axis` names the sentence token whose menu offers the entry. A partition
     *     that differs from this Spec's only in price basis (`measurementQualifier`
     *     `Nominal` or `RealValue`) is a unit option, axis "unit", offered by the
     *     byline's unit token (binding_ref "unit:"). Every other entry is a measure
     *     option, axis "what". The measure menu holds one entry per measure
     *     whatever its price basis, so no two "what" entries differ only in price
     *     basis.
     */
    SpecAlternativeMeasure: {
      /** @description the alternative measure's own {schema_version, spec_id, identity} */
      definition: components["schemas"]["SpecDefinition"];
      /**
       * Label
       * @description readable text for this option, distinct from every other entry's on the same axis. A 'what' entry names the measure without its price basis ('net disbursements'), and differs from measure_label; a 'unit' entry names the prices it switches to ('constant prices')
       */
      label: string;
      /**
       * Axis
       * @description the sentence token whose menu offers this entry: 'what', the measure noun, or 'unit', the byline's unit token (SentenceToken.axis 'unit', binding_ref 'unit:'), for a partition that differs from this Spec's only in price basis
       */
      axis: ("what" | "unit") | (string & {});
      /**
       * Measure Axis Values
       * @description every axis this measure's partition holds a value on, with that value, in measure-axis declaration order; the same projection as ResolvedSpec.measure_axis_values
       */
      measure_axis_values: components["schemas"]["MeasureAxisValue"][];
      /**
       * Served Rows
       * @description the rows a resubmit of `definition` would write at this Spec's bound roles, in the terms of download.rows: one per series and year with a point inside the requested window, or under 'latest' one per series holding its StatVar's latest year, a series being a served StatVar at one entity, or donor and recipient pair. A Spec that merges several answers counts at every entity its answers bind. A StatVar the coverage artifact does not hold adds no rows, and a measure that would serve none, including one whose StatVars are all missing from the artifact, is not listed. None where the count needs graph reads (a subject-place family, or a family the code index does not decide), or where the merged answers read different years or coverage
       */
      served_rows?: number | null;
      /**
       * Served Rows Exact
       * @description true when served_rows equals the download.rows of a resubmit of `definition`; false when it is an upper bound: a counted StatVar whose series sit in more than one facet group (provenance, method and unit) in the window; an answer read in bulk whose measure's StatVars sit in more than one facet; under 'latest', a StatVar with a facet observed more often than yearly; an answer that pins a facet value; or a unit request whose conversion cannot be read as download.rows_exact describes, or that converts a counted series from a currency the answer does not serve. Null exactly when served_rows is null
       */
      served_rows_exact?: boolean | null;
    };
    /**
     * SpecDefinition
     * @description The canonical definition a Spec was resolved from: `{schema_version,
     *     spec_id, identity}`. This is the form the registry stores and permalinks
     *     carry, so it is self-contained. A definition lifted out of its Spec still
     *     names which spec it is.
     *
     *     `identity` is the identity-core projection (see `BaseIdentity`) this
     *     Spec's spec_id was minted from, so hashing `identity` again reproduces
     *     `spec_id` by construction.
     *
     *     `spec_id` is carried here as well as on `Spec.spec_id` deliberately: the
     *     duplication is what makes the definition independently meaningful once
     *     detached from the response that delivered it. The one exception is an
     *     `unsupported` response's definition, which omits it: the request was
     *     valid and understood but never became a resolvable construction, so no
     *     spec_id was ever legitimately minted for it.
     */
    SpecDefinition: {
      /**
       * Schema Version
       * @description contract schema version this definition was published under; exactly 1
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /**
       * Spec Id
       * @description the spec_id minted from `identity`; equals the sibling Spec.spec_id, and is what a detached definition (registry row, permalink) is keyed by
       */
      spec_id: string;
      /** @description the identity-core projection this Spec's spec_id was minted from, serialised once and never re-derived; post it back byte-for-byte as ResubmitIdentityPayload.identity to edit this Spec. Directional edits change identity.entities.origin or identity.entities.destination directly */
      identity: components["schemas"]["BaseIdentity"];
    };
    /**
     * SpecIdInput
     * @description `kind: "spec_id"` -- an id already in the registry, with an optional
     *     canonical `definition` sidecar. `definition.spec_id`, when supplied,
     *     must equal the outer `spec_id`; the sidecar is required only when the
     *     registry does not already hold `spec_id`.
     */
    SpecIdInput: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "spec_id";
      /** Spec Id */
      spec_id: string;
      definition?: components["schemas"]["CanonicalDefinition"] | null;
      scope?: components["schemas"]["Scope-Input"] | null;
    };
    /**
     * SpecObservations
     * @description The observation values behind a Spec's coverage.
     *
     *     An opt-in bounded preview, or the full series when the resolved answer is
     *     small enough to ship in full -- see truncated. Describes the SAME (stat_var,
     *     entity) selection Spec.resolved.coverage already reports, so the numbers here never
     *     describe a different variable than what coverage summarises.
     *
     *     Each series carries one lead observation facet's points, never a union
     *     across facets: a StatVar/entity pair can have several reporting facets
     *     (e.g. commitments vs disbursements, current vs constant prices), and
     *     merging their points chronologically would interleave same-dated points
     *     from incompatible series into one meaningless line. The one exception is
     *     the same source's estimates continuing the lead past its last period: the
     *     series carries their points after the lead's, `facet` names the lead, and
     *     the `modelled_values` departure marks the estimates. One facet group is
     *     selected per StatVar instead, across every place and role tuple the answer
     *     names: among facets holding a point in the requested years (all facets when
     *     none does), DFO's facets first for a variable both DFO and base Data
     *     Commons hold, then the one covering the most places or role tuples there,
     *     then the most requested years, then the most observations, then the latest
     *     observation, then a deterministic tie-break.
     */
    SpecObservations: {
      /**
       * Series
       * @description one entry per (stat_var, role tuple) pair with observations
       */
      series: components["schemas"]["ObservationSeries"][];
      /**
       * Total Obs
       * @description total observation count across every series' SELECTED facet, window-filtered to the spec's requested window when one exists -- known even when truncated is true and points are truncated. For a windowed per-pair answer, this is the chosen facet's in-window point count, NOT a raw facet obs_count sum and NOT a union across every facet of the pair -- see ObservationSeries. For a scope-defaulted bulk latest-only answer (no requested window), this sums the coverage probe's all-time obs_count per delivered entity instead: with no window to narrow it, that raw obs_count IS the in-window count
       */
      total_obs: number;
      /**
       * Truncated
       * @description false when every series above carries its FULL point set (the whole answer's point count was within the server's inline threshold and each series within its row limit); true when a series was truncated to its latest points only, its total_obs still counting every point
       */
      truncated: boolean;
      /** @description why this payload carries no series, when it doesn't; absent when series is genuinely populated. See ObservationsOmission's own docstring */
      omitted?: components["schemas"]["ObservationsOmission"] | null;
      /**
       * Order
       * @description how a role-bearing bulk preview chose the series it shows when it shows fewer than the answer holds: 'ranked' when it read every series and shows the most recent and largest (latest year, then latest value, then identity), 'fixed' when it shows a selection made before any value was read, StatVars newest year first and taken round-robin; absent when every series is shown or the preview is not a role-bearing bulk one
       */
      order?: (("ranked" | "fixed") | (string & {})) | null;
    };
    /**
     * GraphStatVarBlock
     * @description A variable's detail block: what it measures and where DFO holds observations of it.
     */
    StatVarBlock: {
      definition: components["schemas"]["VariableDefinition"];
      /** @description where DFO holds observations of the variable; null, and named in gaps, when its read failed or the coverage index is not loaded */
      availability: components["schemas"]["Availability"] | null;
    };
    /** StatVarNode */
    StatVarNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "stat_var";
      stat_var: components["schemas"]["StatVarBlock"];
    };
    /**
     * StatVarSetInput
     * @description `kind: "statvar_set"` -- resolves one `dcid:`-prefixed StatVar to its
     *     registered shape and mints a fully pinned spec for it. `statvars` holds
     *     exactly one StatVar.
     */
    StatVarSetInput: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "statvar_set";
      /** Statvars */
      statvars: string[];
      scope?: components["schemas"]["Scope-Input"] | null;
    };
    /**
     * Step
     * @description One operation: its inputs by role, its one fixed policy, the caller's own choices,
     *     what it kept, what data gaps it left out, the unit it produces, and, for an operation
     *     that writes a new variable (sum, quotient, share, comparison), that variable's bare dcid in
     *     `stat_var`.
     *
     *     A step takes either `input` or `inputs`, or neither, never both. `stat_var` is the bare
     *     dcid of the variable a step that makes a new one (a sum, quotient, share or comparison)
     *     writes its rows under. `sides` holds, by input role, each role column whose slice of that
     *     input holds one entity, with that entity's ref. A comparison records it.
     */
    Step: {
      /** Id */
      id: string;
      /** Op */
      op: string;
      /** Stat Var */
      stat_var?: string;
      /** Input */
      input?: string | components["schemas"]["VersionRef"];
      /** Inputs */
      inputs?: {
        [key: string]: string | components["schemas"]["VersionRef"];
      };
      /** Sides */
      sides?: {
        [key: string]: {
          [key: string]: string;
        };
      };
      /** Policy */
      policy?: string;
      /** Params */
      params?: {
        [key: string]: components["schemas"]["JsonValue"];
      };
      /** Options */
      options?: {
        [key: string]: components["schemas"]["JsonValue"];
      };
      /** Kept */
      kept?: {
        [key: string]: number;
      };
      /** Left Out */
      left_out?: components["schemas"]["LeftOut"][];
      /** Period Coverage */
      period_coverage?: components["schemas"]["PeriodCoverage"][];
      /** Entity Coverage */
      entity_coverage?: components["schemas"]["EntityCoverage"][];
      choice?: components["schemas"]["Choice"];
      summed?: components["schemas"]["Summed"];
      /** Converted From */
      converted_from?:
        components["schemas"]["SimpleUnit"] | components["schemas"]["ComposedUnit"] | null;
      /** Unit */
      unit?: components["schemas"]["SimpleUnit"] | components["schemas"]["ComposedUnit"] | null;
    };
    /**
     * StepRef
     * @description A reference: the dcid or id it names, and optionally the words for it.
     *
     *     `at_mint` marks a label taken from the evidence stored when the version was made.
     */
    StepRef: {
      /** Ref */
      ref: string;
      /** Label */
      label?: string;
      /**
       * At Mint
       * @constant
       */
      at_mint?: true;
    };
    /** SubregionNode */
    SubregionNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "subregion";
      subregion: components["schemas"]["PlaceBlock"];
    };
    /**
     * Summed
     * @description A sum at mint: how many variables were summed, and up to 64 of them.
     */
    Summed: {
      /** Count */
      count: number;
      /** Variables */
      variables: components["schemas"]["StepRef"][];
    };
    /**
     * TimeWindow
     * @description A date window. Absence of a bound means open-ended in that direction.
     */
    TimeWindow: {
      /**
       * Start Year
       * @description absent means open-ended start
       */
      start_year?: number | null;
      /**
       * End Year
       * @description absent means open-ended end (to latest)
       */
      end_year?: number | null;
    };
    /**
     * Timing
     * @description Latency breakdown, reused at two scopes: the envelope's own
     *     diagnostics.timing_ms, where total is the whole request's wall-clock
     *     elapsed time and by_step names the steps that run once per request,
     *     shared across every part (e.g. extract), and a part's own timing_ms,
     *     where total sums that part's own by_step values and by_step names only
     *     the phases that part ran, excluding the shared steps already reported
     *     on the envelope. A part's shape_arcs, shape_probe, shape_probe_coverage,
     *     shape_labels, shape_groups and shape_admission steps are nested inside
     *     its shape step, so its total leaves them out.
     */
    Timing: {
      /**
       * Total
       * @description total latency in milliseconds, at whichever scope this sits
       */
      total: number;
      /**
       * By Step
       * @description per-step latency in ms
       */
      by_step?: {
        [key: string]: number;
      } | null;
    };
    /**
     * TraceConversion
     * @description A Spec-level record of a unit-conversion recipe. The engine converts
     *     per series and records each converted series' recipe and tables in
     *     ObservationSeries.conversion, since one Spec's series can convert under
     *     different recipes. ResolutionTrace.conversion is modelled here but always
     *     absent. Capabilities.recipe_classes lists the recipe members this
     *     deployment applies.
     */
    TraceConversion: {
      /**
       * Recipe
       * @description the conversion recipe class that ran
       */
      recipe: string;
      /**
       * Input Tables
       * @description the input series/table dcids the recipe combined, keyed by role
       */
      input_tables: {
        [key: string]: string;
      };
    };
    /**
     * TraceDefaultReading
     * @description The default price-basis reading applied before bind. Price bases rank Nominal,
     *     RealValue, InflationAdjusted, then PurchasingPowerParity, with any basis the query names
     *     moved first. A StatVar leaves the menu when a StatVar of a better-ranked basis with the
     *     same constraints holds data wherever it does over the requested years. The trace records
     *     whether the step ran and the StatVars it removed.
     */
    TraceDefaultReading: {
      /**
       * Applied
       * @description false when a phrase the request dropped uses a price-basis word no qualifier match read, so every price basis stayed on the menu and the alternate guard applied no default reading
       */
      applied: boolean;
      /**
       * Removed Stat Vars
       * @description the StatVar dcids the default reading removed; empty when it removed none
       */
      removed_stat_vars?: string[];
    };
    /**
     * TransformationLogEntry
     * @description One step of the pipeline's transformations, in pipeline order.
     */
    TransformationLogEntry: {
      /**
       * Transformation
       * @description the step title, plain text
       */
      transformation: string;
      /**
       * Description
       * @description what the step does, as CommonMark
       */
      description: string;
    };
    /**
     * TransformationStepModel
     * @description One step the DFO pipeline applied to a source's data, in pipeline order.
     */
    TransformationStepModel: {
      /**
       * Transformation
       * @description the step title, plain text
       */
      transformation: string;
      /**
       * Description
       * @description what the step does, as CommonMark
       */
      description: string;
    };
    /** UnavailableFormatModel */
    UnavailableFormatModel: {
      /** Format */
      format: string;
      /** Reason */
      reason: string;
    };
    /**
     * UnitAlternative
     * @description One currency a unit_not_resolved refusal offers in place of the unit
     *     phrase it could not resolve -- one entry of NoData.unit_alternatives.
     */
    UnitAlternative: {
      /**
       * Currency
       * @description the value a caller resubmits as facets.unit.request.currency, as written: an ISO 4217 code for an ambiguous currency name, or a role shape for a role-relative currency phrase beside entities on two roles
       */
      currency: string | components["schemas"]["IdentityCurrencyRole"];
      /**
       * Label
       * @description the currency's display name, or the role's reader-facing noun
       */
      label: string;
    };
    /**
     * GraphUnitBlock
     * @description A unit's detail block: the words `unit_words` names it by.
     */
    UnitBlock: {
      /** @description currency, purchasing_power, percent, or other (`unit_words.unit_class`) */
      unit_class: components["schemas"]["UnitKind"];
      /**
       * Currency
       * @description its ISO 4217 code when it is a currency
       */
      currency: string | null;
      /**
       * Currency Noun
       * @description the plural noun a currency reads as, such as `US dollars`
       */
      currency_noun: string | null;
      /** @description the price basis the unit itself states; null when it states none */
      price_basis: components["schemas"]["PriceBasisWords"] | null;
      /**
       * Changes Magnitude
       * @description whether the unit changes what a number means, so a heading states it
       */
      changes_magnitude: boolean;
    };
    /**
     * UnitConstantPricesRequestBinding
     * @description The unit axis's own conversion-request form for `prices: "constant"`:
     *     `base_year` is a required member.
     */
    UnitConstantPricesRequestBinding: {
      /** Currency */
      currency: string | components["schemas"]["UnitCurrencyRole"];
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      prices: "constant";
      /** Base Year */
      base_year: number;
    };
    /**
     * UnitConversion
     * @description The conversions a unit request can ask of this answer: the currencies, years and base
     *     years the conversion recipe of its served members converts. A request posts one as the
     *     identity's `facets.unit` (`IdentityFacetValueRequest`).
     */
    UnitConversion: {
      /**
       * Currencies
       * @description each currency a unit request accepts that converts at least one served year at current prices, at a constant-price base year, or both, sorted by code
       */
      currencies: components["schemas"]["ConversionCurrency"][];
      /**
       * Default Base Year
       * @description the base year a constant-price request that names none completes to: the deflatorBaseYear every conversion table declares
       */
      default_base_year: number;
      /**
       * Role Currencies
       * @description the ISO 4217 code of the national currency (the graph's nationalCurrencyOf arc) of the one entity bound on each role, among `currencies`. A role bound to several entities, or to one no single currency names, is absent. A request may name the role ({'role': 'origin'}) or the code
       */
      role_currencies?: {
        [key: string]: string;
      };
    };
    /**
     * GraphAvailabilityUnit
     * @description One unit of a series. `ref` is `null` for facets that state no unit.
     */
    UnitCount: {
      /** Ref */
      ref: string | null;
      /** Label */
      label: string | null;
      /**
       * Places
       * @description the places its facets cover; null for a role-bearing variable
       */
      places: number | null;
    };
    /**
     * UnitCurrencyRole
     * @description A unit-request `currency` naming a spec role rather than a concrete
     *     ISO 4217 code: convert to the currency of whichever entity is bound in
     *     that role. The role must be one the resolved StatVar declares.
     */
    UnitCurrencyRole: {
      /** Role */
      role: ("origin" | "destination" | "observationAbout") | (string & {});
    };
    /**
     * UnitCurrentPricesRequestBinding
     * @description The unit axis's own conversion-request form for `prices: "current"`:
     *     no `base_year` member.
     */
    UnitCurrentPricesRequestBinding: {
      /** Currency */
      currency: string | components["schemas"]["UnitCurrencyRole"];
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      prices: "current";
    };
    UnitKind: ("currency" | "purchasing_power" | "percent" | "other" | "none") | (string & {});
    /** UnitNode */
    UnitNode: {
      /**
       * Ref
       * @description the node's dcid
       */
      ref: string;
      /**
       * Label
       * @description the node's name; for a Provenance, its parent Dataset's name where it has one. Null, and named in gaps, when the graph gives none
       */
      label: string | null;
      /**
       * Types
       * @description the node's typeOf values, as the graph holds them
       */
      types: string[];
      /**
       * Description
       * @description the node's prose in the graph; null when it has none
       */
      description: string | null;
      /**
       * Links
       * @description each list relation the node has, mapped to its route; empty when none
       */
      links: {
        [key: string]: string;
      };
      /**
       * Gaps
       * @description the member path of every value this door cannot know
       */
      gaps: string[];
      /**
       * Built From
       * @description the build of each table the response read
       */
      built_from: {
        [key: string]: string;
      };
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "unit";
      unit: components["schemas"]["UnitBlock"];
    };
    /**
     * GraphAvailabilityUnits
     * @description A series' units: how many, the two covering the most places, and how many more.
     */
    UnitsFold: {
      /** Count */
      count: number;
      /** Leading */
      leading: components["schemas"]["UnitCount"][];
      /** More */
      more: number;
      /** @description the units that are their places' national currency; null when none is */
      national_currency: components["schemas"]["NationalCurrency"] | null;
    };
    /**
     * Unsupported
     * @description The request was valid and fully understood, but not supported.
     *
     *     Fires for a text-door condition the request grammar or this deployment
     *     cannot honour: the unit binder recognises but cannot represent a unit
     *     phrase at all -- PPP terms, per-capita, a percent/share unit, or a scale
     *     word (million/billion/thousand) -- code unit_request_unsupported, or a
     *     recognised facet axis this deployment cannot bind (code
     *     facet_binding_unsupported). A unit phrase the request form COULD
     *     represent, but that this text failed to parse cleanly (two conflicting
     *     currencies, price bases, or base years in one ask; an incomplete "base
     *     year" cue with no year value), is a different outcome entirely: it lands
     *     no_data with reason unit_not_resolved, never here. Distinct from every
     *     refusal: the request was never malformed or unresolvable, so this is a
     *     200, not a problem-details body.
     */
    Unsupported: {
      /**
       * Code
       * @description the reason, a code from the platform registry
       */
      code: string;
      /**
       * Pointer
       * @description a JSON Pointer into `definition` (not the request body) naming the binding at fault -- a text-door request has no structured body to point into
       */
      pointer: string;
      /**
       * Detail
       * @description human-readable explanation
       */
      detail: string;
      /** @description why this refusal fired, present only for code=recipe_not_declared (the structured door's same-named ProblemDetails extension); omitted on every other code */
      cause?: components["schemas"]["Cause"] | null;
      /**
       * Definition
       * @description the canonical definition as interpreted -- {schema_version, identity: {identity_version, shape, slots, entities, facets, requested_window}} -- without spec_id, since this was never a resolvable construction
       */
      definition: {
        [key: string]: unknown;
      };
    };
    /**
     * UnsupportedPart
     * @description This part's variable was valid and understood, but not supported.
     */
    UnsupportedPart: {
      /**
       * Variable Text
       * @description the variable text this part answers, in the order asked. This part's position in Resolution.parts equals the same variable_index every SSE event keyed by variable_index uses (ShapeEvent, StepEvent, SentenceEvent). Every dataset_resubmit entry kind (identity, candidates, placeholder, and parsed through its nested ParsedPart) requires its own posted variable_text, so this field is always the posted text echoed back onto the rebuilt part, never null. Null only when the whole posted query was empty or whitespace-only (raw_text door), which refuses variable_not_resolved before extraction runs and so has no text to name.
       */
      variable_text?: string | null;
      /**
       * Separate
       * @description true when this part was asked beside the others to be compared with them. A client resubmitting an identity, candidate set, or placeholder posts this flag on that entry to preserve the comparison. Two parts marked separate that resolve to one reading carry the same spec_id and stay two parts. False, the default, is omitted
       * @default false
       */
      separate?: boolean;
      /**
       * Warnings
       * @description this part's own run-health signals. A part folded into an earlier part's spec (see DefinitePart.spec) carries binding_folded alone. The merged spec's own resolved warnings live only on the first part that carries it. An unfolded part carries the warnings raised while resolving this part, plus observations_omitted on a candidates part when response_options.include_observations was set.
       */
      warnings?: components["schemas"]["Warning"][];
      /** @description this part's own latency breakdown, where by_step names only the phases this part ran and total sums them, leaving out the shape_* stages nested inside shape. Excludes the shared, once-per-request steps (e.g. extract), which diagnostics.timing_ms.by_step carries once for the whole request; distinct too from diagnostics.timing_ms.total, the whole request's wall-clock elapsed time. */
      timing_ms?: components["schemas"]["Timing"] | null;
      /**
       * Rendered Sentence
       * @description a human-readable string. For candidates, a header naming how many readings there are ('3 readings.'), then each shown candidate's heading and a byline led by the source and span that set it apart; for no_data, a heading in the same claim form naming the entity, measure, and counterpart that were checked. Either ends with the text of this part's departures, in order, and a candidates part's then closes with its assumptions clause. For a definite part this stays null or omitted: the confirmation sentence (heading and byline) lives at spec.resolved.rendered_sentence, and its departures reach the envelope's composed sentence.
       */
      rendered_sentence?: string | null;
      /**
       * Sentence Plan
       * @description the ordered token form of rendered_sentence, present whenever it is. For a definite part this stays null or omitted. spec.resolved.sentence_plan carries the confirmation sentence's own plan instead.
       */
      sentence_plan?: components["schemas"]["SentenceToken"][] | null;
      /** @description the ParsedPart that reproduces this part's own resolution inputs -- the same entities, resolved time window, unit text, and source text the engine actually used to resolve this one leg -- so a client holding this part alone can copy it straight into a fresh ParsedInput.parts entry and re-resolve it faithfully, without flattening it into the whole query's variable_text the way variable_text alone would. Canonical, not verbatim: for a raw_text part, time_text is the equivalent phrase this door's own time grammar recognises (e.g. '2015 to 2020'), not the user's original words, since the engine's date extraction keeps only the structured window and discards the phrasing. Null whenever this part has no faithful echo to give. On a dataset_resubmit entry's identity/candidates/placeholder kinds, which post an identity or stub rather than a phrase and have no per-part resolution inputs to echo -- a dataset_resubmit parsed entry, genuinely re-resolved from its own posted ParsedPart, carries a real one like any parsed-door part. Also null when this leg's entity was bound to a directional role axis (origin/destination) and no door-supplied role named that axis, since an echo without the axis would resubmit the request with that entity reversed. Also null when one of this leg's own inputs does not fit ParsedPart's own field caps, since a truncated echo would misrepresent what was actually resolved. */
      restatement?: components["schemas"]["ParsedPart"] | null;
      /**
       * Operations
       * @description the operations the question asks for over this part's data, in query order; the engine echoes them onto the part it resolves. Empty when the question asks for none
       */
      operations?: components["schemas"]["Operation"][];
      /**
       * Departures
       * @description every way this part's answer differs from what its request asked, ordered by how much each changes the number: closest_match, measure_not_applied, operation_not_applied, breakdown_not_applied, entity_unavailable, year_unavailable, modelled_values, group_read_as_members, direction_discarded, direction_inferred, scope_limited. [] when the answer is what was asked. A client that renders its own sentence reads them here; each one's text also closes the sentence that carries this part (see Departure.text). A warning on the same part reports run health and stays separate
       */
      departures?: components["schemas"]["Departure"][];
      /**
       * Assumptions
       * @description every value the engine filled that the request did not ask for, in clause order. Declared defaults come first, in the order of the Spec's trace.slot_filters, then open roles, then the place scope. A declared default is a slot the request left open that its code system's or shape's declared default fixed, named by the bound code's full label. An open role is a flow role no request word asked for, read across every entity on it with data. It is either a role the role scope default filled (resolved.scope on that axis), whatever its member count, served as one series per member where the shape declares the role, or a role the heading states with no entity of its own ('from 164 providers', 'owed to all creditors'), served as the total over its members. A role the identity binds in entities or lists in open_roles, that one of the part's operations runs over ('top 5 donors'), or that the request's words asked every member of ('all donors'), is asked. The place scope is a request that named no place, read across every place with data. Every door fills assumptions. A definite part reads them from its Spec, a candidates part carries the items every list in CandidatesPart.reading_assumptions holds alike, text included, and no_data and unsupported parts carry []. A dataset_resubmit identity entry posts every slot bound, so its part states the items of the entry's assumptions echo that still hold (see ResubmitIdentityEntry.assumptions), and a candidates entry reads each reading with its candidate's echo (see ResubmitCandidate.assumptions). The sentence that carries this part closes with them as one segment='assumption' clause ('Assumed: official development assistance; every provider.'), after its departures. [] when the answer fills nothing
       */
      assumptions?: components["schemas"]["Assumption"][];
      /**
       * @description valid, understood, not supported (enum property replaced by openapi-typescript)
       * @enum {string}
       */
      status: "unsupported";
      /** @description the reason and definition */
      unsupported: components["schemas"]["Unsupported"];
    };
    /**
     * Usage
     * @description `api_access`/`python` are `None` for every source -- an absent
     *     member, not a stand-in object -- named in `gaps` alongside
     *     every other absent member. Built by `graph_api.usage.usage_document`,
     *     never constructed inline at a call site.
     */
    Usage: {
      api_access: components["schemas"]["UsageEntry"] | null;
      python: components["schemas"]["UsageEntry"] | null;
    };
    /**
     * UsageEntry
     * @description The shape a non-null `Usage.api_access`/`.python` entry takes. Both
     *     of its own members are always `None`, and no dcid produces an entry at
     *     all -- `graph_api.usage`'s own docstring is the record of why.
     */
    UsageEntry: {
      /** Documentation Url */
      documentation_url: string | null;
      /** Code */
      code: string | null;
    };
    /**
     * GraphVariableDefinition
     * @description What a variable measures, part by part.
     *
     *     `constraints` are ordered by property dcid: the code index holds a variable's constraints
     *     as a mapping with no declared order, and the graph's `constraintProperties` arc has none.
     */
    VariableDefinition: {
      /** @description the populationType; null when the variable declares none */
      population_type: components["schemas"]["NodeRef"] | null;
      /** @description the measuredProperty; null when the variable declares none */
      measured_property: components["schemas"]["NodeRef"] | null;
      /** @description the statType; null when the variable declares none or its read failed */
      stat_type: components["schemas"]["NodeRef"] | null;
      /** @description the measure the code index names; null when it names none */
      measure: components["schemas"]["Measure"] | null;
      /**
       * Roles
       * @description the entity roles the variable's observations carry, from its declared observationProperties, defaulting to observationAbout when it declares none
       */
      roles: string[];
      /**
       * Source Indicator Codes
       * @description the sourceIndicatorCode arc's values: the codes naming the source series, as the publisher codes it (IMF WEO GDP carries NGDP and NGDPD); empty when it has none
       */
      source_indicator_codes: string[];
      /**
       * Constraints
       * @description each constraint the measure does not state, ordered by property dcid; null when the read of a variable's constraint values failed
       */
      constraints: components["schemas"]["Constraint"][] | null;
      /**
       * Definitions
       * @description the graph's prose per part: the variable's own, then the measure's, then each constraint value's, in constraint order; a part with none is left out
       */
      definitions: components["schemas"]["DefinitionText"][];
    };
    /**
     * VariableSide
     * @description One side of a composed unit that counts a variable in place of a unit, such as the
     *     population in a per-capita denominator. `stat_var` is the variable's bare dcid.
     */
    VariableSide: {
      /** Stat Var */
      stat_var: string;
      /** Label */
      label?: string;
      /**
       * At Mint
       * @constant
       */
      at_mint?: true;
    };
    /** VaryingColumnModel */
    VaryingColumnModel: {
      /** Column */
      column: string;
      /** Distinct */
      distinct: number;
    };
    /**
     * VersionHistoryEntry
     * @description One release of the pipeline's changelog, newest first.
     */
    VersionHistoryEntry: {
      /**
       * Date
       * @description the release date, YYYY-MM-DD
       */
      date: string;
      /**
       * Title
       * @description the release title, plain text
       */
      title: string;
      /**
       * Changes
       * @description every change, group by group in order
       */
      changes: components["schemas"]["ChangeEntry"][];
    };
    /**
     * VersionRef
     * @description A Datasets version: a `spec_` id with its `cv_` content version, or an `ops_` id with
     *     its `ocv_` content version, and optionally the words for it.
     */
    VersionRef: {
      /** Id */
      id: string;
      /** Content Version */
      content_version: string;
      /** Label */
      label?: string;
      /**
       * At Mint
       * @constant
       */
      at_mint?: true;
    };
    /**
     * Warning
     * @description A run-health signal. Note: this name shadows the Python builtin Warning.
     *
     *     Only `observations_series_truncated`, `elected_shape_no_data` and `un_system_unavailable`
     *     set `params`. A `None` `params` is left out of every dump, so other codes' warnings stay
     *     exactly `{code, severity, message}` plus `spec_id` where one applies.
     */
    Warning: {
      /**
       * Code
       * @description stable machine code from the platform registry, lower snake_case, e.g. date_coverage_partial, binding_folded
       */
      code: string;
      /**
       * Severity
       * @description the severity level
       */
      severity: ("info" | "warn" | "degraded") | (string & {});
      /**
       * Message
       * @description human-readable explanation of the warning
       */
      message: string;
      /**
       * Spec Id
       * @description the spec_id this warning attaches to, when it concerns one returned spec specifically; omitted otherwise
       */
      spec_id?: string | null;
      /**
       * Params
       * @description the counts and labels the message states, for a client to compose its own text. observations_series_truncated: {shown, total, order}, the series shown, the confirmed series behind them, and how the shown series were chosen: 'ranked' (the most recent and largest) or 'fixed' (a selection made before values were read, not ranked by value). elected_shape_no_data: {no_data, elected}, the labels of the readings with no data and of the readings answered instead. un_system_unavailable: {places, variables, variable_labels}, the place dcids the UN front door refused, the variables of the UN reads that failed, each empty when none, and each variable's graph name, in variables order, '' where the graph holds none; a warning without params says the UN search itself was unavailable. Omitted for every other code
       */
      params?: {
        [key: string]: number | string | string[];
      } | null;
    };
    /**
     * WarningModel
     * @description One manifest warning. Only `stat_vars_summed` sets the three structured fields. A `None`
     *     field is left out of every dump, so other codes' warnings, on the wire and in stored version
     *     bodies, stay exactly `{code, severity, message}`.
     */
    WarningModel: {
      /** Code */
      code: string;
      /** Severity */
      severity: string;
      /** Message */
      message: string;
      /**
       * Contributing Member Count
       * @description stat_vars_summed only: how many StatVars with rows were summed into the collapsed frame's one series
       */
      contributing_member_count?: number | null;
      /**
       * Stat Var Ref
       * @description stat_vars_summed only: the family ref, `dcid:<spec_id>`, that the collapsed frame's `stat_var` column carries
       */
      stat_var_ref?: string | null;
      /**
       * Stat Var Label
       * @description stat_vars_summed only: the family's label, the string the presentation door gives `stat_var_ref` on a chart (`code_index.labels.family_label` over the spec identity: its measure partition label, then its bound slots' labels); absent when neither has a label
       */
      stat_var_label?: string | null;
    };
    /** WindowAll */
    WindowAll: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "all";
    };
    /** WindowLatest */
    WindowLatest: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "latest";
    };
    /**
     * WindowModel
     * @description A period window, its two boundary labels at the frame's grain.
     */
    WindowModel: {
      /**
       * Start
       * @description this window's own start period label
       */
      start: string;
      /**
       * End
       * @description this window's own end period label
       */
      end: string;
    };
    /** WindowRange */
    WindowRange: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      kind: "range";
      /** Start Year */
      start_year?: number | null;
      /** End Year */
      end_year?: number | null;
    };
    /**
     * WriteReplyResponse
     * @description `PATCH /api/presentation/components/{component_id}`'s 200 body. A
     *     create reply carries this same shape plus `affordance`
     *     (`CreateReplyResponse` below). A revise reply carries no `affordance`
     *     key.
     */
    WriteReplyResponse: {
      /**
       * Component Id
       * @description the revised component's own id
       */
      component_id: string;
      /**
       * Revision
       * @description the revision this write minted, or the head left unchanged
       */
      revision: number;
      /**
       * Catalog Version
       * @description the catalogue release this revision minted under
       */
      catalog_version: string;
      /**
       * Composition Id
       * @description the composition this component belongs to, null outside one
       */
      composition_id: string | null;
      /**
       * Composition Revision
       * @description the composition's current head revision, null outside one
       */
      composition_revision: number | null;
      /**
       * Changed
       * @description the patch's own fields, each paired with its prior and new value. This array is empty when the write was a no-op.
       */
      changed: components["schemas"]["ChangedFieldModel"][];
      /** @description the closed, token-capped fact summary this revision reports */
      fact_summary: components["schemas"]["FactSummaryModel"];
      /**
       * Resolved Payload
       * @description the revision's stored resolved payload, verbatim: the catalogue envelope {schema_version, catalog_version, component_id, revision, provenance, component}, validated against the catalogue release's envelope schema (dfo-spec-kit envelope.schema.json) when minted. GET /api/presentation/release serves the pinned release's envelope_schema and the component_schemas its component field $refs by $id; every payload this door serves carries that pinned catalog_version.
       */
      resolved_payload: {
        [key: string]: unknown;
      };
    };
    /**
     * YearCoverage
     * @description What the coverage index counts in one calendar year over the series a frame's
     *     requests read: the series holding an observation in it and, under `role_counts`, the
     *     distinct members of each role those series carry. A role is keyed by the `label` of its
     *     entry in the frame's `coverage.dimensions`.
     */
    YearCoverage: {
      /** Year */
      year: number;
      /** Series */
      series: number;
      /** Role Counts */
      role_counts: {
        [key: string]: number;
      };
    };
    /** YearRange */
    YearRange: {
      /** First */
      first: number;
      /** Last */
      last: number;
    };
    /**
     * Capabilities
     * @description The full `GET /api/datasets/capabilities` document.
     */
    datasets_api__capabilities__Capabilities: {
      /**
       * Capability Version
       * @description deterministic token identifying this capability set; distinct from schema_version and shared verbatim with problem-details bodies
       */
      capability_version: string;
      /**
       * Build
       * @description the commit sha the image was built from, the same value the x-dfo-commit response header carries
       */
      build: string;
      /**
       * Schema Versions
       * @description schema_version values this deployment accepts
       */
      schema_versions: number[];
      /**
       * Operation Envelope Active
       * @description whether POST mint/definition doors can answer 202 with a pollable operation
       */
      operation_envelope_active: boolean;
      /**
       * Input Kinds
       * @description per-kind mint-door liveness
       */
      input_kinds: components["schemas"]["CapabilityKind"][];
      /**
       * Formats
       * @description per-format rendering liveness
       */
      formats: components["schemas"]["CapabilityFormat"][];
      /**
       * Bundle Active
       * @description whether a mint/definition response can deliver a Frictionless Data Package
       */
      bundle_active: boolean;
      /**
       * Recipe Classes
       * @description the conversion recipes this deployment can apply, the ConversionRecipe members from materialise.recipe_bodies.RECIPE_CLASSES
       */
      recipe_classes: string[];
      /**
       * Programmatic Pinning
       * @description whether a caller other than the site's own share/publish flow may pin
       */
      programmatic_pinning: boolean;
      /**
       * Enrichment Fields
       * @description enrichment field names this deployment enables. A live token qualifies one as {entity_column}_{field} on the columns option. party_kind is a party's kind (party, total, residual) from the code index's declaration for it. Long output writes {role}_party_kind beside {role}_label for every role on a flow axis without a token; a bare party_kind token requests it for every role on a flow axis the table has. party_kind qualifies no subject role, so observationAbout_party_kind refuses column_unknown. A party the index does not list gets an empty cell and an enrichment_unavailable warning
       */
      enrichment_fields: string[];
      /**
       * Decode Code Systems
       * @description code systems the packaged code index declares, sorted. Decoding is always on when a rendered frame's StatVars declare one of these -- there is no opt-out. Long output writes each as a {code_system} column (the StatVar's code in that system) and a {code_system}_label column (its label); pivot output, frame-layout output (layout: "frame"), groupby.by and the columns option name it stat_var_{code_system}, the label column
       */
      decode_code_systems: string[];
      /**
       * Default Facet Policies Live
       * @description whether the graph declares its own per-StatVar/per-source default facet policy; false does not mean an unbound axis refuses -- see default_facet_policy
       */
      default_facet_policies_live: boolean;
      /** @description this deployment's own default-facet policy, consulted for an unbound axis once the graph declares none; null if this deployment enforces no fallback of its own */
      default_facet_policy: components["schemas"]["DeploymentFacetPolicy"] | null;
      /**
       * Summability Declarations Live
       * @description whether the graph declares its own per-axis summability; true unconditionally, the same way decode carries no separate liveness gate
       */
      summability_declarations_live: boolean;
      /**
       * Summable Axes
       * @description code systems the packaged code index declares summable, sorted -- the axes a groupby request may name in `by` to keep, with every other declared-summable axis this frame decoded collapsed into it
       */
      summable_axes: string[];
      /**
       * Groupby Level Axes
       * @description code systems the packaged code index declares summable, hierarchical, and disjoint from children (a parent-coded record excludes its children's), sorted. These are the axes groupby.levels accepts, each rolled up to one depth of its parent chain (0 = root codes) before the sum
       */
      groupby_level_axes: string[];
      /** @description published input limits and response caps */
      caps: components["schemas"]["datasets_api__capabilities__CapabilityCaps"];
      /** @description provenance for the packaged code index */
      code_index: components["schemas"]["datasets_api__capabilities__CodeIndexStamp"];
    };
    /**
     * CapabilityCaps
     * @description Published input limits and response caps, one field per enforced
     *     constant.
     */
    datasets_api__capabilities__CapabilityCaps: {
      /**
       * Definition Candidate Cap
       * @description the reverse-arc page a described-arm definition's member walk reads first; a page that fills it without a confirmed root sends the walk to the whole filtered set, up to definition_subject_ceiling
       */
      definition_candidate_cap: number;
      /**
       * Definition Subject Ceiling
       * @description ceiling on the whole filtered reverse-arc set a described-arm definition's member walk reads when its first page cannot settle the family; a larger set refuses over_ceiling (candidate_window), and a walk past its read deadline answers timeout (504, retryable)
       */
      definition_subject_ceiling: number;
      /**
       * Sync Budget Rows
       * @description sync budget: a mint/definition request whose own coverage estimate (series_coverage.index.CoverageIndex.estimate) stays at or under this many rows, and at or under sync_budget_requests SDMX requests, runs inline
       */
      sync_budget_rows: number;
      /**
       * Sync Budget Requests
       * @description the SDMX request half of the sync budget -- see sync_budget_rows
       */
      sync_budget_requests: number;
      /**
       * Async Max Rows
       * @description async ceiling: an over-sync-budget mint/definition request whose own coverage estimate (series_coverage.index.CoverageIndex.estimate) stays at or under this many rows, and at or under async_max_requests SDMX requests, is recorded as an operation and answered 202; over either, it is refused over_ceiling (ceiling_kind operation_rows) before any operation is recorded
       */
      async_max_rows: number;
      /**
       * Async Max Requests
       * @description the SDMX request half of the async ceiling -- see async_max_rows; crossing this one alone refuses over_ceiling with ceiling_kind operation_requests
       */
      async_max_requests: number;
      /**
       * Pivot Max Output Cells
       * @description cap on a pivot's total output cell count (rows x columns) before pivot_over_cell_cap
       */
      pivot_max_output_cells: number;
      /**
       * Operation Retention Days
       * @description how long a terminal (done/failed) operation stays guaranteed pollable (contract, 'The operation envelope'). A done operation's own manifest is guaranteed servable for exactly this long, since it is bounded by the same working-tier artifact clock every other mint/definition response is (dataset_store.snapshot.WORKING_TIER_RETENTION) -- pinning it extends that the same way pinning any other snapshot does. A daily maintenance job deletes done and failed operations last updated more than this many days ago, so a poll after that answers operation_not_found
       */
      operation_retention_days: number;
    };
    /**
     * CodeIndexStamp
     * @description Provenance for the packaged code index this deployment reads: which export, and how many codes it carries per code
     *     system. Published so a caller can compare `content_hash` across two
     *     responses (two mints, say) and tell whether they
     *     resolved against the same index.
     */
    datasets_api__capabilities__CodeIndexStamp: {
      /**
       * Content Hash
       * @description digest over the exported rows; equal across two exports of the same graph state
       */
      content_hash: string;
      /**
       * Exported At
       * @description when the packaged index was exported from the graph
       */
      exported_at: string;
      /**
       * Code Counts
       * @description code count per code system this index carries -- keyed by whatever code systems the index declares, not a fixed set of named fields
       */
      code_counts: {
        [key: string]: number;
      };
    };
    /**
     * GraphCapabilities
     * @description The full `GET /api/graph/capabilities` document.
     */
    graph_api__capabilities__Capabilities: {
      /**
       * Capability Version
       * @description deterministic token identifying this capability set; distinct from schema_version and shared verbatim with problem-details bodies
       */
      capability_version: string;
      /**
       * Build
       * @description the commit sha the running image was built from
       */
      build: string;
      /** @description the data builds this process serves; they change without a deploy and leave capability_version unchanged */
      data_builds: components["schemas"]["DataBuilds"];
      /**
       * Doors
       * @description per-door liveness
       */
      doors: components["schemas"]["graph_api__capabilities__CapabilityDoor"][];
      /**
       * Kinds
       * @description the closed kind list resolve and the node route classify entities by
       */
      kinds: (
        | (
            | "country"
            | "continent"
            | "subregion"
            | "continental_union"
            | "place_other"
            | "aggregate"
            | "organisation"
            | "group"
            | "stat_var"
            | "code_system"
            | "code"
            | "unit"
            | "source"
            | "dataset"
            | "provenance"
            | "other"
          )
        | (string & {})
      )[];
      /**
       * Resolve Kinds
       * @description the kinds POST /api/graph/resolve accepts in its kinds filter
       */
      resolve_kinds: (
        | (
            | "country"
            | "continent"
            | "subregion"
            | "continental_union"
            | "place_other"
            | "aggregate"
            | "organisation"
            | "group"
            | "stat_var"
            | "code_system"
            | "code"
            | "unit"
            | "source"
            | "dataset"
            | "provenance"
            | "other"
          )
        | (string & {})
      )[];
      /**
       * Recipe Classes
       * @description live unit-conversion recipe classes; empty, no conversion machinery
       */
      recipe_classes: string[];
      /**
       * Node Shape Gaps
       * @description member paths the node door names in gaps on every node that carries the member, whatever the node
       */
      node_shape_gaps: string[];
      /**
       * Source Document Gaps
       * @description member paths the sources door's own documentation document always empties, whatever the source -- materialise.provenance_doc.UNCONDITIONAL_GAPS
       */
      source_document_gaps: string[];
      /**
       * Source Catalogue Curated
       * @description whether GET /api/graph/sources serves the real curated allowlist rather than a sample standing in for one
       */
      source_catalogue_curated: boolean;
      /** @description published input limits */
      caps: components["schemas"]["graph_api__capabilities__CapabilityCaps"];
    };
    /**
     * GraphCapabilityCaps
     * @description Published input limits, one field per enforced constant.
     */
    graph_api__capabilities__CapabilityCaps: {
      /**
       * Node Pool Size
       * @description the bounded DCP-read executor's own worker count, shared by resolve confirmation reads and every node read
       */
      node_pool_size: number;
      /**
       * Resolve Timeout Seconds
       * @description ceiling on how long a client waits for POST /api/graph/resolve before a timeout refusal
       */
      resolve_timeout_seconds: number;
      /**
       * Node Timeout Seconds
       * @description ceiling on how long a client waits for GET /api/graph/node/{dcid}, POST /api/graph/nodes, or GET /api/graph/documentation/{dcid} before a timeout refusal; GET /api/graph/node/{dcid}/members bounds its graph reads by it, and a label or profile read it cuts short leaves a gap
       */
      node_timeout_seconds: number;
      /**
       * Max Dcid Chars
       * @description ceiling on the length of the dcid path parameter of GET /api/graph/node/{dcid} and GET /api/graph/documentation/{dcid}, and of each dcid POST /api/graph/nodes takes; a longer value is refused 400 request_invalid
       */
      max_dcid_chars: number;
      /**
       * Max Node Batch Dcids
       * @description the most dcids one POST /api/graph/nodes request names; a longer list is refused 400 request_invalid
       */
      max_node_batch_dcids: number;
    };
    /**
     * CapabilityDoor
     * @description One door's liveness in this deployment.
     */
    graph_api__capabilities__CapabilityDoor: {
      /**
       * Name
       * @description resolve, node, members, roots, sources, or schema
       */
      name: string;
      /**
       * Live
       * @description whether this deployment serves this door
       */
      live: boolean;
    };
    /**
     * GraphDataCommonsRef
     * @description The Data Commons that serves a fact. `id` is the wire enum; `label` its display name.
     */
    graph_api__origin_models__DataCommonsRef: {
      /** Id */
      id: ("dfo" | "base" | "un_system") | (string & {});
      /** Label */
      label: string;
    };
    /**
     * GraphResolveRequest
     * @description `texts`: 1 to 25 strings resolved as one batch. Each is stripped of surrounding
     *     whitespace and must then be 1 to 200 characters.
     *
     *     `kinds` admits only candidates of those kinds. It defaults to `DEFAULT_RESOLVE_KINDS`, so a
     *     request that omits it equals one naming those eight. `code` searches the code index's labels
     *     and synonyms, and `code_system` narrows codes to one system's graph id
     *     (`CRSPurposeCodeEnum`); naming `code_system` without `code` in `kinds` is refused at
     *     `/code_system`. `expand: ["members"]` inlines a group's or region's members.
     */
    graph_api__resolve_models__ResolveRequest: {
      /** Texts */
      texts: string[];
      /**
       * Kinds
       * @default [
       *       "country",
       *       "continent",
       *       "subregion",
       *       "continental_union",
       *       "organisation",
       *       "aggregate",
       *       "place_other",
       *       "group"
       *     ]
       */
      kinds?: (
        | (
            | "country"
            | "continent"
            | "subregion"
            | "continental_union"
            | "organisation"
            | "aggregate"
            | "place_other"
            | "group"
            | "code"
            | "other"
          )
        | (string & {})
      )[];
      /** Code System */
      code_system?: string | null;
      /**
       * Expand
       * @default []
       */
      expand?: "members"[];
    };
    /**
     * SearchCapabilities
     * @description The full GET /api/search/capabilities document.
     */
    search__engine__capabilities__Capabilities: {
      /**
       * Capability Version
       * @description deterministic token identifying this capability set; distinct from schema_version and shared verbatim with problem-details bodies and resolved.trace
       */
      capability_version: string;
      /**
       * Build
       * @description the commit sha the running image was built from, the same value the x-dfo-commit response header carries
       */
      build: string;
      /**
       * Axes
       * @description valid SlotKey.axis values. Contract-frozen (a schema_version-locked enum, search.models.Axis), republished here for convenience so a caller need not parse the full JSON Schema to enumerate them
       */
      axes: string[];
      /**
       * Facet Axes
       * @description valid facet-axis names (BaseIdentity.facets / ResubmitIdentityPayload.identity.facets keys), distinct from axes above -- search.models.FacetAxis, a separate vocabulary from SlotKey.axis. Schema-locked like axes: this vocabulary changes only with a schema_version bump, so unlike recipe_classes or the caps below, it is NOT one of capability_version's hash inputs -- schema_version already covers it
       */
      facet_axes: string[];
      /**
       * Recipe Classes
       * @description the conversion recipe members this deployment applies (resolved.observations.series[].conversion.recipe_id), the sorted keys of materialise.recipe_bodies.RECIPE_BODIES, so the list and the applied recipes cannot drift apart
       */
      recipe_classes: string[];
      /**
       * Doors
       * @description per-door liveness
       */
      doors: components["schemas"]["search__engine__capabilities__CapabilityDoor"][];
      /**
       * Default Policies
       * @description declared default policies and whether each is live
       */
      default_policies: components["schemas"]["CapabilityDefaultPolicy"][];
      /** @description published caps and input limits */
      caps: components["schemas"]["search__engine__capabilities__CapabilityCaps"];
      /** @description provenance for the packaged code index */
      code_index: components["schemas"]["search__engine__capabilities__CodeIndexStamp"];
    };
    /**
     * SearchCapabilityCaps
     * @description Published caps and input limits, one field per enforced constant.
     */
    search__engine__capabilities__CapabilityCaps: {
      /**
       * Max Query Chars
       * @description raw_text.query character ceiling; over this refuses query_too_long
       */
      max_query_chars: number;
      /**
       * Max Candidates
       * @description server ceiling enforced two ways: a resolved candidate set is clamped to this length, while a dataset_resubmit candidates entry posting more candidates than this refuses request_invalid at /input/entries/{i}/candidates rather than being clamped
       */
      max_candidates: number;
      /**
       * Max Variables
       * @description variables resolved per query before the rest are dropped with variables_clamped
       */
      max_variables: number;
      /**
       * Obs Preview Points
       * @description latest points per series carried once observation preview mode applies
       */
      obs_preview_points: number;
      /**
       * Obs Inline Max
       * @description total observation points above which every series switches to preview mode
       */
      obs_inline_max: number;
      /**
       * Role Bulk Rank Max Rows
       * @description rows a role-bearing bulk preview may read whole and rank, most recent and largest first; above this it shows a fixed selection, and its observations_series_truncated warning says so with params.order
       */
      role_bulk_rank_max_rows: number;
      /**
       * Max Options
       * @description ceiling on the options door's candidate lists before truncation: graph-enumerated observationAbout candidates, and the sdmx-derived provider and recipient candidate lists alike
       */
      max_options: number;
      /**
       * Max Parts
       * @description parsed.parts list length ceiling; a request over this refuses request_invalid. Distinct from max_variables: raw_text clamps an over-limit extraction with a variables_clamped warning and keeps resolving, while parsed enforces this as a hard schema cap
       */
      max_parts: number;
      /**
       * Max Part Entities
       * @description parsed part entities list length ceiling; over this refuses request_invalid
       */
      max_part_entities: number;
      /**
       * Max Variable Text Chars
       * @description parsed part variable_text character ceiling; over this refuses request_invalid
       */
      max_variable_text_chars: number;
      /**
       * Max Entity Text Chars
       * @description parsed entity text character ceiling; over this refuses request_invalid
       */
      max_entity_text_chars: number;
      /**
       * Max Role Text Chars
       * @description parsed entity role_text character ceiling; over this refuses request_invalid
       */
      max_role_text_chars: number;
      /**
       * Max Time Text Chars
       * @description parsed part time_text character ceiling; over this refuses request_invalid
       */
      max_time_text_chars: number;
      /**
       * Max Unit Text Chars
       * @description parsed part unit_text character ceiling; over this refuses request_invalid
       */
      max_unit_text_chars: number;
      /**
       * Max Source Text Chars
       * @description parsed part source_text character ceiling; over this refuses request_invalid
       */
      max_source_text_chars: number;
      /**
       * Region Max Members
       * @description ceiling on the alt-shape population region resolution pre-warms observation facets for; over this, the pre-warm is skipped rather than refused
       */
      region_max_members: number;
      /**
       * Scope Min Year
       * @description earliest year role-scope discovery will request; an open-started requested window floors here rather than reaching further back
       */
      scope_min_year: number;
      /**
       * Scope Max Window Years
       * @description ceiling on a requested window's year span for a role-bearing read, named or discovered; over this refuses scope_too_broad
       */
      scope_max_window_years: number;
    };
    /**
     * SearchCapabilityDoor
     * @description One door's liveness in this deployment.
     */
    search__engine__capabilities__CapabilityDoor: {
      /**
       * Name
       * @description raw_text, parsed, dataset_resubmit, or options
       */
      name: string;
      /**
       * Live
       * @description whether this deployment serves this door
       */
      live: boolean;
    };
    /**
     * SearchCodeIndexStamp
     * @description Provenance for the packaged code index this deployment's constraint
     *     resolution reads: which export, and how many codes it carries per code
     *     system. Not one of `capability_version`'s hash inputs (see
     *     `search.engine.config.settings().capability_version`, computed from static
     *     config constants alone) -- published here as its own field so a caller
     *     can compare `content_hash` across two responses (e.g. a preview and a
     *     later download) and tell whether they resolved against the same index.
     */
    search__engine__capabilities__CodeIndexStamp: {
      /**
       * Content Hash
       * @description digest over the exported rows; equal across two exports of the same graph state
       */
      content_hash: string;
      /**
       * Exported At
       * @description when the packaged index was exported from the graph
       */
      exported_at: string;
      /**
       * Code Counts
       * @description code count per code system this index carries -- keyed by whatever code systems the index declares, not a fixed set of named fields
       */
      code_counts: {
        [key: string]: number;
      };
    };
    /**
     * DataCommonsRef
     * @description The Data Commons a provenance's data comes from.
     */
    search__models__grammar__DataCommonsRef: {
      /**
       * Id
       * @description 'dfo', 'base' or 'un_system'
       */
      id: ("dfo" | "base" | "un_system") | (string & {});
      /**
       * Label
       * @description the Data Commons' display name: Development Finance Observatory, Data Commons by Google, or UN System Data Commons
       */
      label: string;
    };
    /**
     * ResolveRequest
     * @description The single request type for the Search resolve endpoint.
     */
    search__models__request__ResolveRequest: {
      /**
       * Schema Version
       * @description contract version the caller targets
       * @default 1
       * @constant
       */
      schema_version?: 1;
      /**
       * Input
       * @description tagged union; kind discriminates
       */
      input:
        | components["schemas"]["RawTextInput"]
        | components["schemas"]["ParsedInput"]
        | components["schemas"]["DatasetResubmitInput"];
      /** @description optional resolution options */
      response_options?: components["schemas"]["ResolveOptions"] | null;
    };
    /**
     * ProblemDetails
     * @description RFC 9457 problem-details body for every non-2xx response.
     *
     *     Standard base fields (type, title, status, detail) plus the platform
     *     registry's stable extensions (code, pointer, alternatives, truncated,
     *     issues, constraint_id, trace_id, capability_version, retryable). Optional
     *     members (pointer, alternatives, truncated, issues, constraint_id) are
     *     omitted from the wire body when absent -- callers should serialize with
     *     ``model_dump(mode="json", exclude_none=True)``, which ``to_json`` does.
     */
    ProblemDetails: {
      /**
       * Type
       * @description a relative URI reference to the code's registry entry
       */
      type: string;
      /**
       * Title
       * @description short, human-readable summary of the problem type
       */
      title: string;
      /**
       * Status
       * @description the HTTP status code
       */
      status: number;
      /**
       * Detail
       * @description human-readable explanation of this occurrence
       */
      detail: string;
      /**
       * Code
       * @description the stable machine-readable code from the platform registry
       */
      code: string;
      /**
       * Pointer
       * @description a JSON Pointer into the request body naming the field at fault
       * @default null
       */
      pointer?: string | null;
      /**
       * Alternatives
       * @description values that would satisfy this request, when known
       * @default null
       */
      alternatives?: components["schemas"]["Alternative"][] | null;
      /**
       * Truncated
       * @description present iff alternatives is present; whether the cap cut items
       * @default null
       */
      truncated?: boolean | null;
      /**
       * Issues
       * @description one entry per failure, for a refusal code that reports several at once
       * @default null
       */
      issues?: components["schemas"]["ProblemIssue"][] | null;
      /**
       * @description why the refusal fired, for the two codes that carry one -- omitted otherwise
       * @default null
       */
      cause?: components["schemas"]["Cause"] | null;
      /**
       * Constraint Id
       * @description the machine-keyable id of the constraint this refusal violates, when known
       * @default null
       */
      constraint_id?: string | null;
      /**
       * Ceiling Kind
       * @description for over_ceiling: which ceiling was crossed -- member_cardinality, candidate_window, rows, or bytes
       * @default null
       */
      ceiling_kind?: string | null;
      /**
       * Count
       * @description for over_ceiling: the observed count, in ceiling_kind's own unit, that crossed cap -- omitted only when the count itself is unmeasured, never when it is merely large. Under candidate_window it is the candidates the read actually returned, at most cap: a read that fills its window returns exactly cap, and one that stops early on a surviving continuation token returns fewer
       * @default null
       */
      count?: number | null;
      /**
       * Cap
       * @description for over_ceiling: the ceiling, in ceiling_kind's own unit, that count crossed. Under candidate_window it is the candidate window the read was allowed
       * @default null
       */
      cap?: number | null;
      /**
       * Trace Id
       * @description this request's trace_id, shared with diagnostics and the SSE done event
       */
      trace_id: string;
      /**
       * Capability Version
       * @description the deployment capability version that produced this response
       */
      capability_version: string;
      /**
       * Retryable
       * @description whether retrying the same request might succeed
       */
      retryable: boolean;
    };
    /**
     * Alternative
     * @description One value that would satisfy the request in place of what was posted.
     */
    Alternative: {
      /**
       * Ref
       * @description the alternative's own reference (e.g. a code or id)
       */
      ref: string;
      /**
       * Label
       * @description the alternative's human-readable label
       */
      label: string;
    };
    /**
     * ProblemIssue
     * @description One failure among several a single refusal can report at once.
     *
     *     Each issue carries its own pointer, the member or axis it concerns, its
     *     own alternatives and truncation flag, and the machine code and message of
     *     the failure it stands for -- mirroring the same-named top-level
     *     ProblemDetails fields, but scoped to one entry among many.
     *     Fields default to None and are omitted from the wire body when absent
     *     (the envelope's omit-when-absent rule).
     */
    ProblemIssue: {
      /**
       * Pointer
       * @description a JSON Pointer into the request body naming the field at fault
       * @default null
       */
      pointer?: string | null;
      /**
       * Member
       * @description the member this issue concerns, when the refusal is member-scoped
       * @default null
       */
      member?: string | null;
      /**
       * Axis
       * @description the axis this issue concerns, when the refusal is axis-scoped
       * @default null
       */
      axis?: string | null;
      /**
       * Alternatives
       * @description values that would satisfy this issue, when known
       * @default null
       */
      alternatives?: components["schemas"]["Alternative"][] | null;
      /**
       * Truncated
       * @description present iff alternatives is present; whether the cap cut items
       * @default null
       */
      truncated?: boolean | null;
      /**
       * Code
       * @description the stable machine-readable code of the failure this issue stands for
       * @default null
       */
      code?: string | null;
      /**
       * Detail
       * @description human-readable explanation of the failure this issue stands for
       * @default null
       */
      detail?: string | null;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  search_resolve: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["search__models__request__ResolveRequest"];
      };
    };
    responses: {
      /** @description A buffered ResolveResponse JSON document or, with Accept: text/event-stream, progressive Server-Sent Events. Successful streams emit a complete response event and end with done; pipeline failures end with error and emit neither response nor done. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json":
            | components["schemas"]["Resolution"]
            | components["schemas"]["CatalogueAnswer"]
            | components["schemas"]["DeclinedAnswer"];
          "text/event-stream": string;
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  search_list_options: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["OptionsRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OptionsResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  search_get_health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  search_get_schema: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @constant */
            schema_version: 1;
            /** @description JSON Schema for request */
            request: Record<string, never>;
            /** @description JSON Schema for response */
            response: Record<string, never>;
            capabilities: string;
          };
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  search_get_capabilities: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["search__engine__capabilities__Capabilities"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  search_get_catalogue: {
    parameters: {
      query?: {
        /** @description a country dcid; scopes the counts and examples to that country */
        place?: string | null;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CatalogueResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_schema: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @constant */
            schema_version: 1;
            /** @description JSON Schema for mint_request */
            mint_request: Record<string, never>;
            /** @description JSON Schema for register_request */
            register_request: Record<string, never>;
            /** @description JSON Schema for register_response */
            register_response: Record<string, never>;
            /** @description JSON Schema for manifest */
            manifest: Record<string, never>;
            /** @description JSON Schema for definition_options_request */
            definition_options_request: Record<string, never>;
            /** @description JSON Schema for options_envelope */
            options_envelope: Record<string, never>;
            /** @description JSON Schema for definition_members_request */
            definition_members_request: Record<string, never>;
            /** @description JSON Schema for members_envelope */
            members_envelope: Record<string, never>;
            /** @description JSON Schema for pin_request */
            pin_request: Record<string, never>;
            /** @description JSON Schema for pin_response */
            pin_response: Record<string, never>;
            /** @description JSON Schema for operation_resource */
            operation_resource: Record<string, never>;
            /** @description JSON Schema for description */
            description: Record<string, never>;
            /** @description JSON Schema for description_values_page */
            description_values_page: Record<string, never>;
            /** @description JSON Schema for problem_details_extensions */
            problem_details_extensions: Record<string, never>;
            capabilities: string;
          };
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_capabilities: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["datasets_api__capabilities__Capabilities"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_operation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OperationResource"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description Operation not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description The operation ran and did not complete successfully */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_register: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RegisterRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DefinitionResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_mint: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["MintRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Manifest"];
        };
      };
      /** @description The build runs as a background operation. Poll `Location` until the operation is done; the done poll carries the manifest. */
      202: {
        headers: {
          /** @description The operation's poll URL, `operation.poll` in the body. */
          Location?: string;
          /** @description Whole seconds to wait before the next poll, rounded up from `operation.retry_after_ms`. The value grows as the build runs. */
          "Retry-After"?: number;
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OperationResource"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_definition: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Manifest"];
        };
      };
      /** @description The build runs as a background operation. Poll `Location` until the operation is done; the done poll carries the manifest. */
      202: {
        headers: {
          /** @description The operation's poll URL, `operation.poll` in the body. */
          Location?: string;
          /** @description Whole seconds to wait before the next poll, rounded up from `operation.retry_after_ms`. The value grows as the build runs. */
          "Retry-After"?: number;
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OperationResource"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_definition_options: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OptionsEnvelope"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_post_definition_options: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DefinitionOptionsRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OptionsEnvelope"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_post_definition_members: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": components["schemas"]["DefinitionMembersRequest"] | null;
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["MembersEnvelope"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_refresh_frame: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RefreshFrameRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json":
            | components["schemas"]["FrameCurrent"]
            | components["schemas"]["FrameMoved"]
            | components["schemas"]["FramePending"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_recipe: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        spec_id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Recipe"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_put_recipe: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        spec_id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["Recipe"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecipeWriteResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_replay: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        replay_key: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ReplayedFrameResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_list_versions: {
    parameters: {
      query?: {
        limit?: number;
        cursor?: string | null;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DatasetVersionsPage"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_snapshot: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Manifest"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_description: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description the version's description */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            describes?: unknown;
            title?: unknown;
            about?: unknown;
            sources?: unknown;
            freshness?: unknown;
            steps?: unknown;
            cite?: unknown;
            caveats?: unknown;
            gaps?: unknown;
            built_from?: unknown;
          };
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_description_values: {
    parameters: {
      query: {
        property: string;
        limit?: number;
        cursor?: string | null;
      };
      header?: never;
      path: {
        id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DescriptionValuesPage"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_file: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        content_version: string;
        digest: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description a redirect to the artifact's bytes */
      302: {
        headers: {
          /** @description a GET URL signed for at most five minutes */
          Location?: string;
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_version_file: {
    parameters: {
      query?: {
        /** @description the file format; csv when absent */
        format?: ("csv" | "xlsx" | "parquet") | (string & {});
        /** @description true for a zip bundle with its documentation; true when absent */
        bundle?: boolean;
        /** @description frame for a bare parquet file in the frame layout; needs format=parquet and bundle=false */
        layout?: "frame" | (string & {});
      };
      header?: never;
      path: {
        id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description a redirect to the artifact's bytes */
      302: {
        headers: {
          /** @description a GET URL signed for at most five minutes */
          Location?: string;
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_get_observations: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SpecObservations"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_post_pin: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PinRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PinResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  datasets_post_publish: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PublishFrameRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PublishFrameResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_get_health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_get_capabilities: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["graph_api__capabilities__Capabilities"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_get_schema: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GraphSchema"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_resolve: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["graph_api__resolve_models__ResolveRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ResolveResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_get_documentation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        dcid: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SourceDocumentation"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_list_sources: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SourceCatalogue"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_list_members: {
    parameters: {
      query: {
        relation:
          | ("codes" | "children" | "datasets" | "variables" | "members" | "countries" | "facets")
          | (string & {});
        limit?: number;
        cursor?: string | null;
        projection?: components["schemas"]["Projection"] | null;
        as_of?: string | null;
        source?: string | null;
        unit?: string | null;
        measurement_method?: string | null;
      };
      header?: never;
      path: {
        dcid: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["MembersPage"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_list_roots: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Roots"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_get_node: {
    parameters: {
      query?: {
        as_of?: string | null;
      };
      header?: never;
      path: {
        dcid: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json":
            | components["schemas"]["StatVarNode"]
            | components["schemas"]["CodeSystemNode"]
            | components["schemas"]["CodeNode"]
            | components["schemas"]["GroupNode"]
            | components["schemas"]["CountryNode"]
            | components["schemas"]["ContinentNode"]
            | components["schemas"]["SubregionNode"]
            | components["schemas"]["ContinentalUnionNode"]
            | components["schemas"]["PlaceOtherNode"]
            | components["schemas"]["OrganisationNode"]
            | components["schemas"]["AggregateNode"]
            | components["schemas"]["UnitNode"]
            | components["schemas"]["SourceNode"]
            | components["schemas"]["DatasetNode"]
            | components["schemas"]["ProvenanceNode"]
            | components["schemas"]["OtherNode"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  graph_get_nodes: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["NodesRequest"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["NodesResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_get_health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_get_capabilities: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CapabilitiesResponse"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_create_component: {
    parameters: {
      query?: never;
      header?: {
        "x-dfo-write-token"?: string | null;
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateComponentBody"];
      };
    };
    responses: {
      /** @description Successful Response */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreateReplyResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_read_component: {
    parameters: {
      query?: {
        revision?: number | null;
      };
      header?: never;
      path: {
        component_id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ComponentReadResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_revise_component: {
    parameters: {
      query?: never;
      header?: {
        "x-dfo-write-token"?: string | null;
      };
      path: {
        component_id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ComponentBody"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WriteReplyResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_read_component_data: {
    parameters: {
      query?: {
        format?: ("csv" | "xlsx" | "parquet") | (string & {});
        bundle?: boolean;
      };
      header?: never;
      path: {
        component_id: string;
        revision: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The rows behind every value the revision shows. `bundle=true` serves a zip holding the file under `data/` with `data/codes.csv`, `datapackage.json`, `CITATION.cff`, `README.md`, and `SOURCES.md`. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/zip": unknown;
          "text/csv": unknown;
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": unknown;
          "application/vnd.apache.parquet": unknown;
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_render_component_revision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        component_id: string;
        revision: number;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RenderBody"];
      };
    };
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ComponentReadResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_read_rendered_component_data: {
    parameters: {
      query: {
        spec_id: string;
        content_version: string;
        format?: ("csv" | "xlsx" | "parquet") | (string & {});
        bundle?: boolean;
      };
      header?: never;
      path: {
        component_id: string;
        revision: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The rows behind every value the revision shows when drawn on the named frame, as the component data route serves a stored revision's. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/zip": unknown;
          "text/csv": unknown;
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": unknown;
          "application/vnd.apache.parquet": unknown;
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_get_frame: {
    parameters: {
      query?: {
        dimension?: string | null;
        query?: string | null;
      };
      header?: never;
      path: {
        spec_id: string;
        content_version: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Neither `dimension` nor `query` given returns the frame's structural view. `dimension` alone returns that one dimension's full value list. `query` alone returns every dimension filtered to values matching the query. `dimension` and `query` together return that one dimension's values filtered to the query. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json":
            | components["schemas"]["FrameStructuralViewResponse"]
            | components["schemas"]["FrameDimensionValuesResponse"]
            | components["schemas"]["FrameFilteredViewResponse"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  presentation_get_release: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ReleaseDocumentResponse"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
  codes_get_code: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        code: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Successful Response */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CodeRegistryEntry"];
        };
      };
      /** @description the request body or parameters failed validation (request_invalid) */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
      /** @description any non-2xx response uses this envelope */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/problem+json": components["schemas"]["ProblemDetails"];
        };
      };
    };
  };
}

export type AggregateNode = components["schemas"]["AggregateNode"];
export type AidCounts = components["schemas"]["AidCounts"];
export type AmbiguousEntityCandidate = components["schemas"]["AmbiguousEntityCandidate"];
export type AmbiguousEntityGroup = components["schemas"]["AmbiguousEntityGroup"];
export type AmbiguousSourceCandidate = components["schemas"]["AmbiguousSourceCandidate"];
export type AmbiguousSourceGroup = components["schemas"]["AmbiguousSourceGroup"];
export type AppliedDefaultModel = components["schemas"]["AppliedDefaultModel"];
export type ArtifactEntryModel = components["schemas"]["ArtifactEntryModel"];
export type Assumption = components["schemas"]["Assumption"];
export type Authority = components["schemas"]["Authority"];
export type Availability = components["schemas"]["Availability"];
export type AvailabilityDefault = components["schemas"]["AvailabilityDefault"];
export type AvailabilitySource = components["schemas"]["AvailabilitySource"];
export type AvailabilitySummary = components["schemas"]["AvailabilitySummary"];
export type BaseIdentity = components["schemas"]["BaseIdentity"];
export type Binding = components["schemas"]["Binding"];
export type BindingSet = components["schemas"]["BindingSet"];
export type BindingUnbound = components["schemas"]["BindingUnbound"];
export type BindingValue = components["schemas"]["BindingValue"];
export type BreadthDim = components["schemas"]["BreadthDim"];
export type BundleOptionModel = components["schemas"]["BundleOptionModel"];
export type CandidateSet = components["schemas"]["CandidateSet"];
export type CandidatesPart = components["schemas"]["CandidatesPart"];
export type CanonicalDefinition = components["schemas"]["CanonicalDefinition"];
export type CapabilitiesResponse = components["schemas"]["CapabilitiesResponse"];
export type CapabilityDefaultPolicy = components["schemas"]["CapabilityDefaultPolicy"];
export type CapabilityFormat = components["schemas"]["CapabilityFormat"];
export type CapabilityKind = components["schemas"]["CapabilityKind"];
export type CatalogueAnswer = components["schemas"]["CatalogueAnswer"];
export type CatalogueExampleSentence = components["schemas"]["CatalogueExampleSentence"];
export type CatalogueResponse = components["schemas"]["CatalogueResponse"];
export type Cause = components["schemas"]["Cause"];
export type ChangeEntry = components["schemas"]["ChangeEntry"];
export type ChangeModel = components["schemas"]["ChangeModel"];
export type ChangedFieldModel = components["schemas"]["ChangedFieldModel"];
export type Choice = components["schemas"]["Choice"];
export type CitationModel = components["schemas"]["CitationModel"];
export type CitationSource = components["schemas"]["CitationSource"];
export type CitedDataCommons = components["schemas"]["CitedDataCommons"];
export type CitedDocumentation = components["schemas"]["CitedDocumentation"];
export type CitedSourceNode = components["schemas"]["CitedSourceNode"];
export type CodeBlock = components["schemas"]["CodeBlock"];
export type CodeItem = components["schemas"]["CodeItem"];
export type CodeMappingEntry = components["schemas"]["CodeMappingEntry"];
export type CodeNode = components["schemas"]["CodeNode"];
export type CodeRegistryEntry = components["schemas"]["CodeRegistryEntry"];
export type CodeSystemBlock = components["schemas"]["CodeSystemBlock"];
export type CodeSystemDeclarations = components["schemas"]["CodeSystemDeclarations"];
export type CodeSystemNode = components["schemas"]["CodeSystemNode"];
export type ColumnOptionModel = components["schemas"]["ColumnOptionModel"];
export type ComponentBody = components["schemas"]["ComponentBody"];
export type ComponentReadResponse = components["schemas"]["ComponentReadResponse"];
export type ComposedUnit = components["schemas"]["ComposedUnit"];
export type ComposedUnitModel = components["schemas"]["ComposedUnitModel"];
export type Constraint = components["schemas"]["Constraint"];
export type ContinentNode = components["schemas"]["ContinentNode"];
export type ContinentalUnionNode = components["schemas"]["ContinentalUnionNode"];
export type ConversionCurrency = components["schemas"]["ConversionCurrency"];
export type ConvertedUnitModel = components["schemas"]["ConvertedUnitModel"];
export type CountedStatVarModel = components["schemas"]["CountedStatVarModel"];
export type CountryNode = components["schemas"]["CountryNode"];
export type Counts = components["schemas"]["Counts"];
export type CoverageBare = components["schemas"]["CoverageBare"];
export type CoverageBreadth = components["schemas"]["CoverageBreadth"];
export type CoverageDimension = components["schemas"]["CoverageDimension"];
export type CoverageExact = components["schemas"]["CoverageExact"];
export type CoverageModel = components["schemas"]["CoverageModel"];
export type CreateComponentBody = components["schemas"]["CreateComponentBody"];
export type CreateReplyResponse = components["schemas"]["CreateReplyResponse"];
export type DataBuilds = components["schemas"]["DataBuilds"];
export type DatasetEntry = components["schemas"]["DatasetEntry"];
export type DatasetNode = components["schemas"]["DatasetNode"];
export type DatasetResubmitInput = components["schemas"]["DatasetResubmitInput"];
export type DatasetVersion = components["schemas"]["DatasetVersion"];
export type DatasetVersionsPage = components["schemas"]["DatasetVersionsPage"];
export type DateRange = components["schemas"]["DateRange"];
export type DeclinedAnswer = components["schemas"]["DeclinedAnswer"];
export type DefinitePart = components["schemas"]["DefinitePart"];
export type DefinitionMembersRequest = components["schemas"]["DefinitionMembersRequest"];
export type DefinitionModel = components["schemas"]["DefinitionModel"];
export type DefinitionOptionsRequest = components["schemas"]["DefinitionOptionsRequest"];
export type DefinitionResponse = components["schemas"]["DefinitionResponse"];
export type DefinitionText = components["schemas"]["DefinitionText"];
export type Departure = components["schemas"]["Departure"];
export type DeploymentFacetPolicy = components["schemas"]["DeploymentFacetPolicy"];
export type DescribedProperty = components["schemas"]["DescribedProperty"];
export type DescribedValue = components["schemas"]["DescribedValue"];
export type DescriptionValuesPage = components["schemas"]["DescriptionValuesPage"];
export type DiagnosticModel = components["schemas"]["DiagnosticModel"];
export type Diagnostics = components["schemas"]["Diagnostics"];
export type DimensionNoun = components["schemas"]["DimensionNoun"];
export type DocumentErrorEntry = components["schemas"]["DocumentErrorEntry"];
export type DownloadFacts = components["schemas"]["DownloadFacts"];
export type DownloadLicence = components["schemas"]["DownloadLicence"];
export type EnrichmentCoverageCountsModel = components["schemas"]["EnrichmentCoverageCountsModel"];
export type EnrichmentOptionModel = components["schemas"]["EnrichmentOptionModel"];
export type EntityCounts = components["schemas"]["EntityCounts"];
export type EntityCoverage = components["schemas"]["EntityCoverage"];
export type EntityGroup = components["schemas"]["EntityGroup"];
export type EntityOptions = components["schemas"]["EntityOptions"];
export type EntityRef = components["schemas"]["EntityRef"];
export type Exclusion = components["schemas"]["Exclusion"];
export type Expansion = components["schemas"]["Expansion"];
export type FacetItem = components["schemas"]["FacetItem"];
export type FacetNationalCurrencyBinding = components["schemas"]["FacetNationalCurrencyBinding"];
export type FacetOptions = components["schemas"]["FacetOptions"];
export type FacetRefBinding = components["schemas"]["FacetRefBinding"];
export type FactSummaryModel = components["schemas"]["FactSummaryModel"];
export type FactSummarySeriesEntry = components["schemas"]["FactSummarySeriesEntry"];
export type FlowAccount = components["schemas"]["FlowAccount"];
export type FormatOptionModel = components["schemas"]["FormatOptionModel"];
export type FrameCurrent = components["schemas"]["FrameCurrent"];
export type FrameDimensionMatch = components["schemas"]["FrameDimensionMatch"];
export type FrameDimensionSummary = components["schemas"]["FrameDimensionSummary"];
export type FrameDimensionValuesResponse = components["schemas"]["FrameDimensionValuesResponse"];
export type FrameFilteredViewResponse = components["schemas"]["FrameFilteredViewResponse"];
export type FrameMoved = components["schemas"]["FrameMoved"];
export type FramePair = components["schemas"]["FramePair"];
export type FramePending = components["schemas"]["FramePending"];
export type FrameStructuralViewResponse = components["schemas"]["FrameStructuralViewResponse"];
export type Freshness = components["schemas"]["Freshness"];
export type GraphRef = components["schemas"]["GraphRef"];
export type GraphSchema = components["schemas"]["GraphSchema"];
export type GroupNode = components["schemas"]["GroupNode"];
export type GroupbyOptions = components["schemas"]["GroupbyOptions"];
export type GroupbyOptionsModel = components["schemas"]["GroupbyOptionsModel"];
export type Headline = components["schemas"]["Headline"];
export type HeadlineYear = components["schemas"]["HeadlineYear"];
export type HealthResponse = components["schemas"]["HealthResponse"];
export type IdentityBindingExact = components["schemas"]["IdentityBindingExact"];
export type IdentityBindingSet = components["schemas"]["IdentityBindingSet"];
export type IdentityBindingUnbound = components["schemas"]["IdentityBindingUnbound"];
export type IdentityBindingValue = components["schemas"]["IdentityBindingValue"];
export type IdentityCurrencyRole = components["schemas"]["IdentityCurrencyRole"];
export type IdentityFacetValueAbsent = components["schemas"]["IdentityFacetValueAbsent"];
export type IdentityFacetValueRequest = components["schemas"]["IdentityFacetValueRequest"];
export type IdentityShapeDenominatorRef = components["schemas"]["IdentityShapeDenominatorRef"];
export type IdentityShapeDenominatorUnresolved =
  components["schemas"]["IdentityShapeDenominatorUnresolved"];
export type IdentityShapePin = components["schemas"]["IdentityShapePin"];
export type IdentityShapeSchema = components["schemas"]["IdentityShapeSchema"];
export type IdentitySlot = components["schemas"]["IdentitySlot"];
export type IdentityUnitRequest = components["schemas"]["IdentityUnitRequest"];
export type IdentityWindowAll = components["schemas"]["IdentityWindowAll"];
export type IdentityWindowLatest = components["schemas"]["IdentityWindowLatest"];
export type IdentityWindowRange = components["schemas"]["IdentityWindowRange"];
export type JsonValue = components["schemas"]["JsonValue"];
export type LeftOut = components["schemas"]["LeftOut"];
export type Manifest = components["schemas"]["Manifest"];
export type Matched = components["schemas"]["Matched"];
export type Measure = components["schemas"]["Measure"];
export type MeasureAxisValue = components["schemas"]["MeasureAxisValue"];
export type MemberItem = components["schemas"]["MemberItem"];
export type MembersEnvelope = components["schemas"]["MembersEnvelope"];
export type MembersPage = components["schemas"]["MembersPage"];
export type MembershipBlock = components["schemas"]["MembershipBlock"];
export type Methodology = components["schemas"]["Methodology"];
export type MintOptions = components["schemas"]["MintOptions"];
export type MintRequest = components["schemas"]["MintRequest"];
export type MissingEntityModel = components["schemas"]["MissingEntityModel"];
export type NationalCurrency = components["schemas"]["NationalCurrency"];
export type NearestRealSpec = components["schemas"]["NearestRealSpec"];
export type NoData = components["schemas"]["NoData"];
export type NoDataDenominator = components["schemas"]["NoDataDenominator"];
export type NoDataOption = components["schemas"]["NoDataOption"];
export type NoDataPart = components["schemas"]["NoDataPart"];
export type NodeRef = components["schemas"]["NodeRef"];
export type NodesRequest = components["schemas"]["NodesRequest"];
export type NodesResponse = components["schemas"]["NodesResponse"];
export type NotHeldEntry = components["schemas"]["NotHeldEntry"];
export type ObservationPoint = components["schemas"]["ObservationPoint"];
export type ObservationSeries = components["schemas"]["ObservationSeries"];
export type ObservationSeriesConversion = components["schemas"]["ObservationSeriesConversion"];
export type ObservationsOmission = components["schemas"]["ObservationsOmission"];
export type OpenAxisValueCount = components["schemas"]["OpenAxisValueCount"];
export type OpenConstraintAxisFact = components["schemas"]["OpenConstraintAxisFact"];
export type RequestedOperation = components["schemas"]["Operation"];
export type OperationEnvelope = components["schemas"]["OperationEnvelope"];
export type OperationProgress = components["schemas"]["OperationProgress"];
export type OperationResource = components["schemas"]["OperationResource"];
export type OptionsEnvelope = components["schemas"]["OptionsEnvelope"];
export type OptionsFor = components["schemas"]["OptionsFor"];
export type OptionsRequest = components["schemas"]["OptionsRequest"];
export type OptionsResponse = components["schemas"]["OptionsResponse"];
export type OptionsSet = components["schemas"]["OptionsSet"];
export type OrganisationNode = components["schemas"]["OrganisationNode"];
export type OtherNode = components["schemas"]["OtherNode"];
export type OutputOptionsModel = components["schemas"]["OutputOptionsModel"];
export type ParsedEntity = components["schemas"]["ParsedEntity"];
export type ParsedInput = components["schemas"]["ParsedInput"];
export type ParsedPart = components["schemas"]["ParsedPart"];
export type PartyBlock = components["schemas"]["PartyBlock"];
export type PeriodCoverage = components["schemas"]["PeriodCoverage"];
export type PinRequest = components["schemas"]["PinRequest"];
export type PinResponse = components["schemas"]["PinResponse"];
export type PinnedCoordinates = components["schemas"]["PinnedCoordinates"];
export type PivotOptionModel = components["schemas"]["PivotOptionModel"];
export type PivotOptions = components["schemas"]["PivotOptions"];
export type PlaceBlock = components["schemas"]["PlaceBlock"];
export type PlaceCounts = components["schemas"]["PlaceCounts"];
export type PlaceOtherNode = components["schemas"]["PlaceOtherNode"];
export type PriceBasisWords = components["schemas"]["PriceBasisWords"];
export type Projection = components["schemas"]["Projection"];
export type ProjectionCount = components["schemas"]["ProjectionCount"];
export type ProvenanceEntry = components["schemas"]["ProvenanceEntry"];
export type ProvenanceNode = components["schemas"]["ProvenanceNode"];
export type ProvenanceRef = components["schemas"]["ProvenanceRef"];
export type PublishFrameRequest = components["schemas"]["PublishFrameRequest"];
export type PublishFrameResponse = components["schemas"]["PublishFrameResponse"];
export type PublishedFrameCoordinates = components["schemas"]["PublishedFrameCoordinates"];
export type QueryEcho = components["schemas"]["QueryEcho"];
export type RawTextInput = components["schemas"]["RawTextInput"];
export type Recipe = components["schemas"]["Recipe"];
export type RecipeAnchor = components["schemas"]["RecipeAnchor"];
export type RecipeLeftOutSeries = components["schemas"]["RecipeLeftOutSeries"];
export type RecipeWriteResponse = components["schemas"]["RecipeWriteResponse"];
export type RefreshFrameRequest = components["schemas"]["RefreshFrameRequest"];
export type RegisterRequest = components["schemas"]["RegisterRequest"];
export type RelatedMeasure = components["schemas"]["RelatedMeasure"];
export type Relaxation = components["schemas"]["Relaxation"];
export type ReleaseDocumentResponse = components["schemas"]["ReleaseDocumentResponse"];
export type ReleaseModel = components["schemas"]["ReleaseModel"];
export type RenderBody = components["schemas"]["RenderBody"];
export type RenderFrame = components["schemas"]["RenderFrame"];
export type ReplayedFrameResponse = components["schemas"]["ReplayedFrameResponse"];
export type Resolution = components["schemas"]["Resolution"];
export type ResolutionTrace = components["schemas"]["ResolutionTrace"];
export type ResolveOptions = components["schemas"]["ResolveOptions"];
export type ResolveResponse = components["schemas"]["ResolveResponse"];
export type ResolveResult = components["schemas"]["ResolveResult"];
export type ResolvedEntity = components["schemas"]["ResolvedEntity"];
export type ResolvedFacet = components["schemas"]["ResolvedFacet"];
export type ResolvedFilter = components["schemas"]["ResolvedFilter"];
export type ResolvedQualifier = components["schemas"]["ResolvedQualifier"];
export type ResolvedScope = components["schemas"]["ResolvedScope"];
export type ResolvedSpec = components["schemas"]["ResolvedSpec"];
export type ResolvedStatVars = components["schemas"]["ResolvedStatVars"];
export type ResubmitCandidate = components["schemas"]["ResubmitCandidate"];
export type ResubmitCandidatesEntry = components["schemas"]["ResubmitCandidatesEntry"];
export type ResubmitIdentityEntry = components["schemas"]["ResubmitIdentityEntry"];
export type ResubmitParsedEntry = components["schemas"]["ResubmitParsedEntry"];
export type ResubmitPlaceholderEntry = components["schemas"]["ResubmitPlaceholderEntry"];
export type RetentionModel = components["schemas"]["RetentionModel"];
export type RoleAxis = components["schemas"]["RoleAxis"];
export type RoleAxisFact = components["schemas"]["RoleAxisFact"];
export type RootEntry = components["schemas"]["RootEntry"];
export type Roots = components["schemas"]["Roots"];
export type ScopeInput = components["schemas"]["Scope-Input"];
export type ScopeOutput = components["schemas"]["Scope-Output"];
export type ScopeAndUnits = components["schemas"]["ScopeAndUnits"];
export type SentenceToken = components["schemas"]["SentenceToken"];
export type Series = components["schemas"]["Series"];
export type SeriesAxisRef = components["schemas"]["SeriesAxisRef"];
export type SeriesConversionFallbackExample =
  components["schemas"]["SeriesConversionFallbackExample"];
export type SeriesEntityRef = components["schemas"]["SeriesEntityRef"];
export type SeriesFacetRef = components["schemas"]["SeriesFacetRef"];
export type SeriesStatVarRef = components["schemas"]["SeriesStatVarRef"];
export type ServedMember = components["schemas"]["ServedMember"];
export type Shape = components["schemas"]["Shape"];
export type ShapeUpstream = components["schemas"]["ShapeUpstream"];
export type SimpleUnit = components["schemas"]["SimpleUnit"];
export type Skill = components["schemas"]["Skill"];
export type Slot = components["schemas"]["Slot"];
export type SlotKey = components["schemas"]["SlotKey"];
export type SlotOption = components["schemas"]["SlotOption"];
export type SlotOptions = components["schemas"]["SlotOptions"];
export type SlotValue = components["schemas"]["SlotValue"];
export type SourceAvailability = components["schemas"]["SourceAvailability"];
export type SourceBlock = components["schemas"]["SourceBlock"];
export type SourceCatalogue = components["schemas"]["SourceCatalogue"];
export type SourceCatalogueEntry = components["schemas"]["SourceCatalogueEntry"];
export type SourceCode = components["schemas"]["SourceCode"];
export type SourceDetails = components["schemas"]["SourceDetails"];
export type SourceDocumentation = components["schemas"]["SourceDocumentation"];
export type SourceLicense = components["schemas"]["SourceLicense"];
export type SourceMention = components["schemas"]["SourceMention"];
export type SourceNode = components["schemas"]["SourceNode"];
export type SourceNodeRef = components["schemas"]["SourceNodeRef"];
export type SourceRef = components["schemas"]["SourceRef"];
export type Spec = components["schemas"]["Spec"];
export type SpecAlternativeMeasure = components["schemas"]["SpecAlternativeMeasure"];
export type SpecDefinition = components["schemas"]["SpecDefinition"];
export type SpecIdInput = components["schemas"]["SpecIdInput"];
export type SpecObservations = components["schemas"]["SpecObservations"];
export type StatVarBlock = components["schemas"]["StatVarBlock"];
export type StatVarNode = components["schemas"]["StatVarNode"];
export type StatVarSetInput = components["schemas"]["StatVarSetInput"];
export type Step = components["schemas"]["Step"];
export type StepRef = components["schemas"]["StepRef"];
export type SubregionNode = components["schemas"]["SubregionNode"];
export type Summed = components["schemas"]["Summed"];
export type TimeWindow = components["schemas"]["TimeWindow"];
export type Timing = components["schemas"]["Timing"];
export type TraceConversion = components["schemas"]["TraceConversion"];
export type TraceDefaultReading = components["schemas"]["TraceDefaultReading"];
export type TransformationLogEntry = components["schemas"]["TransformationLogEntry"];
export type TransformationStepModel = components["schemas"]["TransformationStepModel"];
export type UnavailableFormatModel = components["schemas"]["UnavailableFormatModel"];
export type UnitAlternative = components["schemas"]["UnitAlternative"];
export type UnitBlock = components["schemas"]["UnitBlock"];
export type UnitConstantPricesRequestBinding =
  components["schemas"]["UnitConstantPricesRequestBinding"];
export type UnitConversion = components["schemas"]["UnitConversion"];
export type UnitCount = components["schemas"]["UnitCount"];
export type UnitCurrencyRole = components["schemas"]["UnitCurrencyRole"];
export type UnitCurrentPricesRequestBinding =
  components["schemas"]["UnitCurrentPricesRequestBinding"];
export type UnitKind = components["schemas"]["UnitKind"];
export type UnitNode = components["schemas"]["UnitNode"];
export type UnitsFold = components["schemas"]["UnitsFold"];
export type Unsupported = components["schemas"]["Unsupported"];
export type UnsupportedPart = components["schemas"]["UnsupportedPart"];
export type Usage = components["schemas"]["Usage"];
export type UsageEntry = components["schemas"]["UsageEntry"];
export type VariableDefinition = components["schemas"]["VariableDefinition"];
export type VariableSide = components["schemas"]["VariableSide"];
export type VaryingColumnModel = components["schemas"]["VaryingColumnModel"];
export type VersionHistoryEntry = components["schemas"]["VersionHistoryEntry"];
export type VersionRef = components["schemas"]["VersionRef"];
export type Warning = components["schemas"]["Warning"];
export type WarningModel = components["schemas"]["WarningModel"];
export type WindowAll = components["schemas"]["WindowAll"];
export type WindowLatest = components["schemas"]["WindowLatest"];
export type WindowModel = components["schemas"]["WindowModel"];
export type WindowRange = components["schemas"]["WindowRange"];
export type WriteReplyResponse = components["schemas"]["WriteReplyResponse"];
export type YearCoverage = components["schemas"]["YearCoverage"];
export type YearRange = components["schemas"]["YearRange"];
export type DatasetsApiCapabilitiesCapabilities =
  components["schemas"]["datasets_api__capabilities__Capabilities"];
export type DatasetsApiCapabilitiesCapabilityCaps =
  components["schemas"]["datasets_api__capabilities__CapabilityCaps"];
export type DatasetsApiCapabilitiesCodeIndexStamp =
  components["schemas"]["datasets_api__capabilities__CodeIndexStamp"];
export type GraphApiCapabilitiesCapabilities =
  components["schemas"]["graph_api__capabilities__Capabilities"];
export type GraphApiCapabilitiesCapabilityCaps =
  components["schemas"]["graph_api__capabilities__CapabilityCaps"];
export type GraphApiCapabilitiesCapabilityDoor =
  components["schemas"]["graph_api__capabilities__CapabilityDoor"];
export type GraphApiOriginModelsDataCommonsRef =
  components["schemas"]["graph_api__origin_models__DataCommonsRef"];
export type GraphApiResolveModelsResolveRequest =
  components["schemas"]["graph_api__resolve_models__ResolveRequest"];
export type SearchEngineCapabilitiesCapabilities =
  components["schemas"]["search__engine__capabilities__Capabilities"];
export type SearchEngineCapabilitiesCapabilityCaps =
  components["schemas"]["search__engine__capabilities__CapabilityCaps"];
export type SearchEngineCapabilitiesCapabilityDoor =
  components["schemas"]["search__engine__capabilities__CapabilityDoor"];
export type SearchEngineCapabilitiesCodeIndexStamp =
  components["schemas"]["search__engine__capabilities__CodeIndexStamp"];
export type SearchModelsGrammarDataCommonsRef =
  components["schemas"]["search__models__grammar__DataCommonsRef"];
export type SearchModelsRequestResolveRequest =
  components["schemas"]["search__models__request__ResolveRequest"];
export type ProblemDetails = components["schemas"]["ProblemDetails"];
export type Alternative = components["schemas"]["Alternative"];
export type ProblemIssue = components["schemas"]["ProblemIssue"];
