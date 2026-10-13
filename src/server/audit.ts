// The audit log (#78, ADR-0001 §12): one JSON line per tool call, and per
// request refused before it reached one, recording the call's shape and never
// its content. What sits in front of the server (a gateway, the agent's own
// logs) sees the arguments and results in full; this log holds only what the
// server alone knows: who called, what it was allowed, how it ended, and what
// it cost in Dataverse requests.
//
// Every name logged passes the audit code's own shape check (here, and for
// the tool name in mcp.ts), whatever the tool checked, so that a value sent
// where a name belongs never reaches the log. A value that fails is fingerprinted: its length, a few flags, and an
// HMAC under DATAVERSE_AUDIT_KEY when that is set. A plain hash would not do:
// the CRM itself is the dictionary that reverses the hash of an email.

import { createHmac } from "node:crypto";
import type { AuthInfo, CallToolResult } from "@modelcontextprotocol/server";
import {
  DataverseApiError,
  DataverseAuthError,
  DataverseBusyError,
  DataverseCallerDeniedError,
  DataverseError,
  DataverseNetworkError,
  DataverseTimeoutError,
  RefusedError,
} from "../errors.js";
import type { RequestObserver } from "../http.js";
import { bareOperationName } from "../tools/shared/operations.js";
import { ENTITY_SET_NAME, GUID, LOGICAL_NAME } from "../tools/shared/paths.js";

export interface AuditLine {
  type: "audit";
  time: string;
  [field: string]: unknown;
}

export interface AuditLogger {
  write(line: AuditLine): void;
}

interface LineStream {
  write(chunk: string, callback?: () => void): boolean;
}

/**
 * Writes each line to a stream, stdout in the server, which carries nothing
 * else. Lines are never dropped: `write` returning false is not acted on,
 * which at this server's volume costs only memory while stdout is slow.
 */
export class JsonLinesAuditLogger implements AuditLogger {
  constructor(private stream: LineStream) {}

  write(line: AuditLine): void {
    this.stream.write(`${JSON.stringify(line)}\n`);
  }

  /**
   * Resolves once every line written so far has left the process, or after
   * `timeoutMs`. stdout to a pipe is asynchronous, and process.exit() drops
   * what is still buffered; an empty write's callback runs after every
   * earlier write, and also on an error such as EPIPE.
   */
  flush(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.stream.write("", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export interface Fingerprint {
  length: number;
  hasAt: boolean;
  hasSpace: boolean;
  nonAscii: boolean;
  hmac?: string;
}

export function fingerprint(value: string, key?: string): Fingerprint {
  return {
    // Characters, not UTF-16 units: an `ё` is one.
    length: [...value].length,
    hasAt: value.includes("@"),
    hasSpace: /\s/.test(value),
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range.
    nonAscii: /[^\x00-\x7f]/.test(value),
    ...(key && {
      hmac: createHmac("sha256", key).update(value).digest("hex").slice(0, 16),
    }),
  };
}

const PLAIN_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * An id another system chose (a JSON-RPC id, an X-Request-Id): a number as
 * it is, a short plain string as it is, anything else fingerprinted.
 */
export function plainOrFingerprint(
  value: string | number,
  key?: string,
): string | number | Fingerprint {
  if (typeof value === "number" || PLAIN_ID.test(value)) return value;
  return fingerprint(value, key);
}

// A body key: a column's logical name, or a lookup set by `<nav>@odata.bind`.
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*(@odata\.bind)?$/;

function names(
  keys: readonly string[],
  shape: RegExp,
  key?: string,
): (string | Fingerprint)[] {
  return keys.map((k) => (shape.test(k) ? k : fingerprint(k, key)));
}

const ifShaped = (value: unknown, shape: RegExp) =>
  typeof value === "string" && shape.test(value) ? value : undefined;

const keysOf = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : undefined;

/**
 * What a call asked for, by name only. A name of the wrong shape is left
 * out when a tool refuses it anyway (its fingerprint comes with the
 * refusal), and fingerprinted where no tool checks it: columns, body field
 * names and action parameter names. Filters, order, expansions, bodies,
 * parameter values and list_entities' prefix and solution are never read.
 */
export function callFields(
  tool: string,
  args: Record<string, unknown>,
  key?: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => {
    if (value !== undefined) fields[name] = value;
  };

  if (tool === "invoke_action" || tool === "invoke_function") {
    if (typeof args.name === "string") {
      try {
        set("operation", bareOperationName(args.name));
      } catch {
        // Refused by the tool, which logs its fingerprint.
      }
    }
  }
  set("entitySet", ifShaped(args.entity_set, ENTITY_SET_NAME));
  set("id", ifShaped(args.id, GUID));
  if (typeof args.select === "string") {
    const columns = args.select.split(",").map((c) => c.trim());
    set("columns", names(columns, LOGICAL_NAME, key));
  }
  if (typeof args.top === "number") set("top", args.top);
  if (tool === "create_record" || tool === "update_record") {
    const keys = keysOf(args.data);
    if (keys) set("fields", names(keys, FIELD_NAME, key));
  }
  if (tool === "invoke_action" || tool === "invoke_function") {
    const keys = keysOf(args.parameters);
    if (keys) set("params", names(keys, LOGICAL_NAME, key));
  }
  set("entity", ifShaped(args.entity_logical_name, LOGICAL_NAME));
  set("attribute", ifShaped(args.attribute_logical_name, LOGICAL_NAME));
  set("optionSet", ifShaped(args.option_set_name, LOGICAL_NAME));
  return fields;
}

/**
 * The class of an error, from a fixed list: a bundler may rename classes, so
 * `constructor.name` is not reliable.
 */
function dataverseErrorClass(error: DataverseError): string {
  if (error instanceof DataverseCallerDeniedError)
    return "DataverseCallerDeniedError";
  if (error instanceof DataverseApiError) return "DataverseApiError";
  if (error instanceof DataverseBusyError) return "DataverseBusyError";
  if (error instanceof DataverseTimeoutError) return "DataverseTimeoutError";
  if (error instanceof DataverseNetworkError) return "DataverseNetworkError";
  if (error instanceof DataverseAuthError) return "DataverseAuthError";
  return "DataverseError";
}

/**
 * How a call that threw ended, from the fields src/errors.ts marks as safe
 * to log: never a message, a URL or a cause, which carry Dataverse's text
 * and the call's arguments.
 */
export function outcomeOf(
  error: unknown,
  key?: string,
): Record<string, unknown> {
  if (error instanceof RefusedError) {
    return {
      outcome: "refused",
      check: error.check,
      ...(error.value !== undefined && { got: fingerprint(error.value, key) }),
    };
  }
  if (error instanceof DataverseError) {
    const status =
      error instanceof DataverseApiError || error instanceof DataverseAuthError
        ? error.status
        : undefined;
    return {
      outcome: "dataverse-error",
      error: {
        class: dataverseErrorClass(error),
        ...(status !== undefined && { status }),
        ...(error instanceof DataverseApiError &&
          error.code !== undefined && { code: error.code }),
        ...(error instanceof DataverseBusyError && { reason: error.reason }),
      },
    };
  }
  return {
    outcome: "error",
    error: { class: error instanceof Error ? error.name : typeof error },
  };
}

function firstText(result: CallToolResult): unknown {
  const block = result.content?.[0];
  if (block?.type !== "text") return undefined;
  try {
    return JSON.parse(block.text);
  } catch {
    return undefined;
  }
}

const lengthOf = (value: unknown) =>
  Array.isArray(value) ? value.length : undefined;

// The record a create made, from OData-EntityId: `…/emails(<GUID>)`. A
// compound key (an elastic table's partitionid) is a value the caller chose,
// and is not logged.
const ENTITY_ID = /\(([^()]*)\)$/;

/**
 * How many items a successful call returned. `query_records` and the
 * operations count the rows of Dataverse's response; the metadata tools
 * count the items of their own result, which they filter and merge.
 */
export function resultFields(
  tool: string,
  result: CallToolResult,
  metrics: CallMetrics,
): Record<string, unknown> {
  switch (tool) {
    case "query_records":
      return { records: metrics.records, more: metrics.more };
    case "get_record":
      return { records: 1 };
    case "update_record":
    case "delete_record":
      return { records: 0 };
    case "create_record": {
      const entityId = (firstText(result) as Record<string, unknown>)?.[
        "@odata.entityId"
      ];
      const id =
        typeof entityId === "string"
          ? ENTITY_ID.exec(entityId)?.[1]
          : undefined;
      return { records: 0, ...(id && GUID.test(id) && { createdId: id }) };
    }
    case "invoke_action":
    case "invoke_function":
      return metrics.records === undefined ? {} : { records: metrics.records };
    case "get_picklist_options": {
      const records = lengthOf(
        (firstText(result) as Record<string, unknown>)?.options,
      );
      return records === undefined ? {} : { records };
    }
    default: {
      const records = lengthOf(firstText(result));
      return records === undefined ? {} : { records };
    }
  }
}

/**
 * The Dataverse requests one call made, from two observers: `data` for the
 * tool's own requests, `lookups` for the entity-set catalog's. Both count as
 * requests; only the tool's responses count as records.
 */
export class CallMetrics {
  private requests = 0;
  private retries = 0;
  private wasThrottled = false;
  private wasHeldBack = false;
  records?: number;
  more = false;

  private common: RequestObserver = {
    sent: () => {
      this.requests++;
    },
    retried: () => {
      this.retries++;
    },
    throttled: () => {
      this.wasThrottled = true;
    },
    heldBack: () => {
      this.wasHeldBack = true;
    },
  };

  readonly data: RequestObserver = {
    ...this.common,
    answered: ({ records, more }) => {
      if (records !== undefined) this.records = records;
      if (more) this.more = true;
    },
  };

  readonly lookups: RequestObserver = this.common;

  summary() {
    return {
      dataverseRequests: this.requests,
      throttled: this.wasThrottled,
      heldBack: this.wasHeldBack,
      retries: this.retries,
    };
  }
}

type Id = string | number | Fingerprint;

/**
 * What app.ts learns of a request before the MCP handler sees it, handed to
 * the server factory in `authInfo.extra`: the proxy's X-Request-Id, and for a
 * `tools/call` request the body's own id and tool name. A notification
 * carries no `call`, so it cannot fake a call's line.
 */
export interface RequestFacts {
  requestId?: Id;
  call?: { rpcId: Id; tool: string };
}

const FACTS = "dataverse-mcp-server/request";

export function withRequestFacts(
  authInfo: AuthInfo,
  facts: RequestFacts,
): AuthInfo {
  return { ...authInfo, extra: { ...authInfo.extra, [FACTS]: facts } };
}

export function requestFactsOf(authInfo: AuthInfo | undefined): RequestFacts {
  return (authInfo?.extra?.[FACTS] as RequestFacts | undefined) ?? {};
}

/**
 * The server's audit log: writes lines with the fingerprint key applied, and
 * keeps count of the tool calls still running, so that shutdown can wait
 * for their lines.
 */
export class AuditLog {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private logger: AuditLogger,
    /** DATAVERSE_AUDIT_KEY; without it fingerprints carry no HMAC. */
    readonly key?: string,
  ) {}

  write(fields: Record<string, unknown>, time: Date = new Date()): void {
    this.logger.write({ type: "audit", time: time.toISOString(), ...fields });
  }

  id(value: string | number): Id {
    return plainOrFingerprint(value, this.key);
  }

  begin(): () => void {
    this.running++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.running--;
      if (this.running === 0) {
        for (const resolve of this.waiting.splice(0)) resolve();
      }
    };
  }

  settled(timeoutMs: number): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
