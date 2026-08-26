#!/usr/bin/env node
/**
 * Fetch external plugins into frontend/plugins/ at build time, driven by the
 * PLUGIN_SOURCES env - the itzg/docker-minecraft-server model, adapted to a
 * build-time bundle: plugins compile into the app, so fetching happens
 * before `vite build`, and a redeploy is what publishes changes.
 *
 * PLUGIN_SOURCES is a comma/whitespace separated list of:
 *   https://github.com/user/repo         default branch (HEAD)
 *   https://github.com/user/repo#v1.2    pinned tag / branch / sha
 *   user/repo[#ref]                      shorthand for the above
 *   /abs/path or ./rel/path              local directory (dev, testing)
 *
 * Each source may contain ONE plugin (manifest.ts at its root) or a PACK
 * (plugin folders at the root or under plugins/). Anything fetched is
 * recorded in plugins/.fetched.json and wiped on the next run, so removing
 * an entry from the env removes the plugin on the next deploy. In-repo
 * plugins (wheel, poll) are never overwritten.
 *
 * Trust model: identical to the app itself - the operator ships this code,
 * unsandboxed, to every user of the instance. Only list sources you trust
 * like your own code, and pin refs for reproducible deploys.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../plugins");
const FETCHED_MANIFEST = join(PLUGINS_DIR, ".fetched.json");

function fail(msg) {
  console.error(`[fetch-plugins] ERROR: ${msg}`);
  process.exit(1);
}

function readFetchedList() {
  try {
    return JSON.parse(readFileSync(FETCHED_MANIFEST, "utf8"));
  } catch {
    return [];
  }
}

function pluginIdOf(dir) {
  const manifestPath = join(dir, "manifest.ts");
  if (!existsSync(manifestPath) || !existsSync(join(dir, "index.ts"))) {
    return null;
  }
  const m = readFileSync(manifestPath, "utf8").match(
    /id:\s*["']([a-z0-9-]{2,32})["']/
  );
  return m ? m[1] : null;
}

/** Plugin dirs inside an extracted source: root, root/*, root/plugins/*. */
function findPlugins(root) {
  const candidates = [root];
  for (const base of [root, join(root, "plugins")]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(base, entry.name));
    }
  }
  const found = [];
  for (const dir of candidates) {
    const id = pluginIdOf(dir);
    if (id) found.push({ id, dir });
  }
  return found;
}

async function materialize(source, tmp) {
  if (source.startsWith("/") || source.startsWith("./")) {
    const abs = resolve(source);
    if (!existsSync(abs)) fail(`local source does not exist: ${source}`);
    return abs;
  }
  let spec = source.replace(/^https:\/\/github\.com\//, "");
  let ref = "HEAD";
  const hash = spec.indexOf("#");
  if (hash !== -1) {
    ref = spec.slice(hash + 1);
    spec = spec.slice(0, hash);
  }
  spec = spec.replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec)) {
    fail(`unrecognized source (want github url, user/repo, or a path): ${source}`);
  }
  const url = `https://codeload.github.com/${spec}/tar.gz/${ref}`;
  console.log(`[fetch-plugins] downloading ${spec}@${ref}`);
  const res = await fetch(url);
  if (!res.ok) fail(`download failed (${res.status}) for ${url}`);
  const tarPath = join(tmp, "src.tar.gz");
  writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
  const out = join(tmp, "x");
  mkdirSync(out);
  // --strip-components=1 drops the repo-name-ref top folder codeload adds.
  execFileSync("tar", ["-xzf", tarPath, "-C", out, "--strip-components=1"]);
  return out;
}

const sources = (process.env.PLUGIN_SOURCES ?? "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

// Wipe last run's fetches first: a removed env entry must remove the plugin.
const previouslyFetched = readFetchedList();
for (const id of previouslyFetched) {
  rmSync(join(PLUGINS_DIR, id), { recursive: true, force: true });
}
rmSync(FETCHED_MANIFEST, { force: true });

if (sources.length === 0) {
  console.log("[fetch-plugins] PLUGIN_SOURCES empty - nothing to fetch");
  process.exit(0);
}

const inRepo = new Set(
  readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
);

const fetched = [];
for (const source of sources) {
  const tmp = mkdtempSync(join(tmpdir(), "awful-plugin-"));
  try {
    const root = await materialize(source, tmp);
    const plugins = findPlugins(root);
    if (plugins.length === 0) {
      fail(`no plugin found in ${source} (need manifest.ts + index.ts)`);
    }
    for (const { id, dir } of plugins) {
      if (inRepo.has(id)) {
        fail(`plugin "${id}" from ${source} collides with a built-in plugin`);
      }
      if (fetched.includes(id)) {
        fail(`plugin "${id}" provided by two sources`);
      }
      cpSync(dir, join(PLUGINS_DIR, id), { recursive: true });
      fetched.push(id);
      if (!existsSync(join(dir, "README.md"))) {
        console.warn(
          `[fetch-plugins] WARNING: ${id} ships no README.md - operators cannot know its requirements`
        );
      }
      console.log(`[fetch-plugins] installed ${id} from ${source}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

writeFileSync(FETCHED_MANIFEST, JSON.stringify(fetched, null, 2));
// NEVER leave ignore rules covering fetched plugins: Tailwind v4's source
// detection honors gitignore rules (any of them - a plugins/.gitignore,
// the repo root's, even .git/info/exclude, and @source does not override),
// so an ignored plugin builds with NONE of its utility classes - unstyled
// strips, default blue range inputs, in every deployed image. Keeping the
// working tree clean is not worth shipping broken CSS; fetched plugins
// simply show as untracked in dev.
rmSync(join(PLUGINS_DIR, ".gitignore"), { force: true });
console.log(`[fetch-plugins] done: ${fetched.length} plugin(s)`);
