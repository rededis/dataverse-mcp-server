import { describe, expect, it, vi } from "vitest";
import { registerAllTools } from "../../src/tools/all.js";
import { createMockServer } from "../helpers.js";

describe("picklist location XOR validation", () => {
  const toolNames = [
    "add_picklist_option",
    "update_picklist_option",
    "delete_picklist_option",
    "get_picklist_options",
  ];

  for (const name of toolNames) {
    it(`${name}: throws when both Local and Global fields are provided`, async () => {
      const server = createMockServer();
      const client = { post: vi.fn(), get: vi.fn() } as any;
      // allowDelete=true so the delete_picklist_option real handler (not the stub) is registered
      registerAllTools(server as any, { client, allowDelete: true });

      await expect(
        server.tools.get(name)!.handler({
          entity_logical_name: "fundai_x",
          attribute_logical_name: "fundai_status",
          option_set_name: "MyGlobalSet",
          label: "L",
          value: 1,
        }),
      ).rejects.toThrow(/mutually exclusive/);
    });

    it(`${name}: throws when neither Local pair nor Global is provided`, async () => {
      const server = createMockServer();
      const client = { post: vi.fn(), get: vi.fn() } as any;
      registerAllTools(server as any, { client, allowDelete: true });

      await expect(
        server.tools.get(name)!.handler({ label: "L", value: 1 }),
      ).rejects.toThrow(/Provide either/);
    });

    it(`${name}: throws when Local pair is incomplete (entity only)`, async () => {
      const server = createMockServer();
      const client = { post: vi.fn(), get: vi.fn() } as any;
      registerAllTools(server as any, { client, allowDelete: true });

      await expect(
        server.tools.get(name)!.handler({
          entity_logical_name: "fundai_x",
          label: "L",
          value: 1,
        }),
      ).rejects.toThrow(/Provide either/);
    });
  }
});
