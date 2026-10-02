import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildODataQuery, fetchAllPages } from "../shared/odata.js";
import type { ToolDeps } from "../types.js";

const LIST_SOLUTIONS_SHAPE = {
  include_managed: z
    .boolean()
    .optional()
    .describe(
      "Include managed solutions (default: false — only unmanaged are returned)",
    ),
};

export function registerSolutionTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  server.registerTool(
    "list_solutions",
    {
      description:
        "List Dataverse solutions (uniquename is used to filter list_entities)",
      inputSchema: LIST_SOLUTIONS_SHAPE,
    },
    async ({ include_managed }) => {
      const filters = ["isvisible eq true"];
      if (!include_managed) filters.push("ismanaged eq false");
      const query = buildODataQuery({
        $select: "solutionid,uniquename,friendlyname,version,ismanaged",
        $filter: filters.join(" and "),
        $orderby: "friendlyname",
      });
      const solutions = await fetchAllPages<unknown>(
        client,
        `/solutions${query}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(solutions, null, 2),
          },
        ],
      };
    },
  );
}
