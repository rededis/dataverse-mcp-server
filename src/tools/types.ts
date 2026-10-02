import type { McpServer } from "@modelcontextprotocol/server";
import type { DataverseClient } from "../client.js";

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
  /** Registers the real delete tools instead of disabled stubs (DATAVERSE_ALLOW_DELETE). */
  allowDelete?: boolean;
}

export type RegisterTools = (server: McpServer, deps: ToolDeps) => void;
