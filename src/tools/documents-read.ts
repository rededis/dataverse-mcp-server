import { z } from "zod";
import type { DataverseClient } from "../client.js";
import { DataverseApiError } from "../errors.js";
import { type FetchResult, runFetchXml } from "./shared/fetchxml.js";
import { buildODataQuery } from "./shared/odata.js";
import {
  assertEntitySetName,
  assertRecordId,
  findEntitySet,
  unknownEntitySet,
} from "./shared/paths.js";
import type { ToolDeps, ToolRegistrar } from "./types.js";

const LIST_RECORD_DOCUMENTS_INPUT = z.object({
  entity_set: z
    .string()
    .describe(
      "Entity set name of the record's table (plural, e.g. 'accounts', 'leads')",
    ),
  id: z.string().describe("Record GUID"),
});

/** Files listed by one call; a record rarely has more. */
const MAX_FILES = 100;

const SETUP_ARTICLE =
  "https://learn.microsoft.com/en-us/power-platform/admin/configure-azure-app-with-sharepoint-access";

// SharePointAuthorizationFailure: SharePoint turned Dataverse away with a
// 401. For an application, or a user it acts for, that means the one-time
// setup in SETUP_ARTICLE is missing or incomplete.
const SHAREPOINT_AUTHORIZATION_FAILURE = "0x800608b4";
// SPNotEnabledForEntity: the table has document management off. Checked in
// the metadata first; this covers a change between the two requests.
const SP_NOT_ENABLED_FOR_ENTITY = "0x8006073b";

interface TableDefinition {
  EntitySetName?: string;
  LogicalName?: string;
  PrimaryIdAttribute?: string;
  IsDocumentManagementEnabled?: boolean;
}

/** What the tool needs of the record's table. */
interface Table {
  entitySet: string;
  logicalName: string;
  primaryId: string;
  documentManagement: boolean;
}

interface DocumentRow {
  documentid?: number;
  fullname?: string;
  relativelocation?: string;
  filetype?: string;
  filesize?: number;
  modified?: string;
  sharepointmodifiedby?: string;
  absoluteurl?: string;
}

const DOCUMENT_ATTRIBUTES = [
  // Not returned to the agent, but without it a folder that has a subfolder
  // fails with 0x80040216 ("An unexpected error occurred").
  "documentid",
  "fullname",
  "relativelocation",
  "filetype",
  "filesize",
  "modified",
  "sharepointmodifiedby",
  "absoluteurl",
] satisfies (keyof DocumentRow)[];

function documentManagementOff(table: Table, cause?: unknown): Error {
  return new Error(
    `Document management is not enabled for the table '${table.logicalName}' (entity set '${table.entitySet}'), so its records have no SharePoint documents.`,
    cause === undefined ? undefined : { cause },
  );
}

/** What the agent is told when the list is not the whole folder. */
function partialNote(
  listed: number,
  { totalCount: total, totalCountExceeded: exceeded }: FetchResult<unknown>,
): string | undefined {
  if (exceeded) {
    return `Only the ${listed} most recently modified files are listed; the folder holds more than ${total}.`;
  }
  if (total !== undefined) {
    return total > listed
      ? `Only the ${listed} most recently modified of ${total} files are listed.`
      : undefined;
  }
  return listed >= MAX_FILES
    ? `Only the ${listed} most recently modified files are listed; the folder may hold more.`
    : undefined;
}

async function tableOf(
  client: DataverseClient,
  entitySet: string,
): Promise<Table> {
  const table = await findEntitySet<TableDefinition>(
    client,
    entitySet,
    "EntitySetName,LogicalName,PrimaryIdAttribute,IsDocumentManagementEnabled",
  );
  if (!table?.LogicalName || !table.PrimaryIdAttribute) {
    throw unknownEntitySet(entitySet);
  }
  return {
    entitySet,
    logicalName: table.LogicalName,
    primaryId: table.PrimaryIdAttribute,
    documentManagement: table.IsDocumentManagementEnabled === true,
  };
}

/**
 * The file's path inside the record's folder, as SharePoint names it.
 * `relativelocation` is the path in the document library: the record's
 * folder (a document location's `relativeurl`), the subfolders as they are
 * named, and the file name percent-encoded. The file name is taken from
 * `fullname` rather than decoded, so a `%` in a folder name is left alone.
 * When no location's folder starts the path, the whole path is kept.
 */
function pathInFolder(row: DocumentRow, folders: string[]): string | null {
  const location = row.relativelocation;
  if (location === undefined) return row.fullname ?? null;
  const folder = folders
    .filter((f) => location.startsWith(`${f}/`))
    .reduce<string | undefined>(
      (longest, f) => (longest && longest.length >= f.length ? longest : f),
      undefined,
    );
  const segments = (
    folder === undefined ? location : location.slice(folder.length + 1)
  ).split("/");
  if (row.fullname !== undefined) {
    segments[segments.length - 1] = row.fullname;
  }
  return segments.join("/");
}

/** A failed documents query in the agent's terms, or the error as it was. */
function toAgentError(err: unknown, table: Table): unknown {
  if (!(err instanceof DataverseApiError)) return err;
  switch (err.code?.toLowerCase()) {
    case SHAREPOINT_AUTHORIZATION_FAILURE:
      return new Error(
        `SharePoint refused Dataverse access to the record's documents (${SHAREPOINT_AUTHORIZATION_FAILURE}, SharePointAuthorizationFailure). Reading SharePoint documents through the Dataverse API needs a one-time setup by an administrator: an Entra app with SharePoint permissions, linked to Dataverse through a managed identity and a federated credential. Either it has not been done, or it is incomplete. See ${SETUP_ARTICLE}`,
        { cause: err },
      );
    case SP_NOT_ENABLED_FOR_ENTITY:
      return documentManagementOff(table, err);
    default:
      return err;
  }
}

export function registerDocumentsReadTools(
  server: ToolRegistrar,
  deps: ToolDeps,
): void {
  const { client, entitySets } = deps;
  server.registerTool(
    "list_record_documents",
    {
      // Remove "and no tool here downloads a file" when #94 lands.
      description:
        "List the files in a record's SharePoint document folder, the ones its Documents tab shows, files in subfolders included; only reads. Returns { files: [{ name, path, file_type, size_bytes, modified_on, modified_by, url }], total }: at most 100 files, most recently modified first, where path is relative to the record's folder and url is the file's SharePoint address as Dataverse gives it; when the folder holds more files, a note says so and total gives their number. A record without a document folder gets a message saying so instead of a list. An unknown entity set, a table with document management off, a record that does not exist or that the caller may not read, and a missing one-time admin setup for reading SharePoint documents through the Dataverse API are errors. It returns no file content, and no tool here downloads a file. To read the record itself, use get_record.",
      inputSchema: LIST_RECORD_DOCUMENTS_INPUT,
    },
    async ({ entity_set, id }) => {
      assertEntitySetName(entity_set);
      assertRecordId(id);
      await entitySets?.assertExists(entity_set);

      const table = await tableOf(client, entity_set);
      if (!table.documentManagement) {
        throw documentManagementOff(table);
      }

      // Dataverse does not check access to the record behind its documents:
      // reading the record first applies the caller's privileges, so the
      // tool shows no more than get_record would.
      await client.get(
        `/${entity_set}(${id})${buildODataQuery({ $select: table.primaryId })}`,
      );

      const locations = (await client.get(
        `/sharepointdocumentlocations${buildODataQuery({
          $select: "relativeurl",
          $filter: `_regardingobjectid_value eq ${id}`,
        })}`,
      )) as { value?: { relativeurl?: string }[] };
      const folders = (locations.value ?? [])
        .map((l) => l.relativeurl)
        .filter((f): f is string => typeof f === "string" && f !== "");
      // The documents query must not run for a record without a folder:
      // Dataverse then creates a document location for the record, a write,
      // and answers with an empty list, the same as for an empty folder.
      if ((locations.value ?? []).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `The record ${entity_set}(${id}) has no SharePoint document folder: no document location points to it, so there are no documents to list.`,
            },
          ],
        };
      }

      let result: FetchResult<DocumentRow>;
      try {
        result = await runFetchXml<DocumentRow>(client, "sharepointdocuments", {
          entity: "sharepointdocument",
          attributes: DOCUMENT_ATTRIBUTES,
          // Files from every subfolder, and no rows for the folders.
          conditions: [
            { attribute: "isrecursivefetch", operator: "eq", value: "1" },
          ],
          // A condition on regardingobjectid alone is refused (0x8006073b);
          // the join to the record's table is what Dataverse accepts.
          links: [
            {
              entity: table.logicalName,
              from: table.primaryId,
              to: "regardingobjectid",
              conditions: [
                { attribute: table.primaryId, operator: "eq", value: id },
              ],
            },
          ],
          order: { attribute: "modified", descending: true },
          count: MAX_FILES,
          totalCount: true,
        });
      } catch (err) {
        throw toAgentError(err, table);
      }

      const files = result.rows.map((row) => ({
        name: row.fullname ?? null,
        path: pathInFolder(row, folders),
        file_type: row.filetype ?? null,
        size_bytes: row.filesize ?? null,
        modified_on: row.modified ?? null,
        modified_by: row.sharepointmodifiedby ?? null,
        url: row.absoluteurl ?? null,
      }));
      const total = result.totalCount;
      const note = partialNote(files.length, result);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                files,
                ...(total !== undefined && { total }),
                ...(note && { note }),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
