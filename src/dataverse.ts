import { DataverseAuth } from "./auth.js";
import { DataverseClient } from "./client.js";
import {
  readRequestTimeoutMs,
  readServiceProtectionSettings,
} from "./config.js";
import { FetchExecutor } from "./executor.js";
import {
  type ServiceProtectionSettings,
  withServiceProtection,
} from "./service-protection.js";

// Shared by both entry points: the stdio package and the HTTP server read the
// same DATAVERSE_* variables and build the same client. What each does with
// bad settings, and which tools it registers, stays in the entry point.

const REQUIRED_VARS = [
  "DATAVERSE_TENANT_ID",
  "DATAVERSE_CLIENT_ID",
  "DATAVERSE_CLIENT_SECRET",
  "DATAVERSE_RESOURCE_URL",
] as const;

export interface DataverseSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  resourceUrl: string;
  entityPrefix?: string;
  solutionName?: string;
  allowDelete: boolean;
  requestTimeoutMs?: number;
  serviceProtection: ServiceProtectionSettings;
}

/**
 * The DATAVERSE_* settings from an environment. `settings` is present only
 * when nothing is missing or invalid.
 */
export function readDataverseSettings(
  env: Record<string, string | undefined>,
): {
  settings?: DataverseSettings;
  missing: string[];
  invalid: string[];
} {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);

  const invalid: string[] = [];
  const requestTimeout = readRequestTimeoutMs(env.DATAVERSE_REQUEST_TIMEOUT_MS);
  if (!requestTimeout.ok) invalid.push(requestTimeout.problem);
  const serviceProtection = readServiceProtectionSettings(env);
  invalid.push(...serviceProtection.problems);

  if (!requestTimeout.ok || missing.length > 0 || invalid.length > 0) {
    return { missing, invalid };
  }

  return {
    missing,
    invalid,
    settings: {
      tenantId: env.DATAVERSE_TENANT_ID as string,
      clientId: env.DATAVERSE_CLIENT_ID as string,
      clientSecret: env.DATAVERSE_CLIENT_SECRET as string,
      resourceUrl: env.DATAVERSE_RESOURCE_URL as string,
      entityPrefix: env.DATAVERSE_ENTITY_PREFIX || undefined,
      solutionName: env.DATAVERSE_SOLUTION_NAME || undefined,
      allowDelete: env.DATAVERSE_ALLOW_DELETE === "true",
      requestTimeoutMs: requestTimeout.value,
      serviceProtection: serviceProtection.settings,
    },
  };
}

/**
 * The Dataverse client for a process. Build it once: it holds the token cache
 * and the throttling state, which the per-request (HTTP) and per-connection
 * (stdio) server factories share (ADR-0001 §5).
 */
export function createDataverseClient(
  settings: DataverseSettings,
): DataverseClient {
  const auth = new DataverseAuth(
    settings.tenantId,
    settings.clientId,
    settings.clientSecret,
    settings.resourceUrl,
    { timeoutMs: settings.requestTimeoutMs },
  );
  return new DataverseClient(auth, settings.resourceUrl, {
    executor: withServiceProtection(
      new FetchExecutor(settings.requestTimeoutMs),
      settings.serviceProtection,
    ),
  });
}
