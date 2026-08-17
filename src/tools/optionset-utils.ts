// Shared OptionSet metadata helpers.
//
// Lives in its own module rather than in data-tools.ts or picklist-tools.ts
// because both of those need it (get_entity_schema and get_picklist_options),
// and picklist-tools already imports the OData helpers from data-tools — putting
// these there too would create an import cycle.

// OptionSet is declared on EnumAttributeMetadata, not on the base AttributeMetadata
// that the plain /Attributes collection returns — so reading it always requires a
// type-cast segment.
//
// The cast must name a CONCRETE type. Casting to the abstract base,
// /Attributes/Microsoft.Dynamics.CRM.EnumAttributeMetadata, is rejected at runtime
// with HTTP 500 "0x8006088a: Unexpected attribute type EnumAttributeMetadata" —
// verified live against a real org, even though the docs list it as a GET-able
// entity type. Hence one request per concrete choice type.
//
// EntityNameAttributeMetadata is deliberately absent: it derives from
// EnumAttributeMetadata but carries no OptionSet, so including it would only add
// empty rows.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/enumattributemetadata
export const CHOICE_ATTRIBUTE_CASTS = [
  "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
  "Microsoft.Dynamics.CRM.StatusAttributeMetadata",
  "Microsoft.Dynamics.CRM.StateAttributeMetadata",
  "Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata",
] as const;

// Name/IsGlobal/MetadataId are what make a Local set distinguishable from a
// Global one — without them the two are indistinguishable in the response.
//
// Note that the sibling GlobalOptionSet navigation property is NOT a usable
// binding signal: verified live, it resolves to the column's own local set for a
// locally-defined column rather than returning null, so it cannot tell the two
// cases apart. IsGlobal on the expanded OptionSet is the reliable indicator.
export const OPTION_SET_IDENTITY_SELECT = "Name,IsGlobal,MetadataId";
export const OPTION_SET_EXPAND = `OptionSet($select=${OPTION_SET_IDENTITY_SELECT},Options)`;

export interface OptionLabel {
  LocalizedLabels?: Array<{ Label?: string; LanguageCode?: number }>;
  UserLocalizedLabel?: { Label?: string; LanguageCode?: number };
}

export interface RawOption {
  Value: number;
  Label?: OptionLabel;
}

export interface RawOptionSet {
  Name?: string | null;
  IsGlobal?: boolean;
  MetadataId?: string;
  Options?: RawOption[];
}

export interface OptionSetIdentity {
  name: string | null;
  is_global: boolean;
  metadata_id: string | null;
}

export interface OptionSetSummary extends OptionSetIdentity {
  option_count: number;
}

export function flattenOption(opt: RawOption): {
  value: number;
  label: string | null;
} {
  const label =
    opt.Label?.UserLocalizedLabel?.Label ??
    opt.Label?.LocalizedLabels?.[0]?.Label ??
    null;
  return { value: opt.Value, label };
}

// IsGlobal is read from the payload rather than inferred from which branch made
// the request: a Local-looking lookup (entity + attribute) legitimately returns a
// Global set when the column is bound to one — which is the entire question this
// answers.
export function flattenOptionSet(os: RawOptionSet): OptionSetIdentity {
  return {
    name: os.Name ?? null,
    is_global: os.IsGlobal === true,
    metadata_id: os.MetadataId ?? null,
  };
}

export function summarizeOptionSet(os: RawOptionSet): OptionSetSummary {
  return { ...flattenOptionSet(os), option_count: os.Options?.length ?? 0 };
}

export interface ChoiceAttributeRow {
  LogicalName: string;
  OptionSet?: RawOptionSet;
}

function castRequests(
  client: { get(path: string): Promise<unknown> },
  attributesPath: string,
  query: string,
) {
  return CHOICE_ATTRIBUTE_CASTS.map(
    (cast) =>
      client.get(`${attributesPath}/${cast}${query}`) as Promise<{
        value?: ChoiceAttributeRow[];
      }>,
  );
}

// Fans the same query out across every concrete choice cast and concatenates the
// rows. A cast that does not match simply returns an empty collection rather than
// an error, so the caller can treat "no rows at all" as "not a choice column".
//
// Rejects if any cast fails. That is required wherever an empty result is given
// meaning: swallowing a failed Picklist cast would turn a transient error into a
// confident "not a choice column", which is a wrong answer rather than a failure.
export async function fetchChoiceAttributes(
  client: { get(path: string): Promise<unknown> },
  attributesPath: string,
  query: string,
): Promise<ChoiceAttributeRow[]> {
  const responses = await Promise.all(
    castRequests(client, attributesPath, query),
  );
  return responses.flatMap((r) => r.value ?? []);
}

export interface ChoiceAttributeFanOut {
  rows: ChoiceAttributeRow[];
  failed: Array<{ cast: string; message: string }>;
}

// Same fan-out, but a failing cast is reported instead of rejecting — for callers
// that still have something worth returning without the enrichment.
//
// Callers MUST surface `failed`. A column silently missing its OptionSet is
// indistinguishable from a column that has none, and that is precisely the
// wrong-answer failure this whole feature exists to prevent.
export async function fetchChoiceAttributesSettled(
  client: { get(path: string): Promise<unknown> },
  attributesPath: string,
  query: string,
): Promise<ChoiceAttributeFanOut> {
  const results = await Promise.allSettled(
    castRequests(client, attributesPath, query),
  );
  const rows: ChoiceAttributeRow[] = [];
  const failed: ChoiceAttributeFanOut["failed"] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      rows.push(...(result.value.value ?? []));
    } else {
      failed.push({
        cast: CHOICE_ATTRIBUTE_CASTS[i].replace("Microsoft.Dynamics.CRM.", ""),
        message:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });
  return { rows, failed };
}
