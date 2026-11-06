import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadLibrary,
  ratioLabel,
  renderLibraryJson,
  renderReadmeSection,
  SpecError,
  table,
  updateReadme,
} from "./build.ts";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const STORIES = {
  name: "Stories",
  order: 1,
  width: 1080,
  height: 1920,
  safeZones: ["tall"],
  source: "https://example.com/stories",
};
const TALL_ZONE = {
  name: "Tall",
  ratio: [9, 16],
  frame: [100, 100],
  margins: { top: 10, right: 5, bottom: 30, left: 5 },
  covered: [],
  source: "https://example.com/zones",
};

test("the repository's own specs build without problems", () => {
  const library = loadLibrary(REPO_ROOT);

  assert.ok(library.channels.length > 0);
  assert.ok(library.safeZones.length > 0);
});

test("ids come from the platform folder and the type file", () => {
  const library = loadLibrary(fixture({ "specs/social/insta/stories.json": STORIES }));

  assert.deepEqual(library.channels[0].platforms[0].types[0].id, "insta-stories");
  assert.equal(library.channels[0].name, "Social");
});

test("a size with another ratio than its safe zone is reported", () => {
  const root = fixture({ "specs/social/insta/stories.json": { ...STORIES, height: 1350 } });

  assert.throws(
    () => loadLibrary(root),
    (error: unknown) =>
      error instanceof SpecError &&
      error.problems.some((p) => p.includes("1080 × 1350 is not 9:16")),
  );
});

test("every problem is reported at once", () => {
  const root = fixture({
    "specs/social/insta/stories.json": { ...STORIES, safeZones: ["missing"], source: "http://example.com" },
  });

  assert.throws(
    () => loadLibrary(root),
    (error: unknown) =>
      error instanceof SpecError &&
      error.problems.length === 2 &&
      error.problems.some((p) => p.includes('no safe zone "missing"')) &&
      error.problems.some((p) => p.includes('"source" must be an https link')),
  );
});

test("types are sorted by order, then by name", () => {
  const root = fixture({
    "specs/social/insta/b.json": { ...STORIES, name: "B", order: 2 },
    "specs/social/insta/a.json": { ...STORIES, name: "A", order: 2 },
    "specs/social/insta/c.json": { ...STORIES, name: "C", order: 1 },
  });

  const names = loadLibrary(root).channels[0].platforms[0].types.map((t) => t.name);
  assert.deepEqual(names, ["C", "A", "B"]);
});

test("the README section replaces only what is between the markers", () => {
  const library = loadLibrary(fixture({ "specs/social/insta/stories.json": STORIES }));
  const section = renderReadmeSection(library);
  const readme = `# Title\n\nIntro.\n\n${section}\n\nAfter.\n`;

  assert.equal(updateReadme(readme, section), readme);
  assert.match(updateReadme("# Title\n", section), /^# Title\n\n<!-- canvas-sizes:start -->/);
  assert.match(section, /\| Stories \| 1080 × 1920 \| 9:16 {2}\| Tall {7}\|/);
  assert.equal(renderLibraryJson(library).endsWith("}\n"), true);
});

test("tables are padded to their widest cell", () => {
  assert.deepEqual(table(["A", "Long header"], [["wide cell", "x"]]), [
    "| A         | Long header |",
    "|-----------|-------------|",
    "| wide cell | x           |",
  ]);
});

test("ratios read the way platforms write them", () => {
  assert.equal(ratioLabel(1440, 1800), "4:5");
  assert.equal(ratioLabel(3840, 2160), "16:9");
  assert.equal(ratioLabel(1200, 628), "1.91:1");
});

/** A throwaway repository with one safe zone, "tall", and the given spec files. */
function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "canvas-size-lib-"));
  const all: Record<string, unknown> = {
    "safe-zones/tall.json": TALL_ZONE,
    "specs/social/channel.json": { name: "Social", order: 1 },
    "specs/social/insta/platform.json": { name: "Insta", order: 1 },
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(content));
  }
  return root;
}
