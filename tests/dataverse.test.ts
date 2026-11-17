import { describe, expect, it } from "vitest";
import { readDataverseSettings } from "../src/dataverse.js";

const REQUIRED = {
  DATAVERSE_TENANT_ID: "tenant",
  DATAVERSE_CLIENT_ID: "client",
  DATAVERSE_CLIENT_SECRET: "secret",
  DATAVERSE_RESOURCE_URL: "https://org.crm.dynamics.com",
};

describe("readDataverseSettings", () => {
  it("reads the connection and the optional settings", () => {
    const result = readDataverseSettings({
      ...REQUIRED,
      DATAVERSE_ENTITY_PREFIX: "new_",
      DATAVERSE_SOLUTION_NAME: "Core",
      DATAVERSE_ALLOW_DELETE: "true",
      DATAVERSE_REQUEST_TIMEOUT_MS: "5000",
      DATAVERSE_MAX_CONCURRENCY: "4",
    });
    expect(result).toEqual({
      missing: [],
      invalid: [],
      settings: {
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
        resourceUrl: "https://org.crm.dynamics.com",
        entityPrefix: "new_",
        solutionName: "Core",
        allowDelete: true,
        requestTimeoutMs: 5000,
        serviceProtection: { maxConcurrency: 4 },
      },
    });
  });

  it("treats empty optional settings as unset", () => {
    const result = readDataverseSettings({
      ...REQUIRED,
      DATAVERSE_ENTITY_PREFIX: "",
      DATAVERSE_ALLOW_DELETE: "yes",
    });
    expect(result.settings).toMatchObject({
      entityPrefix: undefined,
      allowDelete: false,
      requestTimeoutMs: undefined,
      serviceProtection: {},
    });
  });

  it("names missing and invalid variables and returns no settings", () => {
    const result = readDataverseSettings({
      DATAVERSE_TENANT_ID: "tenant",
      DATAVERSE_CLIENT_ID: "",
      DATAVERSE_REQUEST_TIMEOUT_MS: "soon",
      DATAVERSE_MAX_ATTEMPTS: "0",
    });
    expect(result.settings).toBeUndefined();
    expect(result.missing).toEqual([
      "DATAVERSE_CLIENT_ID",
      "DATAVERSE_CLIENT_SECRET",
      "DATAVERSE_RESOURCE_URL",
    ]);
    expect(result.invalid).toEqual([
      expect.stringContaining("DATAVERSE_REQUEST_TIMEOUT_MS=soon"),
      expect.stringContaining("DATAVERSE_MAX_ATTEMPTS=0"),
    ]);
  });
});
