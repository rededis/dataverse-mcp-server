import { describe, expect, it } from "vitest";
import type { DataverseClient } from "../src/client.js";
import {
  DataverseApiError,
  DataverseCallerDeniedError,
  RefusedError,
} from "../src/errors.js";
import { registerDocumentsReadTools } from "../src/tools/documents-read.js";
import { EntitySetCatalog } from "../src/tools/shared/paths.js";
import { createMockServer, fetchXmlOf, GUID, notFound } from "./helpers.js";

// Responses below have the shape the dev org returned for the same requests
// (2026-11-28), with names, hosts and ids replaced.

const FOLDER = `Contoso Lead_${GUID.replace(/-/g, "").toUpperCase()}`;
const SITE = "https://contoso.sharepoint.com/sites/CRMDocs/lead";

const LEAD_TABLE = {
  "@odata.context":
    "https://org.crm.dynamics.com/api/data/v9.2/$metadata#EntityDefinitions(EntitySetName,LogicalName,PrimaryIdAttribute,IsDocumentManagementEnabled)",
  value: [
    {
      MetadataId: "44444444-4444-4444-4444-444444444444",
      IsDocumentManagementEnabled: true,
      LogicalName: "lead",
      PrimaryIdAttribute: "leadid",
      EntitySetName: "leads",
    },
  ],
};

const LEAD = { "@odata.etag": 'W/"1"', leadid: GUID };

const LOCATIONS = {
  value: [
    {
      "@odata.etag": 'W/"2"',
      relativeurl: FOLDER,
      sharepointdocumentlocationid: "22222222-2222-2222-2222-222222222222",
    },
  ],
};

// A file in a subfolder: the folder segment as it is named, the file name
// percent-encoded in lower-case hex. A literal % in a folder name stays.
const IN_SUBFOLDER = {
  documentid: 101,
  absoluteurl: `${SITE}/${FOLDER}/Verträge 2026/%c3%85ngstr%c3%b6m%20report.docx`,
  filesize: 20480,
  filetype: "docx",
  fullname: "Ångström report.docx",
  modified: "2026-11-20T09:30:00Z",
  relativelocation: `${FOLDER}/Verträge 2026/%c3%85ngstr%c3%b6m%20report.docx`,
  sharepointmodifiedby: "Test User",
};
const PERCENT_FOLDER = {
  documentid: 102,
  absoluteurl: `${SITE}/${FOLDER}/100% done/plan.txt`,
  filesize: 12,
  filetype: "txt",
  fullname: "plan.txt",
  modified: "2026-11-19T16:05:00Z",
  relativelocation: `${FOLDER}/100% done/plan.txt`,
  sharepointmodifiedby: "Test User",
};
const AT_TOP = {
  documentid: 103,
  absoluteurl: `${SITE}/${FOLDER}/scan_2026-01-10.png`,
  filesize: 15000,
  filetype: "png",
  fullname: "scan_2026-01-10.png",
  modified: "2026-01-10T12:00:00Z",
  relativelocation: `${FOLDER}/scan_2026-01-10.png`,
  sharepointmodifiedby: "SharePoint App",
};

function documents(rows: unknown[], total = rows.length) {
  return {
    "@odata.context":
      "https://org.crm.dynamics.com/api/data/v9.2/$metadata#sharepointdocuments(documentid,absoluteurl,relativelocation,sharepointmodifiedby,filetype,fullname,modified,filesize)",
    "@odata.count": rows.length,
    "@Microsoft.Dynamics.CRM.totalrecordcount": total,
    "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": false,
    value: rows,
  };
}

interface Answers {
  table?: unknown;
  record?: unknown;
  locations?: unknown;
  documents?: unknown;
}

/** A Dataverse that answers by path, and the requests it got. */
function fakeDataverse(answers: Answers) {
  const requests: { path: string; options?: unknown }[] = [];
  const answer = async (path: string, options?: unknown) => {
    requests.push({ path, ...(options !== undefined && { options }) });
    const found = path.startsWith("/EntityDefinitions?")
      ? answers.table
      : path.startsWith("/sharepointdocumentlocations?")
        ? answers.locations
        : path.startsWith("/sharepointdocuments?")
          ? answers.documents
          : answers.record;
    if (found instanceof Error) throw found;
    if (found === undefined) throw new Error(`Unexpected request: ${path}`);
    return found;
  };
  // Only reads: no post, patch or delete for the tool to call.
  const client = {
    get: (path: string) => answer(path),
    request: (path: string, options?: unknown) => answer(path, options),
  };
  return { client: client as unknown as DataverseClient, requests };
}

const ANSWERS: Answers = {
  table: LEAD_TABLE,
  record: LEAD,
  locations: LOCATIONS,
  documents: documents([IN_SUBFOLDER, PERCENT_FOLDER, AT_TOP]),
};

function tool(client: DataverseClient, entitySets?: EntitySetCatalog) {
  const server = createMockServer();
  registerDocumentsReadTools(server, { client, entitySets });
  return server.tools.get("list_record_documents")!;
}

async function list(
  answers: Answers,
  args = { entity_set: "leads", id: GUID },
) {
  const dataverse = fakeDataverse(answers);
  const result = await tool(dataverse.client).handler(args);
  const text = result.content[0].text as string;
  return { text, requests: dataverse.requests };
}

const paths = (requests: { path: string }[]) =>
  requests.map((r) => r.path.slice(0, r.path.indexOf("?") + 1 || undefined));

describe("list_record_documents", () => {
  it("lists the files of the record's folder and its subfolders, newest first", async () => {
    const { text } = await list(ANSWERS);
    expect(JSON.parse(text)).toEqual({
      files: [
        {
          name: "Ångström report.docx",
          path: "Verträge 2026/Ångström report.docx",
          file_type: "docx",
          size_bytes: 20480,
          modified_on: "2026-11-20T09:30:00Z",
          modified_by: "Test User",
          url: IN_SUBFOLDER.absoluteurl,
        },
        {
          name: "plan.txt",
          path: "100% done/plan.txt",
          file_type: "txt",
          size_bytes: 12,
          modified_on: "2026-11-19T16:05:00Z",
          modified_by: "Test User",
          url: PERCENT_FOLDER.absoluteurl,
        },
        {
          name: "scan_2026-01-10.png",
          path: "scan_2026-01-10.png",
          file_type: "png",
          size_bytes: 15000,
          modified_on: "2026-01-10T12:00:00Z",
          modified_by: "SharePoint App",
          url: AT_TOP.absoluteurl,
        },
      ],
      total: 3,
    });
  });

  it("checks the table, reads the record, finds its folder, then queries the documents", async () => {
    const { requests } = await list(ANSWERS);
    expect(paths(requests)).toEqual([
      "/EntityDefinitions?",
      `/leads(${GUID})?`,
      "/sharepointdocumentlocations?",
      "/sharepointdocuments?",
    ]);
    expect(decodeURIComponent(requests[1]!.path)).toBe(
      `/leads(${GUID})?$select=leadid`,
    );
    // Every request is a read: get, or request without a method.
    expect(
      requests.every(
        (r) => !JSON.stringify(r.options ?? {}).includes("method"),
      ),
    ).toBe(true);
  });

  // A record of another table with the same id, or an inactive location,
  // must not pass for the record's folder.
  it("looks for the record's active document locations, joined to its table", async () => {
    const { requests } = await list(ANSWERS);
    expect(fetchXmlOf(requests[2]!.path)).toBe(
      '<fetch><entity name="sharepointdocumentlocation">' +
        '<attribute name="sharepointdocumentlocationid"/><attribute name="relativeurl"/>' +
        '<filter type="and"><condition attribute="statecode" operator="eq" value="0"/></filter>' +
        `<link-entity name="lead" from="leadid" to="regardingobjectid" link-type="inner"><filter type="and"><condition attribute="leadid" operator="eq" value="${GUID}"/></filter></link-entity>` +
        "</entity></fetch>",
    );
  });

  it("asks for at most 100 files in all subfolders, joined to the record, newest first, with the total", async () => {
    const { requests } = await list(ANSWERS);
    const xml = fetchXmlOf(requests[3]!.path);
    expect(xml).toMatch(/^<fetch count="100" returntotalrecordcount="true">/);
    expect(xml).toContain('<entity name="sharepointdocument">');
    expect(xml).toContain(
      '<condition attribute="isrecursivefetch" operator="eq" value="1"/>',
    );
    expect(xml).toContain('<order attribute="modified" descending="true"/>');
    expect(xml).toContain(
      `<link-entity name="lead" from="leadid" to="regardingobjectid" link-type="inner"><filter type="and"><condition attribute="leadid" operator="eq" value="${GUID}"/></filter></link-entity>`,
    );
    expect(xml).not.toContain("all-attributes");
    // Without it, a folder with a subfolder fails (0x80040216).
    expect(xml).toContain('<attribute name="documentid"/>');
    expect(requests[3]!.options).toEqual({
      headers: { Prefer: expect.stringContaining("totalrecordcount") },
    });
  });

  it("says when the folder holds more files than it lists", async () => {
    const rows = Array.from({ length: 100 }, () => AT_TOP);
    const { text } = await list({
      ...ANSWERS,
      documents: documents(rows, 250),
    });
    const result = JSON.parse(text);
    expect(result.files).toHaveLength(100);
    expect(result.total).toBe(250);
    expect(result.note).toBe(
      "Only the 100 most recently modified of 250 files are listed.",
    );
  });

  // Beyond 5000, Dataverse's count is its limit, not the folder's total.
  it("gives no total when the folder holds more files than Dataverse counts", async () => {
    const rows = Array.from({ length: 100 }, () => AT_TOP);
    const { text } = await list({
      ...ANSWERS,
      documents: {
        ...documents(rows, 5000),
        "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": true,
      },
    });
    const result = JSON.parse(text);
    expect(result.total).toBeUndefined();
    expect(result.note).toBe(
      "Only the 100 most recently modified files are listed; the folder holds more than 5000.",
    );
  });

  it("says the folder holds more when the count limit comes without a count", async () => {
    const rows = Array.from({ length: 100 }, () => AT_TOP);
    const { text } = await list({
      ...ANSWERS,
      documents: {
        "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": true,
        value: rows,
      },
    });
    expect(JSON.parse(text).note).toBe(
      "Only the 100 most recently modified files are listed; the folder holds more than 100.",
    );
  });

  it("says a full list may not be all when the count is missing", async () => {
    const rows = Array.from({ length: 100 }, () => AT_TOP);
    const { text } = await list({ ...ANSWERS, documents: { value: rows } });
    const result = JSON.parse(text);
    expect(result.total).toBeUndefined();
    expect(result.note).toBe(
      "Only the 100 most recently modified files are listed; the folder may hold more.",
    );
  });

  it("gives an empty list for an empty folder", async () => {
    const { text } = await list({ ...ANSWERS, documents: documents([]) });
    expect(JSON.parse(text)).toEqual({ files: [], total: 0 });
  });

  // For a record without one, the documents query makes Dataverse create a
  // document location: a write.
  it("says a record without a document location has no folder, and does not query documents", async () => {
    const { text, requests } = await list({
      ...ANSWERS,
      locations: { value: [] },
    });
    expect(text).toBe(
      `The record leads(${GUID}) has no SharePoint document folder that this caller can see: no active document location points to it, so there are no documents to list.`,
    );
    expect(paths(requests)).not.toContain("/sharepointdocuments?");
  });

  it("keeps the whole path when no location's folder starts it", async () => {
    const { text } = await list({
      ...ANSWERS,
      locations: { value: [{ relativeurl: "Another folder" }] },
      documents: documents([AT_TOP]),
    });
    expect(JSON.parse(text).files[0].path).toBe(
      `${FOLDER}/scan_2026-01-10.png`,
    );
  });

  it("decodes the file name of a path when the row has no fullname", async () => {
    const { fullname: _a, ...encoded } = IN_SUBFOLDER;
    const { fullname: _b, ...malformed } = {
      ...AT_TOP,
      relativelocation: `${FOLDER}/100%.txt`,
    };
    const { text } = await list({
      ...ANSWERS,
      documents: documents([encoded, malformed]),
    });
    expect(JSON.parse(text).files.map((f: { path: string }) => f.path)).toEqual(
      ["Verträge 2026/Ångström report.docx", "100%.txt"],
    );
  });

  it("refuses a table with document management off before any record or document request", async () => {
    const dataverse = fakeDataverse({
      ...ANSWERS,
      table: {
        value: [
          {
            IsDocumentManagementEnabled: false,
            LogicalName: "activitymonitor",
            PrimaryIdAttribute: "activitymonitorid",
            EntitySetName: "activitymonitors",
          },
        ],
      },
    });
    await expect(
      tool(dataverse.client).handler({
        entity_set: "activitymonitors",
        id: GUID,
      }),
    ).rejects.toThrow(
      "Document management is not enabled for the table 'activitymonitor' (entity set 'activitymonitors'), so its records have no SharePoint documents.",
    );
    expect(paths(dataverse.requests)).toEqual(["/EntityDefinitions?"]);
  });

  // Constructed: the dev org's restricted user was not re-run here. With
  // actAs, the client turns a 403 into DataverseCallerDeniedError.
  it("stops when the caller may not read the record", async () => {
    const denied = new DataverseCallerDeniedError(
      { method: "GET", url: `/leads(${GUID})` },
      JSON.stringify({
        error: {
          code: "0x80040220",
          message: "Principal user is missing prvReadLead privilege",
        },
      }),
      { name: "dave", objectId: "33333333-3333-3333-3333-333333333333" },
    );
    const dataverse = fakeDataverse({ ...ANSWERS, record: denied });
    await expect(
      tool(dataverse.client).handler({ entity_set: "leads", id: GUID }),
    ).rejects.toBe(denied);
    expect(paths(dataverse.requests)).toEqual([
      "/EntityDefinitions?",
      `/leads(${GUID})?`,
    ]);
  });

  it("stops when the record does not exist", async () => {
    const dataverse = fakeDataverse({ ...ANSWERS, record: notFound() });
    await expect(
      tool(dataverse.client).handler({ entity_set: "leads", id: GUID }),
    ).rejects.toThrow(/404/);
    expect(paths(dataverse.requests)).not.toContain(
      "/sharepointdocumentlocations?",
    );
  });

  // Recorded code and message; the status was not, and the tool reads only
  // the code.
  it("points to the setup article when SharePoint turns Dataverse away", async () => {
    const failure = new DataverseApiError(
      500,
      { method: "GET", url: "/sharepointdocuments" },
      JSON.stringify({
        error: {
          code: "0x800608B4",
          message: "The remote server returned 401 unauthorized error",
        },
      }),
    );
    const dataverse = fakeDataverse({ ...ANSWERS, documents: failure });
    const error = await tool(dataverse.client)
      .handler({ entity_set: "leads", id: GUID })
      .catch((e: unknown) => e);
    // The audit line logs the status and code of a DataverseApiError.
    expect(error).toBeInstanceOf(DataverseApiError);
    expect((error as DataverseApiError).status).toBe(500);
    expect((error as DataverseApiError).code).toBe("0x800608B4");
    expect((error as Error).message).toMatch(
      /^SharePoint refused Dataverse access to the record's documents \(0x800608b4, SharePointAuthorizationFailure\)\. Reading SharePoint documents through the Dataverse API needs a one-time setup by an administrator/,
    );
    expect((error as Error).message).toContain(
      "https://learn.microsoft.com/en-us/power-platform/admin/configure-azure-app-with-sharepoint-access",
    );
    expect((error as Error).cause).toBe(failure);
  });

  it("says document management is off when Dataverse answers so for the documents", async () => {
    const failure = new DataverseApiError(
      400,
      { method: "GET", url: "/sharepointdocuments" },
      JSON.stringify({
        error: {
          code: "0x8006073b",
          message:
            "SharePoint S2S and MSTeams integration is not enabled for this entity",
        },
      }),
    );
    const dataverse = fakeDataverse({ ...ANSWERS, documents: failure });
    const error = await tool(dataverse.client)
      .handler({ entity_set: "leads", id: GUID })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      "Document management is not enabled for the table 'lead' (entity set 'leads'), so its records have no SharePoint documents.",
    );
    expect(error).toBeInstanceOf(DataverseApiError);
    expect((error as DataverseApiError).code).toBe("0x8006073b");
    expect((error as Error).cause).toBe(failure);
  });

  it("passes other Dataverse errors on", async () => {
    const failure = new DataverseApiError(
      400,
      { method: "GET", url: "/sharepointdocuments" },
      JSON.stringify({ error: { code: "0x80040216", message: "Unexpected" } }),
    );
    const dataverse = fakeDataverse({ ...ANSWERS, documents: failure });
    await expect(
      tool(dataverse.client).handler({ entity_set: "leads", id: GUID }),
    ).rejects.toBe(failure);
  });

  it("refuses an entity set the metadata does not have", async () => {
    const dataverse = fakeDataverse({ ...ANSWERS, table: { value: [] } });
    const error = await tool(dataverse.client)
      .handler({ entity_set: "WhoAmI", id: GUID })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefusedError);
    expect((error as RefusedError).check).toBe("unknown-entity-set");
    expect(paths(dataverse.requests)).toEqual(["/EntityDefinitions?"]);
  });

  // The server checks the entity set as for the other data tools (ADR-0002 §4).
  it("checks the entity set in the server's catalog first", async () => {
    const dataverse = fakeDataverse(ANSWERS);
    const catalogClient = {
      get: async () => ({ value: [] }),
    } as unknown as DataverseClient;
    await expect(
      tool(dataverse.client, new EntitySetCatalog(catalogClient)).handler({
        entity_set: "leads",
        id: GUID,
      }),
    ).rejects.toThrow("Unknown entity set: 'leads'");
    expect(dataverse.requests).toEqual([]);
  });

  it.each([
    [{ entity_set: "leads/../WhoAmI", id: GUID }, /Invalid entity set name/],
    [
      { entity_set: "leads", id: `${GUID})/../contacts(${GUID}` },
      /Invalid record id/,
    ],
  ])("refuses the arguments %j before any request", async (args, message) => {
    const dataverse = fakeDataverse(ANSWERS);
    await expect(tool(dataverse.client).handler(args)).rejects.toThrow(message);
    expect(dataverse.requests).toEqual([]);
  });
});
