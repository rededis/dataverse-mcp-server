import type { DataverseClient } from "../../client.js";

export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildODataQuery(
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

export async function fetchAllPages<T>(
  client: DataverseClient,
  path: string,
): Promise<T[]> {
  const results: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page = (await client.get(next)) as {
      value: T[];
      "@odata.nextLink"?: string;
    };
    results.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return results;
}
