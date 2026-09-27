import { registerActionTools } from "./actions.js";
import { registerDataReadTools } from "./data-read.js";
import { registerDataWriteTools } from "./data-write.js";
import { registerFunctionTools } from "./functions.js";
import { registerMetadataReadTools } from "./metadata-read.js";
import type { RegisterTools, ToolGroup } from "./types.js";

export type { RegisterTools, ToolDeps, ToolGroup } from "./types.js";

/**
 * The groups a remote server may expose. `development` is deliberately absent:
 * nothing reachable from this module imports ./development/, so a bundle built
 * from a server entry point cannot contain schema-changing tools.
 */
export type ServerToolGroup = Exclude<ToolGroup, "development">;

export const SERVER_TOOL_GROUPS: Readonly<
  Record<ServerToolGroup, RegisterTools>
> = {
  "metadata-read": registerMetadataReadTools,
  "data-read": registerDataReadTools,
  "data-write": registerDataWriteTools,
  actions: registerActionTools,
  functions: registerFunctionTools,
};
