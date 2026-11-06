// Builds canvas-sizes.json, the file apps import, and the size tables in
// README.md from the specs in specs/ and safe-zones/.
//
//   node scripts/build.ts           rewrite both outputs
//   node scripts/build.ts --check   fail if either is out of date
//
// Every problem in the specs is reported at once, with the file it is in, and
// nothing is written while there are any.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const FORMAT_VERSION = 1;
export const OUTPUT_FILE = "canvas-sizes.json";
export const README_START = "<!-- canvas-sizes:start -->";
export const README_END = "<!-- canvas-sizes:end -->";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The import file: channels → platforms → types, and the safe zones types refer to. */
export interface Library {
  format: number;
  channels: Channel[];
  safeZones: SafeZone[];
}

export interface Channel {
  id: string;
  name: string;
  platforms: Platform[];
}

export interface Platform {
  id: string;
  name: string;
  types: SizeType[];
}

export interface SizeType {
  /** `<platform>-<type>`, from the folder and file names: `instagram-stories`. */
  id: string;
  name: string;
  width: number;
  height: number;
  /** Ids of safe zones made for this size; the first is the default. */
  safeZones: string[];
  source: string;
}

export interface SafeZone {
  id: string;
  name: string;
  /** The exact aspect ratio, width then height, a canvas needs for this safe zone. */
  ratio: [number, number];
  /** The units of `margins` and `covered`: a template's size in pixels, or [100, 100] for percent. */
  frame: [number, number];
  margins: Margins;
  /** Areas inside the margins that the interface covers too, in a left-to-right layout. */
  covered: Rect[];
  source: string;
  notes?: string;
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class SpecError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The specs have ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

function main(args: string[]): number {
  const check = args.includes("--check");
  let library: Library;
  try {
    library = loadLibrary(REPO_ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }

  const readmePath = join(REPO_ROOT, "README.md");
  const outputs = [
    { path: join(REPO_ROOT, OUTPUT_FILE), text: renderLibraryJson(library) },
    { path: readmePath, text: updateReadme(readFileSync(readmePath, "utf8"), renderReadmeSection(library)) },
  ];
  const stale = outputs.filter(
    ({ path, text }) => !existsSync(path) || readFileSync(path, "utf8") !== text,
  );

  if (check) {
    for (const { path } of stale) {
      console.error(`${relative(REPO_ROOT, path)} is out of date. Run: node scripts/build.ts`);
    }
    return stale.length > 0 ? 1 : 0;
  }
  for (const { path, text } of stale) {
    writeFileSync(path, text);
    console.log(`Wrote ${relative(REPO_ROOT, path)}`);
  }
  if (stale.length === 0) {
    console.log("Everything is up to date.");
  }
  return 0;
}

/** Reads and checks every spec under `root`. Throws a SpecError listing all problems. */
export function loadLibrary(root: string): Library {
  const problems: string[] = [];
  const safeZones = subEntries(join(root, "safe-zones"), "file")
    .map((path) => readSafeZone(root, path, problems))
    .filter((zone): zone is SafeZone => zone !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const zonesById = new Map(safeZones.map((zone) => [zone.id, zone]));

  const channels = subEntries(join(root, "specs"), "directory").map((channelDir) => {
    const channelMeta = readMeta(root, join(channelDir, "channel.json"), problems);
    const platforms = subEntries(channelDir, "directory").map((platformDir) => {
      const platformMeta = readMeta(root, join(platformDir, "platform.json"), problems);
      const types = subEntries(platformDir, "file")
        .filter((path) => basename(path) !== "platform.json")
        .map((path) => readType(root, path, basename(platformDir), zonesById, problems))
        .filter((type): type is SizeType & { order: number } => type !== null);
      return {
        id: basename(platformDir),
        name: platformMeta.name,
        order: platformMeta.order,
        types: byOrder(types).map(({ order: _order, ...type }) => type),
      };
    });
    return {
      id: basename(channelDir),
      name: channelMeta.name,
      order: channelMeta.order,
      platforms: byOrder(platforms).map(({ order: _order, ...platform }) => platform),
    };
  });

  const seen = new Set<string>();
  for (const type of channels.flatMap((c) => c.platforms.flatMap((p) => p.types))) {
    if (seen.has(type.id)) {
      problems.push(`Two types have the id "${type.id}"; rename a platform folder or a type file`);
    }
    seen.add(type.id);
  }

  if (problems.length > 0) {
    throw new SpecError(problems);
  }
  return {
    format: FORMAT_VERSION,
    channels: byOrder(channels).map(({ order: _order, ...channel }) => channel),
    safeZones,
  };
}

export function renderLibraryJson(library: Library): string {
  return `${JSON.stringify(library, null, 2)}\n`;
}

/** The generated part of the README: one table per platform, then the safe zones. */
export function renderReadmeSection(library: Library): string {
  const zoneNames = new Map(library.safeZones.map((zone) => [zone.id, zone.name]));
  const lines = [
    README_START,
    "<!-- Generated by scripts/build.ts from specs/ and safe-zones/. Do not edit by hand. -->",
    "",
    "## Supported sizes",
  ];
  for (const channel of library.channels) {
    lines.push("", `### ${channel.name}`);
    for (const platform of channel.platforms) {
      lines.push("", `#### ${platform.name}`, "");
      lines.push(
        ...table(
          ["Type", "Size (px)", "Ratio", "Safe zones", "Source"],
          platform.types.map((type) => [
            type.name,
            `${type.width} × ${type.height}`,
            ratioLabel(type.width, type.height),
            type.safeZones.map((id) => zoneNames.get(id) ?? id).join(", ") || "–",
            sourceLink(type.source),
          ]),
        ),
      );
    }
  }

  lines.push(
    "",
    "## Safe zones",
    "",
    "Margins and covered areas are in the units the platform publishes them in: the pixels of its template, or percent.",
    "",
  );
  lines.push(
    ...table(
      ["Safe zone", "Ratio", "Units", "Top", "Right", "Bottom", "Left", "Also covered", "Source"],
      library.safeZones.map((zone) => {
        const percent = zone.frame[0] === 100 && zone.frame[1] === 100;
        const unit = (n: number) => (percent ? `${n}%` : `${n}`);
        return [
          zone.name,
          `${zone.ratio[0]}:${zone.ratio[1]}`,
          percent ? "percent" : `${zone.frame[0]} × ${zone.frame[1]} px`,
          unit(zone.margins.top),
          unit(zone.margins.right),
          unit(zone.margins.bottom),
          unit(zone.margins.left),
          zone.covered
            .map((r) => `x ${unit(r.x)}–${unit(r.x + r.width)}, y ${unit(r.y)}–${unit(r.y + r.height)}`)
            .join("; ") || "–",
          sourceLink(zone.source),
        ];
      }),
    ),
  );
  const notes = library.safeZones.filter((zone) => zone.notes);
  if (notes.length > 0) {
    lines.push("", ...notes.map((zone) => `- **${zone.name}.** ${zone.notes}`));
  }
  lines.push(README_END);
  return lines.join("\n");
}

/** `readme` with the text between the markers replaced by `section`. */
export function updateReadme(readme: string, section: string): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start === -1 || end === -1 || end < start) {
    return `${readme.trimEnd()}\n\n${section}\n`;
  }
  return `${readme.slice(0, start)}${section}${readme.slice(end + README_END.length)}`;
}

/** A Markdown table with every column padded to its widest cell, so it reads well as plain text. */
export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [line(headers), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)];
}

/** `4:5` for small whole ratios, `1.91:1` when the reduced numbers get large (1200 × 628). */
export function ratioLabel(width: number, height: number): string {
  const divisor = gcd(width, height);
  const [w, h] = [width / divisor, height / divisor];
  return w <= 32 && h <= 32 ? `${w}:${h}` : `${(width / height).toFixed(2)}:1`;
}

function readSafeZone(root: string, path: string, problems: string[]): SafeZone | null {
  const where = relative(root, path);
  const data = readJson(path, where, problems);
  if (data === null) {
    return null;
  }
  const before = problems.length;
  const ratio = pair(data.ratio);
  const frame = pair(data.frame);
  const margins: Record<string, unknown> = isRecord(data.margins) ? data.margins : {};
  const [top, right, bottom, left] = ["top", "right", "bottom", "left"].map((side) => margins[side]);
  if (typeof data.name !== "string" || !data.name.trim()) problems.push(`${where}: "name" must be a non-empty string`);
  if (!ratio || !ratio.every(isWholePositive)) problems.push(`${where}: "ratio" must be two whole numbers above 0`);
  if (!frame || !frame.every((n) => n > 0)) problems.push(`${where}: "frame" must be two numbers above 0`);
  if (![top, right, bottom, left].every((n) => typeof n === "number" && n >= 0)) {
    problems.push(`${where}: "margins" needs top, right, bottom and left, each 0 or more`);
  } else if (frame && ((left as number) + (right as number) >= frame[0] || (top as number) + (bottom as number) >= frame[1])) {
    problems.push(`${where}: the margins leave nothing visible in the frame`);
  }
  const covered = Array.isArray(data.covered) ? data.covered : null;
  if (!covered || !covered.every((r) => isRect(r) && frame !== null && r.x + r.width <= frame[0] && r.y + r.height <= frame[1])) {
    problems.push(`${where}: "covered" must be a list of rectangles inside the frame`);
  }
  if (!isHttpsUrl(data.source)) problems.push(`${where}: "source" must be an https link to the platform's own spec`);
  if (data.notes !== undefined && typeof data.notes !== "string") problems.push(`${where}: "notes" must be a string`);
  if (problems.length > before || !ratio || !frame || !covered) {
    return null;
  }
  return {
    id: basename(path, ".json"),
    name: data.name as string,
    ratio,
    frame,
    margins: { top, right, bottom, left } as Margins,
    covered: covered as Rect[],
    source: data.source as string,
    ...(data.notes ? { notes: data.notes as string } : {}),
  };
}

function readType(
  root: string,
  path: string,
  platformId: string,
  zonesById: Map<string, SafeZone>,
  problems: string[],
): (SizeType & { order: number }) | null {
  const where = relative(root, path);
  const data = readJson(path, where, problems);
  if (data === null) {
    return null;
  }
  const before = problems.length;
  if (typeof data.name !== "string" || !data.name.trim()) problems.push(`${where}: "name" must be a non-empty string`);
  if (!isWholePositive(data.width) || !isWholePositive(data.height)) problems.push(`${where}: "width" and "height" must be whole numbers above 0`);
  if (data.order !== undefined && typeof data.order !== "number") problems.push(`${where}: "order" must be a number`);
  if (!isHttpsUrl(data.source)) problems.push(`${where}: "source" must be an https link to the platform's own spec`);
  const zoneIds = Array.isArray(data.safeZones) ? data.safeZones : null;
  if (!zoneIds || !zoneIds.every((id) => typeof id === "string")) {
    problems.push(`${where}: "safeZones" must be a list of safe zone ids`);
  } else {
    for (const id of zoneIds as string[]) {
      const zone = zonesById.get(id);
      if (!zone) {
        problems.push(`${where}: no safe zone "${id}" in safe-zones/`);
      } else if (isWholePositive(data.width) && isWholePositive(data.height)
        && (data.width as number) * zone.ratio[1] !== (data.height as number) * zone.ratio[0]) {
        problems.push(`${where}: ${data.width} × ${data.height} is not ${zone.ratio[0]}:${zone.ratio[1]}, the ratio of safe zone "${id}"`);
      }
    }
  }
  if (problems.length > before) {
    return null;
  }
  return {
    id: `${platformId}-${basename(path, ".json")}`,
    name: data.name as string,
    order: (data.order as number | undefined) ?? Number.MAX_SAFE_INTEGER,
    width: data.width as number,
    height: data.height as number,
    safeZones: zoneIds as string[],
    source: data.source as string,
  };
}

/** A channel.json or platform.json: a display name and an optional sort order. */
function readMeta(root: string, path: string, problems: string[]): { name: string; order: number } {
  const where = relative(root, path);
  const fallback = { name: basename(join(path, "..")), order: Number.MAX_SAFE_INTEGER };
  if (!existsSync(path)) {
    problems.push(`${where} is missing; it names the folder: { "name": "…", "order": 1 }`);
    return fallback;
  }
  const data = readJson(path, where, problems);
  if (data === null) {
    return fallback;
  }
  if (typeof data.name !== "string" || !data.name.trim()) {
    problems.push(`${where}: "name" must be a non-empty string`);
    return fallback;
  }
  return { name: data.name, order: typeof data.order === "number" ? data.order : fallback.order };
}

function readJson(path: string, where: string, problems: string[]): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(data)) {
      return data;
    }
    problems.push(`${where}: expected a JSON object`);
  } catch (error) {
    problems.push(`${where}: ${error instanceof Error ? error.message : "could not be read"}`);
  }
  return null;
}

/** The JSON files or the folders directly in `dir`, sorted by name. */
function subEntries(dir: string, kind: "file" | "directory"): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => join(dir, name))
    .filter((path) => {
      const stats = statSync(path);
      return kind === "directory"
        ? stats.isDirectory()
        : stats.isFile() && path.endsWith(".json") && basename(path) !== "channel.json";
    })
    .sort();
}

/** Sorted by `order`, then by name, so the output never depends on the file system. */
function byOrder<T extends { order: number; name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function sourceLink(url: string): string {
  return `[${new URL(url).hostname.replace(/^www\./, "")}](${url})`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function pair(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number")
    ? [value[0], value[1]]
    : null;
}

function isRect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    ["x", "y", "width", "height"].every((key) => typeof value[key] === "number" && (value[key] as number) >= 0)
  );
}

function isWholePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
