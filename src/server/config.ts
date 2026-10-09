import { z } from "zod";
import { readWholeNumber } from "../config.js";
import type { Permissions } from "../tools/permissions.js";
import type { ServerToolGroup } from "../tools/server-groups.js";
import { OPERATION_NAME } from "../tools/shared/operations.js";
import { ENTITY_SET_NAME } from "../tools/shared/paths.js";

/**
 * One bearer token the server accepts. The token itself is never stored, only
 * its SHA-256, so the config file does not hand out access to whoever reads it
 * (ADR-0001 §7).
 */
export interface TokenEntry {
  /** Who the token was issued to; it identifies the caller in logs. */
  name: string;
  /** SHA-256 of the token, lower-case hex. */
  sha256: string;
  /** ISO 8601 date and time with a time zone; absent means no expiry. */
  expiresAt?: string;
  /** The name of the role in `roles`. */
  role: string;
  /**
   * The Microsoft Entra object id of the Dataverse user the token's calls are
   * made on behalf of; absent means as the server's application user.
   */
  actAs?: string;
}

/** What a role may do (ADR-0001 §8). */
export interface Role {
  groups: ServerToolGroup[];
  permissions: Permissions;
}

/** The server's JSON config file. Changes apply on restart. */
export interface ServerConfig {
  roles: Record<string, Role>;
  tokens: TokenEntry[];
}

// Kept in step with SERVER_TOOL_GROUPS by tests/server/config.test.ts. Listed
// here rather than imported, so reading the config does not load the tools.
export const ROLE_GROUPS = [
  "metadata-read",
  "data-read",
  "data-write",
  "actions",
  "functions",
] as const satisfies readonly ServerToolGroup[];

// Allowlist entries have the shapes the tools accept, so a name that could
// never match is a config error. They match exactly, as Dataverse does.
// An Entra object id goes in a header as written: no braces.
const ENTRA_OBJECT_ID = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Lists name what they allow; there is no "*" (ADR-0002 §3, §5). For an
// operation it could not be told from a table (`invoke_function {name:
// "accounts"}` is `GET /accounts`), and for an entity set it would hide what
// the role may write.
const names = (pattern: RegExp, what: string) =>
  z.array(
    z
      .string()
      .regex(pattern, `expected ${what} ("*" is not accepted: list the names)`),
  );

const ENTITY_SETS = names(ENTITY_SET_NAME, "an entity set name, e.g. emails");
const OPERATIONS = names(
  OPERATION_NAME,
  "an operation name without a namespace, e.g. SendEmail",
);

const ROLE = z.strictObject({
  groups: z.array(z.enum(ROLE_GROUPS)).min(1, "at least one group is required"),
  dataWrite: z
    .strictObject({
      create: ENTITY_SETS.optional(),
      update: ENTITY_SETS.optional(),
      delete: ENTITY_SETS.optional(),
    })
    .optional(),
  actions: OPERATIONS.optional(),
  functions: OPERATIONS.optional(),
});

const TOKEN = z.strictObject({
  name: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "expected 64 hex digits")
    .transform((hex) => hex.toLowerCase()),
  expiresAt: z.iso
    .datetime({
      offset: true,
      message: "expected an ISO 8601 date and time with a time zone",
    })
    .optional(),
  role: z.string().min(1),
  actAs: z
    .string()
    .regex(
      ENTRA_OBJECT_ID,
      "expected the user's Microsoft Entra object id (a GUID)",
    )
    .optional(),
});

const CONFIG = z.strictObject({
  roles: z.record(z.string().min(1), ROLE),
  tokens: z.array(TOKEN).min(1, "at least one token is required"),
});

type RoleInput = z.infer<typeof ROLE>;

/**
 * A role's lists must agree with its groups: a list without its group grants
 * nothing, and a group without a list registers no tool. Either is a mistake
 * in the file, not a setting.
 */
function roleProblems(name: string, role: RoleInput): string[] {
  const at = `roles.${name}`;
  const problems = duplicates(role.groups).map(
    (group) => `${at}.groups: "${group}" is listed more than once`,
  );
  const writes = Object.values(role.dataWrite ?? {}).some((l) => l.length > 0);
  const listed: [ServerToolGroup, string, boolean][] = [
    ["data-write", "dataWrite", writes],
    ["actions", "actions", (role.actions ?? []).length > 0],
    ["functions", "functions", (role.functions ?? []).length > 0],
  ];
  for (const [group, key, hasEntries] of listed) {
    const granted = role.groups.includes(group);
    if (granted && !hasEntries) {
      problems.push(
        `${at}: the "${group}" group needs entries in ${key}, or it gives no tools`,
      );
    }
    if (!granted && hasEntries) {
      problems.push(
        `${at}.${key}: has no effect without the "${group}" group in groups`,
      );
    }
  }
  return problems;
}

function toRole(role: RoleInput): Role {
  return {
    groups: role.groups,
    permissions: {
      create: role.dataWrite?.create ?? [],
      update: role.dataWrite?.update ?? [],
      delete: role.dataWrite?.delete ?? [],
      actions: role.actions ?? [],
      functions: role.functions ?? [],
    },
  };
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}

/**
 * The server config from the text of its file, or a line for each problem.
 * Nothing is defaulted around a mistake: a server that starts with a config
 * other than the one written is worse than one that does not start.
 */
export function readServerConfig(
  text: string,
): { ok: true; config: ServerConfig } | { ok: false; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      problems: [`not valid JSON: ${(err as Error).message}`],
    };
  }

  const parsed = CONFIG.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }

  const { roles, tokens } = parsed.data;
  const problems = [
    ...Object.entries(roles).flatMap(([name, role]) =>
      roleProblems(name, role),
    ),
    ...tokens
      .filter((t) => !Object.hasOwn(roles, t.role))
      .map(
        (t) =>
          `tokens: "${t.name}" has the role "${t.role}", which is not in roles`,
      ),
    ...duplicates(tokens.map((t) => t.name)).map(
      (name) => `tokens: the name "${name}" is used more than once`,
    ),
    ...duplicates(tokens.map((t) => t.sha256)).map(
      (hash) =>
        `tokens: the same sha256 is listed more than once (${hash.slice(0, 8)}…)`,
    ),
  ];
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      roles: Object.fromEntries(
        Object.entries(roles).map(([name, role]) => [name, toRole(role)]),
      ),
      tokens,
    },
  };
}

export interface ListenSettings {
  host: string;
  port: number;
  /** DATAVERSE_SERVER_CONFIG: the JSON file read by readServerConfig. */
  configPath: string;
}

/**
 * Where the server listens and where its config file is. The host defaults to the
 * loopback interface, so a server started by hand is not reachable from the
 * network until that is asked for; a container sets
 * DATAVERSE_SERVER_HOST=0.0.0.0. Not plain HOST: tcsh and some CI images
 * export HOST as the machine's name, which would bind the server to a
 * network interface without anyone asking. PORT stays plain, because
 * platforms such as Railway set it for the process to use.
 */
export function readListenSettings(
  env: Record<string, string | undefined>,
): { ok: true; settings: ListenSettings } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const configPath = env.DATAVERSE_SERVER_CONFIG;
  if (!configPath) {
    problems.push(
      "DATAVERSE_SERVER_CONFIG is not set (the path to the server's JSON config file)",
    );
  }
  const port = readWholeNumber("PORT", env.PORT, { min: 1, max: 65_535 });
  if (!port.ok) problems.push(port.problem);

  if (!port.ok || !configPath) return { ok: false, problems };
  return {
    ok: true,
    settings: {
      host: env.DATAVERSE_SERVER_HOST || "127.0.0.1",
      port: port.value ?? 3000,
      configPath,
    },
  };
}

/**
 * Tokens whose expiry has passed. They are not a config error, since an
 * expired token is a normal stage of rotation, but the operator should hear
 * about them at startup rather than from a client's 401.
 */
export function expiredTokens(
  tokens: readonly TokenEntry[],
  now: number = Date.now(),
): string[] {
  return tokens
    .filter((t) => t.expiresAt !== undefined && Date.parse(t.expiresAt) <= now)
    .map((t) => t.name);
}
