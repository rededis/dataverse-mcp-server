import { z } from "zod";

// Where an OptionSet lives: a Local one on an entity attribute, or a Global one
// by name. Shared by get_picklist_options (metadata-read) and the option writes
// (development).

export interface PicklistLocation {
  entity_logical_name?: string;
  attribute_logical_name?: string;
  option_set_name?: string;
}

export function validatePicklistLocation(loc: PicklistLocation): void {
  const hasEntity = !!loc.entity_logical_name;
  const hasAttr = !!loc.attribute_logical_name;
  const hasGlobal = !!loc.option_set_name;

  if (hasGlobal && (hasEntity || hasAttr)) {
    throw new Error(
      "option_set_name (Global OptionSet) is mutually exclusive with entity_logical_name/attribute_logical_name (Local OptionSet).",
    );
  }
  if (!hasGlobal && !(hasEntity && hasAttr)) {
    throw new Error(
      "Provide either option_set_name (Global OptionSet) OR both entity_logical_name and attribute_logical_name (Local OptionSet).",
    );
  }
}

export const LOCATION_SHAPE = {
  entity_logical_name: z
    .string()
    .optional()
    .describe(
      "Entity logical name (Local OptionSet; pair with attribute_logical_name). Mutually exclusive with option_set_name.",
    ),
  attribute_logical_name: z
    .string()
    .optional()
    .describe(
      "Picklist attribute logical name (Local OptionSet; pair with entity_logical_name). Mutually exclusive with option_set_name.",
    ),
  option_set_name: z
    .string()
    .optional()
    .describe(
      "Global OptionSet name. Mutually exclusive with entity_logical_name/attribute_logical_name.",
    ),
} as const;

/** The location on its own, as a tool's whole input. */
export const LOCATION_INPUT = z.object(LOCATION_SHAPE);
