// An agent image is written at `join(root, name)`. What the rule constrains is that destination, not
// how the name is spelled: it has to stay inside the chosen root and must not be the root itself.
//
// The check and the writer have to agree on the path, so both derive it with `join`. These cases pin
// the refusals (a parent escape, a grandparent, the root itself, a symlinked parent, and an absolute
// name that reaches a symlinked child) and the names that stay welcome (the manifest round-trip's
// punctuation, a long name, a backslash on macOS and Linux, a space, and an absolute name that lands
// inside the root).

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { resolveAgentImageDestination } from "../src/domain/agent-images/agent-image-destination.js";
import type { AgentImageManifest } from "../src/domain/agent-images/agent-image-types.js";

function manifest(name: string): AgentImageManifest {
  return {
    name,
    version: "1",
    runtime: "claude-code",
    sourceSeat: "dev@fixture",
    sourceSessionId: "conversation",
    sourceResumeToken: "conversation",
    createdAt: new Date().toISOString(),
    files: [],
  };
}

function makeLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false; // this host will not make a link without extra privilege
  }
}

function installFailure(name: string, rootPath: string): unknown {
  const library = new AgentImageLibraryService({ roots: [{ path: rootPath, sourceType: "user_file" }] });
  try {
    library.install(rootPath, manifest(name), new Map());
  } catch (error) {
    return error;
  }
  return null;
}

let root: string | undefined;
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("refused destinations", () => {
  it.each([
    ["the root's parent", ".."],
    ["a sibling", "../escaped"],
    ["a grandparent", "../../escaped"],
    ["the root itself", "."],
  ])("refuses %s and creates nothing", (_label, name) => {
    root = mkdtempSync(join(tmpdir(), "openrig-image-root-"));
    expect(resolveAgentImageDestination(root, name).ok).toBe(false);
    expect(installFailure(name, root)).toMatchObject({ name: "AgentImageError", code: "manifest_invalid" });
    const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
    library.scan();
    expect(library.list()).toEqual([]);
    expect(existsSync(join(root, "..", "escaped"))).toBe(false);
  });

  it("refuses a destination whose parent is a symlink out of the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "openrig-image-outside-"));
    root = mkdtempSync(join(tmpdir(), "openrig-image-root-"));
    scratch.push(outside);
    if (!makeLink(outside, join(root, "link"))) return;

    expect(resolveAgentImageDestination(root, "link/escaped").ok).toBe(false);
    expect(installFailure("link/escaped", root)).toMatchObject({ name: "AgentImageError", code: "manifest_invalid" });
    expect(existsSync(join(outside, "escaped"))).toBe(false);
  });

  it("refuses an absolute name that would reach a symlinked child", () => {
    const outside = mkdtempSync(join(tmpdir(), "openrig-image-outside-"));
    root = mkdtempSync(join(tmpdir(), "openrig-image-root-"));
    scratch.push(outside);
    // `join(root, "/library/escaped")` is `root/library/escaped`, and `root/library` is the link.
    if (!makeLink(outside, join(root, "library"))) return;

    const destination = resolveAgentImageDestination(root, "/library/escaped");
    expect(destination.ok).toBe(false);
    expect(installFailure("/library/escaped", root)).toMatchObject({ name: "AgentImageError", code: "manifest_invalid" });
    expect(existsSync(join(outside, "escaped"))).toBe(false);
  });
});

describe("retained names", () => {
  // A colon cannot be part of a filename on Windows, so those installs are a macOS/Linux case.
  it.skipIf(process.platform === "win32").each(["review:baseline", "model: fast"])(
    "installs and finds the name %s",
    (name) => {
      root = mkdtempSync(join(tmpdir(), "openrig-image-named-"));
      const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
      const destination = resolveAgentImageDestination(root, name);
      expect(destination.ok).toBe(true);
      const dir = library.install(root, manifest(name), new Map());
      expect(dir).toBe(join(root, name));
      expect(existsSync(join(dir, "manifest.yaml"))).toBe(true);
      library.scan();
      expect(library.list().map((entry) => entry.id)).toEqual([`agent-image:${name}:1`]);
    },
  );

  const longName = "a".repeat(201);
  it("installs and finds a 201-character name", () => {
    root = mkdtempSync(join(tmpdir(), "openrig-image-long-"));
    const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
    expect(resolveAgentImageDestination(root, longName).ok).toBe(true);
    const dir = library.install(root, manifest(longName), new Map());
    expect(existsSync(join(dir, "manifest.yaml"))).toBe(true);
    library.scan();
    expect(library.list()).toHaveLength(1);
  });

  // On macOS and Linux a backslash is an ordinary filename character, so the name stays one entry and
  // the scanner finds it. On Windows it separates, so the install nests instead: still inside the
  // root, but not a directory the scanner reads as an image.
  it.skipIf(process.platform === "win32")("installs and finds a backslash-containing name", () => {
    root = mkdtempSync(join(tmpdir(), "openrig-image-backslash-"));
    const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
    const name = "team\\baseline";
    expect(resolveAgentImageDestination(root, name).ok).toBe(true);
    const dir = library.install(root, manifest(name), new Map());
    expect(dir).toBe(join(root, name));
    library.scan();
    expect(library.list()).toHaveLength(1);
  });

  it("keeps a name that is a single space inside the root", () => {
    // The install contract is a nonempty string; containment, not trimming, is what this checks.
    root = mkdtempSync(join(tmpdir(), "openrig-image-space-"));
    expect(resolveAgentImageDestination(root, " ")).toMatchObject({ ok: true, targetDir: join(root, " ") });
  });

  it("keeps an absolute name that lands inside the root", () => {
    root = mkdtempSync(join(tmpdir(), "openrig-image-absolute-"));
    const destination = resolveAgentImageDestination(root, "/nested/inside");
    expect(destination).toMatchObject({ ok: true, targetDir: join(root, "nested", "inside") });
  });

  it.each(["snapshot", "normal-name", "#notes", "true", "123", "null", "ünïcode-name"])(
    "installs and finds the name %s",
    (name) => {
      root = mkdtempSync(join(tmpdir(), "openrig-image-plain-"));
      const library = new AgentImageLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
      expect(resolveAgentImageDestination(root, name).ok).toBe(true);
      library.install(root, manifest(name), new Map());
      library.scan();
      expect(library.list()).toHaveLength(1);
    },
  );
});

describe("a root that does not exist yet", () => {
  it("installs under a root reached through a symlinked parent", () => {
    const physical = mkdtempSync(join(tmpdir(), "openrig-image-physical-"));
    const alias = `${physical}-alias`;
    scratch.push(physical);
    if (!makeLink(physical, alias)) return;

    const missingRoot = join(alias, "images");
    const destination = resolveAgentImageDestination(missingRoot, "snapshot");
    expect(destination).toMatchObject({ ok: true, targetDir: join(alias, "images", "snapshot") });

    const library = new AgentImageLibraryService({ roots: [{ path: missingRoot, sourceType: "user_file" }] });
    library.install(missingRoot, manifest("snapshot"), new Map());
    expect(existsSync(join(physical, "images", "snapshot", "manifest.yaml"))).toBe(true);
    rmSync(alias, { recursive: true, force: true });
  });
});
