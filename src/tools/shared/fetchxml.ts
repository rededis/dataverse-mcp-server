// FetchXML that the server writes itself, each query for a purpose it knows
// (#200). Agents never send FetchXML: on the server every table a query
// touches, the joined ones included, would then have to be checked against
// the role. Here the code that builds a query fixes its tables.

import type { DataverseClient } from "../../client.js";
import { assertEntitySetName, assertLogicalName } from "./paths.js";

/** `<condition attribute=… operator="eq" value=…/>`: only equality is needed so far. */
interface FetchCondition {
  attribute: string;
  operator: "eq";
  value: string;
}

/** An inner join (`link-entity`) to another table, filtered on its own columns. */
interface FetchLink {
  /** The joined table's logical name. */
  entity: string;
  /** Its column that holds the value of `to`. */
  from: string;
  /** The column of the outer table. */
  to: string;
  conditions: FetchCondition[];
}

export interface FetchQuery {
  /** The logical name of the table queried. */
  entity: string;
  /** Listed by name: `<all-attributes/>` fails on some virtual tables. */
  attributes: string[];
  /** Combined with "and". */
  conditions?: FetchCondition[];
  links?: FetchLink[];
  order?: { attribute: string; descending: boolean };
  /** Rows on the one page read. */
  count?: number;
  /** Ask Dataverse for the number of matching rows, counted up to 5000. */
  totalCount?: boolean;
}

export interface FetchResult<T> {
  rows: T[];
  /** With `totalCount`: the number of matching rows, at most 5000. */
  totalCount?: number;
  /** With `totalCount`: more rows match than were counted. */
  totalCountExceeded?: boolean;
}

// Dataverse sends the count only when the request asks for these
// annotations; without the header the response has the rows alone.
const TOTAL_COUNT = "Microsoft.Dynamics.CRM.totalrecordcount";
const TOTAL_COUNT_EXCEEDED =
  "Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded";
const TOTAL_COUNT_PREFER = `odata.include-annotations="${TOTAL_COUNT},${TOTAL_COUNT_EXCEEDED}"`;

/** A table or column name, checked before it goes into the XML. */
function logicalName(value: string): string {
  assertLogicalName(value, "FetchXML name");
  return value;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function filterXml(conditions: FetchCondition[] | undefined): string {
  if (!conditions || conditions.length === 0) return "";
  const inner = conditions
    .map(
      (c) =>
        `<condition attribute="${logicalName(c.attribute)}" operator="${c.operator}" value="${escapeAttribute(c.value)}"/>`,
    )
    .join("");
  return `<filter type="and">${inner}</filter>`;
}

/** The query as FetchXML. Names are checked; values are escaped. */
function toFetchXml(query: FetchQuery): string {
  const fetch = [
    query.count !== undefined && `count="${Math.trunc(query.count)}"`,
    query.totalCount && `returntotalrecordcount="true"`,
  ].filter(Boolean);
  const attributes = query.attributes
    .map((a) => `<attribute name="${logicalName(a)}"/>`)
    .join("");
  const order = query.order
    ? `<order attribute="${logicalName(query.order.attribute)}" descending="${query.order.descending}"/>`
    : "";
  const links = (query.links ?? [])
    .map(
      (l) =>
        `<link-entity name="${logicalName(l.entity)}" from="${logicalName(l.from)}" to="${logicalName(l.to)}" link-type="inner">${filterXml(l.conditions)}</link-entity>`,
    )
    .join("");
  return `<fetch${fetch.map((a) => ` ${a}`).join("")}><entity name="${logicalName(query.entity)}">${attributes}${order}${filterXml(query.conditions)}${links}</entity></fetch>`;
}

/**
 * Sends the query as `GET /<entitySet>?fetchXml=…` and reads the one page
 * that comes back. There is no paging: `morerecords` is true on any full
 * page, the last one included, so it cannot say whether another exists.
 */
export async function runFetchXml<T>(
  client: DataverseClient,
  entitySet: string,
  query: FetchQuery,
): Promise<FetchResult<T>> {
  assertEntitySetName(entitySet);
  const path = `/${entitySet}?fetchXml=${encodeURIComponent(toFetchXml(query))}`;
  const page = (await client.request(
    path,
    query.totalCount ? { headers: { Prefer: TOTAL_COUNT_PREFER } } : {},
  )) as Record<string, unknown> & { value?: T[] };
  const total = page[`@${TOTAL_COUNT}`];
  const exceeded = page[`@${TOTAL_COUNT_EXCEEDED}`];
  return {
    rows: page.value ?? [],
    ...(typeof total === "number" && total >= 0 && { totalCount: total }),
    ...(exceeded === true && { totalCountExceeded: true }),
  };
}
