import { describe, expect, it } from "vitest";
import { normalizeRemote, originUrl } from "../src/sync/remote";

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:Acme/Platform.git", "github.com/acme/platform"],
    ["https://github.com/acme/platform.git", "github.com/acme/platform"],
    ["https://token@github.com/acme/platform/", "github.com/acme/platform"],
    ["ssh://git@github.com:22/acme/platform.git", "github.com/acme/platform"],
    ["https://gitlab.example.com/group/sub/app", "gitlab.example.com/group/sub/app"],
  ])("%s", (input, expected) => {
    expect(normalizeRemote(input)).toBe(expected);
  });
});

describe("originUrl", () => {
  it("prefers origin", () => {
    const config = `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:up/app.git\n[remote "origin"]\n\turl = git@github.com:me/app.git\n`;
    expect(originUrl(config)).toBe("git@github.com:me/app.git");
  });

  it("falls back to the first remote", () => {
    expect(originUrl(`[remote "fork"]\n\turl = https://github.com/me/app\n`)).toBe("https://github.com/me/app");
  });

  it("returns undefined without remotes", () => {
    expect(originUrl("[core]\n\tbare = false\n")).toBeUndefined();
  });
});
