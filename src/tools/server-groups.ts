import { registerActionTools } from "./actions.js";
import { registerDataReadTools } from "./data-read.js";
import { registerDataWriteTools } from "./data-write.js";
import { registerDocumentsReadTools } from "./documents-read.js";
import { registerFunctionTools } from "./functions.js";
import { registerMetadataReadTools } from "./metadata-read.js";
import type { RegisterTools, ToolGroup } from "./types.js";

/**
 * The groups a remote server may expose. `development` is deliberately absent:
 * nothing reachable from this module imports ./development/, so a bundle built
 * from a server entry point cannot contain schema-changing tools.
 */
export type ServerToolGroup = Exclude<ToolGroup, "development">;

/**
 * The key order is the order of `tools/list` (ADR-0001 §9): a new group goes
 * last, so the tools existing roles see keep their places.
 */
export const SERVER_TOOL_GROUPS: Readonly<
  Record<ServerToolGroup, RegisterTools>
> = {
  "metadata-read": registerMetadataReadTools,
  "data-read": registerDataReadTools,
  "data-write": registerDataWriteTools,
  actions: registerActionTools,
  functions: registerFunctionTools,
  "documents-read": registerDocumentsReadTools,
};
