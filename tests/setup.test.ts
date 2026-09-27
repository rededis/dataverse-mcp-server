import { describe, expect, it } from "vitest";
import { registerSetupTool, type SetupProblems } from "../src/setup.js";
import { createMockServer } from "./helpers.js";

const paths = {
  envFilePath: "/app/.env",
  envExamplePath: "/app/.env.example",
  hasEnvFile: true,
};

async function setupMessage(
  problems: Pick<SetupProblems, "missing" | "invalid">,
) {
  const server = createMockServer();
  registerSetupTool(server as any, { ...paths, ...problems });
  const result = await server.tools.get("dataverse_setup")!.handler({});
  return result.content[0].text as string;
}

describe("dataverse_setup", () => {
  it("lists missing variables", async () => {
    const text = await setupMessage({
      missing: ["DATAVERSE_CLIENT_SECRET"],
      invalid: [],
    });
    expect(text).toContain(
      "Missing environment variables:\n  - DATAVERSE_CLIENT_SECRET",
    );
    expect(text).not.toContain("Invalid environment variables");
  });

  it("lists an invalid value on its own, without a Missing block", async () => {
    const text = await setupMessage({
      missing: [],
      invalid: ["DATAVERSE_REQUEST_TIMEOUT_MS=abc (expected …)"],
    });
    expect(text).toContain(
      "Invalid environment variables:\n  - DATAVERSE_REQUEST_TIMEOUT_MS=abc (expected …)",
    );
    expect(text).not.toContain("Missing environment variables");
    expect(text).toContain("Edit the .env file at: /app/.env");
  });

  it("lists both when both apply", async () => {
    const text = await setupMessage({
      missing: ["DATAVERSE_TENANT_ID"],
      invalid: ["DATAVERSE_REQUEST_TIMEOUT_MS=0 (expected …)"],
    });
    expect(text).toContain("Missing environment variables:");
    expect(text).toContain("Invalid environment variables:");
  });
});
