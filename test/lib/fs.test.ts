import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
});

async function importFsWithHome(home: string) {
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => home }));
  return import("../../src/lib/fs.js");
}

describe("collapseHome", () => {
  it("collapses POSIX paths inside the home directory", async () => {
    const { collapseHome } = await importFsWithHome("/Users/kun");

    expect(collapseHome("/Users/kun/.codex/auth.json")).toBe(
      "~/.codex/auth.json",
    );
    expect(collapseHome("/Users/kun")).toBe("~");
  });

  it("collapses Windows paths inside the home directory", async () => {
    const { collapseHome } = await importFsWithHome("C:\\Users\\kun");

    expect(collapseHome("C:\\Users\\kun\\.codex\\auth.json")).toBe(
      "~/.codex/auth.json",
    );
    expect(collapseHome("C:\\Users\\kun")).toBe("~");
  });

  it("does not collapse sibling paths with the same prefix", async () => {
    const { collapseHome } = await importFsWithHome("C:\\Users\\kun");

    expect(collapseHome("C:\\Users\\kun-other\\auth.json")).toBe(
      "C:\\Users\\kun-other\\auth.json",
    );
  });

  it("does not collapse relative paths", async () => {
    const { collapseHome } = await importFsWithHome("/Users/kun");

    expect(collapseHome("quota-axi")).toBe("quota-axi");
  });
});
