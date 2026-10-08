import { describe, expect, it } from "vitest";
import { readListenSettings } from "../../src/server/config.js";

describe("readListenSettings", () => {
  it("defaults to port 3000 on the loopback interface", () => {
    expect(readListenSettings({ DATAVERSE_SERVER_CONFIG: "/c.json" })).toEqual(
      {
        ok: true,
        settings: { host: "127.0.0.1", port: 3000, configPath: "/c.json" },
      },
    );
  });

  it("reads HOST and PORT", () => {
    expect(
      readListenSettings({
        DATAVERSE_SERVER_CONFIG: "/c.json",
        HOST: "0.0.0.0",
        PORT: "8080",
      }),
    ).toEqual({
      ok: true,
      settings: { host: "0.0.0.0", port: 8080, configPath: "/c.json" },
    });
  });

  it("names a missing config path and a bad port", () => {
    const result = readListenSettings({ PORT: "80a" });
    expect(result).toEqual({
      ok: false,
      problems: [
        "DATAVERSE_SERVER_CONFIG is not set (the path to the server's JSON config file)",
        "PORT=80a (expected a whole number from 1 to 65535)",
      ],
    });
  });

  it.each(["0", "65536", " 80", "8e3"])("rejects PORT=%s", (port) => {
    const result = readListenSettings({
      DATAVERSE_SERVER_CONFIG: "/c.json",
      PORT: port,
    });
    expect(result.ok).toBe(false);
  });
});
