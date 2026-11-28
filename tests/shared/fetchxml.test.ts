import { describe, expect, it, vi } from "vitest";
import type { DataverseClient } from "../../src/client.js";
import {
  type FetchQuery,
  runFetchXml,
} from "../../src/tools/shared/fetchxml.js";

/** The FetchXML that runFetchXml sends for a query. */
async function toFetchXml(query: FetchQuery): Promise<string> {
  const client = { request: vi.fn(async (_path: string) => ({ value: [] })) };
  await runFetchXml(client as unknown as DataverseClient, "accounts", query);
  const path = client.request.mock.calls[0]![0];
  return decodeURIComponent(path.slice(path.indexOf("fetchXml=") + 9));
}

describe("the FetchXML of a query", () => {
  it("has the attributes, order, filter and join of the query", async () => {
    expect(
      await toFetchXml({
        entity: "sharepointdocument",
        attributes: ["fullname", "modified"],
        conditions: [
          { attribute: "isrecursivefetch", operator: "eq", value: "1" },
        ],
        links: [
          {
            entity: "lead",
            from: "leadid",
            to: "regardingobjectid",
            conditions: [{ attribute: "leadid", operator: "eq", value: "x" }],
          },
        ],
        order: { attribute: "modified", descending: true },
        count: 100,
        totalCount: true,
      }),
    ).toBe(
      '<fetch count="100" returntotalrecordcount="true">' +
        '<entity name="sharepointdocument">' +
        '<attribute name="fullname"/><attribute name="modified"/>' +
        '<order attribute="modified" descending="true"/>' +
        '<filter type="and"><condition attribute="isrecursivefetch" operator="eq" value="1"/></filter>' +
        '<link-entity name="lead" from="leadid" to="regardingobjectid" link-type="inner">' +
        '<filter type="and"><condition attribute="leadid" operator="eq" value="x"/></filter>' +
        "</link-entity></entity></fetch>",
    );
  });

  it("leaves out what the query does not set", async () => {
    expect(await toFetchXml({ entity: "account", attributes: ["name"] })).toBe(
      '<fetch><entity name="account"><attribute name="name"/></entity></fetch>',
    );
  });

  // A value that closed the attribute would add conditions of its own.
  it("escapes condition values", async () => {
    const xml = await toFetchXml({
      entity: "account",
      attributes: ["name"],
      conditions: [
        {
          attribute: "name",
          operator: "eq",
          value: `a"/><condition attribute="x" operator="eq" value='&<>`,
        },
      ],
    });
    expect(xml).toContain(
      'value="a&quot;/&gt;&lt;condition attribute=&quot;x&quot; operator=&quot;eq&quot; value=&apos;&amp;&lt;&gt;"',
    );
    expect(xml.match(/<condition /g)).toHaveLength(1);
  });

  it.each([
    ["entity", { entity: "lead x", attributes: ["a"] }],
    ["attribute", { entity: "lead", attributes: ['a"/>'] }],
    [
      "order attribute",
      {
        entity: "lead",
        attributes: ["a"],
        order: { attribute: "a b", descending: false },
      },
    ],
    [
      "joined table",
      {
        entity: "lead",
        attributes: ["a"],
        links: [{ entity: "<x>", from: "a", to: "b", conditions: [] }],
      },
    ],
  ])("refuses a %s that is not a logical name", async (_what, query) => {
    await expect(toFetchXml(query as FetchQuery)).rejects.toThrow(
      /Not a logical name/,
    );
  });
});

describe("runFetchXml", () => {
  function client(page: unknown) {
    return { request: vi.fn(async () => page) };
  }

  it("sends the query encoded in the fetchXml parameter and reads the rows", async () => {
    const c = client({ value: [{ name: "Contoso" }] });
    const result = await runFetchXml(
      c as unknown as DataverseClient,
      "accounts",
      { entity: "account", attributes: ["name"] },
    );
    expect(result).toEqual({ rows: [{ name: "Contoso" }] });
    const [path, options] = c.request.mock.calls[0] as unknown as [
      string,
      unknown,
    ];
    expect(path).toBe(
      `/accounts?fetchXml=${encodeURIComponent('<fetch><entity name="account"><attribute name="name"/></entity></fetch>')}`,
    );
    expect(options).toEqual({});
  });

  // Recorded: without the Prefer header, the response carries no count.
  it("asks for the total count annotations and reads them", async () => {
    const c = client({
      "@odata.count": 5,
      "@Microsoft.Dynamics.CRM.totalrecordcount": 22,
      "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": false,
      value: [],
    });
    const result = await runFetchXml(
      c as unknown as DataverseClient,
      "accounts",
      { entity: "account", attributes: ["name"], count: 5, totalCount: true },
    );
    expect(result).toEqual({ rows: [], totalCount: 22 });
    expect(c.request.mock.calls[0]).toEqual([
      expect.any(String),
      {
        headers: {
          Prefer:
            'odata.include-annotations="Microsoft.Dynamics.CRM.totalrecordcount,Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"',
        },
      },
    ]);
  });

  it("says when more rows match than Dataverse counts", async () => {
    const c = client({
      "@Microsoft.Dynamics.CRM.totalrecordcount": 5000,
      "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": true,
      value: [],
    });
    expect(
      await runFetchXml(c as unknown as DataverseClient, "accounts", {
        entity: "account",
        attributes: ["name"],
        totalCount: true,
      }),
    ).toEqual({ rows: [], totalCount: 5000, totalCountExceeded: true });
  });

  // Dataverse answers -1 when the count was not computed.
  it("ignores a count of -1", async () => {
    const c = client({
      "@Microsoft.Dynamics.CRM.totalrecordcount": -1,
      value: [],
    });
    expect(
      await runFetchXml(c as unknown as DataverseClient, "accounts", {
        entity: "account",
        attributes: ["name"],
        totalCount: true,
      }),
    ).toEqual({ rows: [] });
  });
});
