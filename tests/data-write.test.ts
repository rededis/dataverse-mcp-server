import { describe, expect, it, vi } from "vitest";
import type { DataverseClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/all.js";
import { registerDataWriteTools } from "../src/tools/data-write.js";
import { NO_PERMISSIONS, type Permissions } from "../src/tools/permissions.js";
import { createMockServer, GUID, stdio } from "./helpers.js";

const mockClient = {} as DataverseClient;

function writeTools(permissions: Partial<Permissions>, client = mockClient) {
  const server = createMockServer();
  registerDataWriteTools(server as any, {
    client,
    permissions: { ...NO_PERMISSIONS, ...permissions },
  });
  return server.tools;
}

function writingClient() {
  return {
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
}

describe("delete_record on stdio", () => {
  it("is a stub pointing at DATAVERSE_ALLOW_DELETE when deleting is off", async () => {
    const server = createMockServer();
    registerAllTools(server as any, { client: mockClient, ...stdio(false) });

    const deleteTool = server.tools.get("delete_record");
    expect(deleteTool).toBeDefined();
    expect(deleteTool!.description).toContain("disabled");

    const result = await deleteTool!.handler({ entity_set: "leads", id: GUID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DATAVERSE_ALLOW_DELETE");
  });

  it("deletes any entity set when deleting is on", async () => {
    const server = createMockServer();
    const client = { delete: vi.fn() } as any;
    registerAllTools(server as any, { client, ...stdio(true) });

    const deleteTool = server.tools.get("delete_record");
    expect(deleteTool!.description).not.toContain("disabled");

    await deleteTool!.handler({ entity_set: "leads", id: GUID });
    expect(client.delete).toHaveBeenCalledWith(`/leads(${GUID})`);
  });
});

describe("registration follows the permissions", () => {
  it("registers nothing without permissions", () => {
    const server = createMockServer();
    registerDataWriteTools(server as any, { client: mockClient });
    expect([...server.tools.keys()]).toEqual([]);
  });

  it("registers only the operations with entries, and no delete stub", () => {
    const tools = writeTools({ create: ["emails"] });
    expect([...tools.keys()]).toEqual(["create_record"]);
  });
});

describe("allowlists", () => {
  it("creates in a listed entity set and refuses an unlisted one", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: ["emails", "tasks"] },
      client as unknown as DataverseClient,
    );
    const create = tools.get("create_record")!.handler;

    await create({ entity_set: "emails", data: { subject: "Hi" } });
    expect(client.post).toHaveBeenCalledWith("/emails", { subject: "Hi" });

    await expect(
      create({ entity_set: "contacts", data: { firstname: "A" } }),
    ).rejects.toThrow(
      "Not permitted: create in 'contacts'. This token is allowed: emails, tasks.",
    );
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("matches entity sets case-sensitively, as Dataverse does", async () => {
    const tools = writeTools({ create: ["emails"] });
    await expect(
      tools.get("create_record")!.handler({ entity_set: "Emails", data: {} }),
    ).rejects.toThrow(/Not permitted/);
  });

  it("refuses an update or delete outside its own list", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: "*", update: ["tasks"], delete: ["tasks"] },
      client as unknown as DataverseClient,
    );
    await expect(
      tools
        .get("update_record")!
        .handler({ entity_set: "accounts", id: GUID, data: {} }),
    ).rejects.toThrow("Not permitted: update in 'accounts'");
    await expect(
      tools.get("delete_record")!.handler({ entity_set: "accounts", id: GUID }),
    ).rejects.toThrow("Not permitted: delete from 'accounts'");

    await tools
      .get("delete_record")!
      .handler({ entity_set: "tasks", id: GUID });
    expect(client.delete).toHaveBeenCalledWith(`/tasks(${GUID})`);
    expect(client.patch).not.toHaveBeenCalled();
  });
});

describe("update_record", () => {
  // A PATCH to a missing id would create the record (upsert), so an update
  // grant would also be a create grant.
  it("updates only an existing record", async () => {
    const client = writingClient();
    const tools = writeTools(
      { update: ["accounts"] },
      client as unknown as DataverseClient,
    );
    await tools
      .get("update_record")!
      .handler({ entity_set: "accounts", id: GUID, data: { name: "A" } });
    expect(client.patch).toHaveBeenCalledWith(
      `/accounts(${GUID})`,
      { name: "A" },
      { "If-Match": "*" },
    );
  });
});

describe("path arguments", () => {
  // fetch resolves `..`, so this id would reach /accounts(<id>) through a
  // list that names only emails.
  it.each([
    [
      "an id that climbs out of the record",
      "emails",
      `${GUID})/../accounts(${GUID}`,
    ],
    ["an encoded climb", "emails", `${GUID})/%2e%2e/accounts(${GUID}`],
    ["an id that is not a GUID", "emails", "123"],
  ])("refuses %s before any request", async (_, entity_set, id) => {
    const client = writingClient();
    const tools = writeTools(
      { delete: ["emails"], update: ["emails"] },
      client as unknown as DataverseClient,
    );
    await expect(
      tools.get("delete_record")!.handler({ entity_set, id }),
    ).rejects.toThrow(/Invalid record id/);
    await expect(
      tools.get("update_record")!.handler({ entity_set, id, data: {} }),
    ).rejects.toThrow(/Invalid record id/);
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it.each([
    "emails/../accounts",
    "emails(1)",
    "emails?$x=1",
    "",
  ])("refuses the entity set %j, even with create allowed for any", async (entity_set) => {
    const client = writingClient();
    const tools = writeTools(
      { create: "*" },
      client as unknown as DataverseClient,
    );
    await expect(
      tools.get("create_record")!.handler({ entity_set, data: {} }),
    ).rejects.toThrow(/Invalid entity set name/);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe("nested records (deep insert)", () => {
  const party = {
    "partyid_contact@odata.bind": `/contacts(${GUID})`,
    participationtypemask: 2,
  };

  it("refuses a nested record when the create list is restricted", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: ["emails"] },
      client as unknown as DataverseClient,
    );
    await expect(
      tools.get("create_record")!.handler({
        entity_set: "emails",
        data: {
          subject: "Hi",
          regardingobjectid_account_email: { name: "New" },
        },
      }),
    ).rejects.toThrow(
      /Nested or linked records are not permitted for this token: 'regardingobjectid_account_email'/,
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("lets activity parties through, which address an email", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: ["emails"] },
      client as unknown as DataverseClient,
    );
    const data = { subject: "Hi", email_activity_parties: [party] };
    await tools.get("create_record")!.handler({ entity_set: "emails", data });
    expect(client.post).toHaveBeenCalledWith("/emails", data);
  });

  it("refuses an activity party that nests a record of its own", async () => {
    const tools = writeTools({ create: ["emails"] });
    await expect(
      tools.get("create_record")!.handler({
        entity_set: "emails",
        data: {
          email_activity_parties: [
            { participationtypemask: 2, partyid_contact: { lastname: "New" } },
          ],
        },
      }),
    ).rejects.toThrow(/Nested or linked records are not permitted/);
  });

  it.each([
    [
      "a custom relationship that only ends like activity parties",
      { new_x_activity_parties: [{ name: "New account" }] },
    ],
    [
      "a party without a participation type",
      {
        email_activity_parties: [
          { "parentaccountid@odata.bind": `/accounts(${GUID})` },
        ],
      },
    ],
    [
      "a party with another field",
      { email_activity_parties: [{ participationtypemask: 2, name: "X" }] },
    ],
  ])("refuses %s", async (_, data) => {
    const tools = writeTools({ create: ["emails"] });
    await expect(
      tools.get("create_record")!.handler({ entity_set: "emails", data }),
    ).rejects.toThrow(/Nested or linked records are not permitted/);
  });

  it("lets a lookup of the new record through", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: ["emails"] },
      client as unknown as DataverseClient,
    );
    const data = {
      "regardingobjectid_account_email@odata.bind": `/accounts(${GUID})`,
    };
    await tools.get("create_record")!.handler({ entity_set: "emails", data });
    expect(client.post).toHaveBeenCalledWith("/emails", data);
  });

  // On a one-to-many relationship Dataverse writes the lookup of each listed
  // record: creating an account would re-parent existing tasks, a table the
  // role may not update.
  it("refuses a link that would rewrite existing records", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: ["accounts"] },
      client as unknown as DataverseClient,
    );
    await expect(
      tools.get("create_record")!.handler({
        entity_set: "accounts",
        data: { name: "A", "Account_Tasks@odata.bind": [`/tasks(${GUID})`] },
      }),
    ).rejects.toThrow(
      /Nested or linked records are not permitted for this token: 'Account_Tasks@odata.bind'/,
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it("checks updates the same way", async () => {
    const tools = writeTools({ update: ["emails"] });
    await expect(
      tools.get("update_record")!.handler({
        entity_set: "emails",
        id: GUID,
        data: { regardingobjectid_account_email: { name: "New" } },
      }),
    ).rejects.toThrow(/Nested or linked records are not permitted/);
  });

  it("allows nested records when the list allows any entity set", async () => {
    const client = writingClient();
    const tools = writeTools(
      { create: "*" },
      client as unknown as DataverseClient,
    );
    const data = { name: "A", contact_customer_accounts: [{ lastname: "B" }] };
    await tools.get("create_record")!.handler({ entity_set: "accounts", data });
    expect(client.post).toHaveBeenCalledWith("/accounts", data);
  });
});

describe("unknown entity sets", () => {
  // With create allowed for any entity set, POST /<name> could otherwise
  // call an unbound action outside the actions group.
  it("refuses a name that is not an entity set, before writing", async () => {
    const client = writingClient();
    const server = createMockServer();
    registerDataWriteTools(server as any, {
      client: client as unknown as DataverseClient,
      permissions: { ...NO_PERMISSIONS, create: "*" },
      entitySets: {
        assertExists: vi
          .fn()
          .mockRejectedValue(new Error("Unknown entity set")),
      } as any,
    });
    await expect(
      server.tools
        .get("create_record")!
        .handler({ entity_set: "WinOpportunity", data: {} }),
    ).rejects.toThrow("Unknown entity set");
    expect(client.post).not.toHaveBeenCalled();
  });
});
