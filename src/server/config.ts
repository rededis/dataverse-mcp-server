import { z } from "zod";
import { readWholeNumber } from "../config.js";

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
}

/** The server's JSON config file. Changes apply on restart. */
export interface ServerConfig {
  tokens: TokenEntry[];
}

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
});

const CONFIG = z.strictObject({
  tokens: z.array(TOKEN).min(1, "at least one token is required"),
});

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

  const { tokens } = parsed.data;
  const problems = [
    ...duplicates(tokens.map((t) => t.name)).map(
      (name) => `tokens: the name "${name}" is used more than once`,
    ),
    ...duplicates(tokens.map((t) => t.sha256)).map(
      (hash) =>
        `tokens: the same sha256 is listed more than once (${hash.slice(0, 8)}…)`,
    ),
  ];
  if (problems.length > 0) return { ok: false, problems };

  return { ok: true, config: parsed.data };
}

export interface ListenSettings {
  host: string;
  port: number;
  /** DATAVERSE_SERVER_CONFIG: the JSON file read by readServerConfig. */
  configPath: string;
}

/**
 * Where the server listens and where its config file is. HOST defaults to the
 * loopback interface, so a server started by hand is not reachable from the
 * network until that is asked for; a container sets HOST=0.0.0.0.
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
      host: env.HOST || "127.0.0.1",
      port: port.value ?? 3000,
      configPath,
    },
  };
}
