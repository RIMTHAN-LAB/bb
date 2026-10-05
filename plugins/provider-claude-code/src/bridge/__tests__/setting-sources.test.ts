import { describe, expect, it } from "vitest";
import { resolveClaudeSettingSources } from "../session-options.js";

describe("resolveClaudeSettingSources", () => {
  it("keeps the full cascade when unset or naming no known source", () => {
    for (const value of [undefined, "", " ", "none", "managed,policy"]) {
      expect(
        resolveClaudeSettingSources(
          value === undefined ? {} : { BB_CLAUDE_CODE_SETTING_SOURCES: value },
        ),
      ).toEqual(["user", "project", "local"]);
    }
  });

  it("narrows to the named sources in cascade order and drops unknown names", () => {
    expect(
      resolveClaudeSettingSources({ BB_CLAUDE_CODE_SETTING_SOURCES: "user" }),
    ).toEqual(["user"]);
    expect(
      resolveClaudeSettingSources({
        BB_CLAUDE_CODE_SETTING_SOURCES: " local , user,projct",
      }),
    ).toEqual(["user", "local"]);
  });
});
