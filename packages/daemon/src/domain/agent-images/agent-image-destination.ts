// Where an agent image may be written.
//
// An image name becomes a directory name. The rule here is about the DESTINATION, not about the
// spelling, and the destination it judges is the one `install()` writes: both use `join(root, name)`,
// because `resolve(root, name)` would disagree with the writer for an absolute name and the check
// would then be judging a path nothing writes to. Whatever the name, the directory has to stay inside
// the chosen root and must not be the root itself. A name like `../escaped` fails on containment, and
// so does a path that reaches a symlink leaving the root; a name with a colon, a backslash or 201
// characters is fine as long as it lands inside.
//
// The captured file paths beside the name are checked the same way, a few lines further into
// `install()`.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export type AgentImageDestination =
  | { ok: true; targetDir: string }
  | { ok: false; message: string };

function fold(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** `child` inside `parent`, or equal to it. */
function isInside(parent: string, child: string): boolean {
  const parentFolded = fold(parent);
  const childFolded = fold(child);
  if (childFolded === parentFolded) return true;
  const withSep = parentFolded.endsWith(sep) ? parentFolded : `${parentFolded}${sep}`;
  return childFolded.startsWith(withSep);
}

/**
 * The path with its deepest existing ancestor resolved through any symlinks, and the rest appended.
 * For a path that does not exist yet this is where the operating system would really write, and it is
 * also how a root that does not exist yet keeps its canonical representation.
 */
function canonical(path: string): string {
  const rest: string[] = [];
  let head = path;
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return path;
    rest.unshift(basename(head));
    head = parent;
  }
  try {
    return resolve(realpathSync(head), ...rest);
  } catch {
    return path;
  }
}

/**
 * The directory this install would create, or why it may not be created.
 *
 * Returned rather than thrown so the writer can wrap a refusal in an `AgentImageError` and write to
 * exactly the path that was judged.
 */
export function resolveAgentImageDestination(rootPath: string, name: unknown): AgentImageDestination {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, message: "an agent image needs a name to write under the library root" };
  }
  const root = resolve(rootPath);
  // The same derivation `install()` uses for the directory it creates; `join` keeps an absolute name
  // under the root, which is what the writer does, so validation and writing cannot disagree.
  const targetDir = join(root, name);
  if (targetDir === root) {
    return { ok: false, message: `agent image name '${name}' names the library root itself (${root}), not a directory inside it` };
  }
  if (!isInside(root, targetDir)) {
    return { ok: false, message: `agent image name '${name}' would be written at ${targetDir}, outside the library root ${root}` };
  }
  // A parent on the way can be a symlink: the lexical path stays inside the root while the kernel
  // walks out of it. Both sides are canonicalised, including a root that does not exist yet, so a
  // contained destination reached through a link is not a false refusal.
  const realRoot = canonical(root);
  const realTarget = canonical(targetDir);
  if (!isInside(realRoot, realTarget)) {
    return { ok: false, message: `agent image name '${name}' would be written at ${realTarget}, outside the library root ${realRoot} once a symlinked parent is followed` };
  }
  return { ok: true, targetDir };
}
