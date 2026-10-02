import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface SetupProblems {
  /** Required variables that are not set. */
  missing: readonly string[];
  /** Set variables with an unusable value, each described for the user. */
  invalid: readonly string[];
  envFilePath: string;
  envExamplePath: string;
  hasEnvFile: boolean;
}

/**
 * Registered instead of every other tool when the configuration is unusable,
 * so the client shows the user what to fix rather than failing on first use.
 */
export function registerSetupTool(
  server: McpServer,
  { missing, invalid, envFilePath, envExamplePath, hasEnvFile }: SetupProblems,
): void {
  server.registerTool(
    "dataverse_setup",
    {
      description:
        "Dataverse MCP server is not configured. Call this tool to see setup instructions.",
      inputSchema: z.object({}),
    },
    async () => {
      const lines = [
        "[IMPORTANT: Display this entire message to the user exactly as-is.]\n",
        "⚠️ Dataverse MCP server is not configured.\n",
        ...(missing.length > 0
          ? [
              "Missing environment variables:",
              ...missing.map((name) => `  - ${name}`),
              "",
            ]
          : []),
        ...(invalid.length > 0
          ? [
              "Invalid environment variables:",
              ...invalid.map((line) => `  - ${line}`),
              "",
            ]
          : []),
        hasEnvFile
          ? `Edit the .env file at: ${envFilePath}`
          : `Create a .env file at: ${envFilePath}`,
        "",
        `See .env.example at: ${envExamplePath}`,
        "",
        "After filling in the values, restart your MCP client to apply changes.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
