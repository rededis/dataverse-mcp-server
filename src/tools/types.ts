import type { McpServer } from "@modelcontextprotocol/server";
import type { DataverseClient } from "../client.js";
import type { Permissions } from "./permissions.js";
import type { EntitySetCatalog } from "./shared/paths.js";

/**
 * Tools grouped by purpose (ADR-0001 §4). The names are the vocabulary of role
 * configuration, so they are part of the contract, not just labels.
 */
export type ToolGroup =
  | "metadata-read"
  | "data-read"
  | "data-write"
  | "actions"
  | "functions"
  | "development";

export interface ToolDeps {
  client: DataverseClient;
  /** Default for list_entities' prefix filter (DATAVERSE_ENTITY_PREFIX). */
  entityPrefix?: string;
  /** Default for list_entities' solution filter (DATAVERSE_SOLUTION_NAME). */
  solutionName?: string;
  /**
   * What the data-write, actions and functions tools may do. Absent means
   * nothing: a tool whose list is empty is not registered.
   */
  permissions?: Permissions;
  /**
   * stdio: when deleting is not permitted, register stubs that tell the user
   * how to enable it (DATAVERSE_ALLOW_DELETE) instead of leaving the tools out.
   */
  deleteStubs?: boolean;
  /**
   * The server: refuse entity sets that do not exist, so a data tool cannot
   * reach an unbound function or action by its name.
   */
  entitySets?: EntitySetCatalog;
}

export type RegisterTools = (server: McpServer, deps: ToolDeps) => void;
