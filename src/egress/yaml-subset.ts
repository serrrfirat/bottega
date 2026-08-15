/**
 * Minimal YAML-subset parser used ONLY by tests to structurally validate the
 * hand-authored compose/egress fixtures (issue #8). This is not a general
 * YAML parser: it supports exactly the constructs used in
 * docker-compose.yml and config/egress.yml:
 *
 *   - comments (# full-line and trailing, not inside quotes)
 *   - block mappings (key: value, nested blocks by indentation)
 *   - block sequences (- item, - key: value with deeper children)
 *   - plain scalars and double-quoted scalars
 *   - `|` literal block scalars (multi-line prompts)
 *
 * Flow collections, anchors/aliases, and single-quoted scalars are rejected.
 */

export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

interface RawLine {
  raw: string;
  indent: number;
  lineNo: number;
}

function tokenize(src: string): RawLine[] {
  const lines: RawLine[] = [];
  for (const [i, raw] of src.split("\n").entries()) {
    if (raw.trim() === "") continue;
    if (stripComment(raw).trim() === "") continue; // comment-only line
    lines.push({ raw, indent: raw.length - raw.trimStart().length, lineNo: i + 1 });
  }
  return lines;
}

function stripComment(s: string): string {
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inDouble = !inDouble;
    else if (c === "#" && !inDouble && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i);
    }
  }
  return s;
}

function parseScalar(raw: string, lineNo: number): string {
  const s = stripComment(raw).trim();
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new Error(`line ${lineNo}: unterminated double-quoted scalar`);
    const inner = s.slice(1, -1);
    if (inner.includes('"')) throw new Error(`line ${lineNo}: quotes inside a quoted scalar are not supported`);
    return inner;
  }
  if (s.startsWith("[") || s.startsWith("{") || s.includes(": ")) {
    throw new Error(`line ${lineNo}: flow collections are not supported by the YAML subset parser`);
  }
  return s;
}

/** Parses a block (mapping or sequence) starting at lines[i] with the given indent. */
function parseBlock(lines: RawLine[], i: number, indent: number): [YamlNode, number] {
  if (i >= lines.length) throw new Error("unexpected end of input");
  const text = stripComment(lines[i].raw).trim();
  if (text === "-" || text.startsWith("- ")) return parseSequence(lines, i, indent);
  return parseMapping(lines, i, indent);
}

/** Parses a mapping whose first key sits on lines[i] at `indent`. */
function parseMapping(lines: RawLine[], i: number, indent: number): [Record<string, YamlNode>, number] {
  const out: Record<string, YamlNode> = {};
  while (i < lines.length) {
    const line = lines[i];
    const text = stripComment(line.raw).trim();
    if (line.indent !== indent || text === "" || text === "-" || text.startsWith("- ")) break;
    const sep = text.indexOf(":");
    if (sep <= 0) throw new Error(`line ${line.lineNo}: expected "key:" in mapping`);
    const key = text.slice(0, sep).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`line ${line.lineNo}: unsupported key ${JSON.stringify(key)}`);
    if (key in out) throw new Error(`line ${line.lineNo}: duplicate key ${JSON.stringify(key)}`);
    const rest = text.slice(sep + 1).trim();
    if (rest === "|") {
      // Literal block scalar: consume deeper-indented raw lines verbatim.
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) {
        body.push(lines[j].raw.slice(indent + 2));
        j++;
      }
      out[key] = body.join("\n");
      i = j;
    } else if (rest === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [child, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
        out[key] = child;
        i = next;
      } else {
        out[key] = {}; // "key:" with no value — empty mapping
        i++;
      }
    } else {
      out[key] = parseScalar(text.slice(sep + 1), line.lineNo);
      i++;
    }
  }
  return [out, i];
}

/** Parses a sequence whose first item sits on lines[i] at `indent`. */
function parseSequence(lines: RawLine[], i: number, indent: number): [YamlNode[], number] {
  const out: YamlNode[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const text = stripComment(line.raw).trim();
    if (line.indent !== indent || !(text === "-" || text.startsWith("- "))) break;
    const item = text === "-" ? "" : text.slice(2).trim();
    if (item === "") throw new Error(`line ${line.lineNo}: empty sequence item`);
    const mapColon = item.search(/:( |$)/);
    if (mapColon >= 0) {
      // Inline map item: "- key: value" with deeper children at indent+2.
      const sep = mapColon;
      const key = item.slice(0, sep).trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`line ${line.lineNo}: unsupported key ${JSON.stringify(key)}`);
      const rest = item.slice(sep + 1).trim();
      const childIndent = indent + 2;
      const map: Record<string, YamlNode> = {};
      if (rest === "|") {
        throw new Error(`line ${line.lineNo}: block scalar inside sequence item is not supported`);
      } else if (rest === "") {
        if (i + 1 < lines.length && lines[i + 1].indent > childIndent) {
          const [child, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
          map[key] = child;
          i = next;
        } else {
          map[key] = {};
          i++;
        }
      } else {
        map[key] = parseScalar(item.slice(sep + 1), line.lineNo);
        i++;
      }
      // Continuation keys of this map item sit at childIndent.
      while (i < lines.length && lines[i].indent === childIndent) {
        const cont = lines[i];
        const ctext = stripComment(cont.raw).trim();
        if (ctext === "" || ctext.startsWith("- ")) break;
        const csep = ctext.indexOf(":");
        if (csep <= 0) throw new Error(`line ${cont.lineNo}: expected "key:" in sequence map item`);
        const ckey = ctext.slice(0, csep).trim();
        if (!/^[A-Za-z0-9_.-]+$/.test(ckey)) throw new Error(`line ${cont.lineNo}: unsupported key ${JSON.stringify(ckey)}`);
        if (ckey in map) throw new Error(`line ${cont.lineNo}: duplicate key ${JSON.stringify(ckey)}`);
        const crest = ctext.slice(csep + 1).trim();
        if (crest === "|") {
          const body: string[] = [];
          let j = i + 1;
          while (j < lines.length && lines[j].indent > childIndent) {
            body.push(lines[j].raw.slice(childIndent + 2));
            j++;
          }
          map[ckey] = body.join("\n");
          i = j;
        } else if (crest === "") {
          if (i + 1 < lines.length && lines[i + 1].indent > childIndent) {
            const [child, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
            map[ckey] = child;
            i = next;
          } else {
            map[ckey] = {};
            i++;
          }
        } else {
          map[ckey] = parseScalar(ctext.slice(csep + 1), cont.lineNo);
          i++;
        }
      }
      out.push(map);
    } else {
      out.push(parseScalar(item, line.lineNo));
      i++;
    }
  }
  return [out, i];
}

/** Parses a document. Returns the top-level mapping. */
export function parseYamlSubset(src: string): Record<string, YamlNode> {
  const lines = tokenize(src);
  if (lines.length === 0) return {};
  const [node, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) throw new Error(`line ${lines[next].lineNo}: unexpected content`);
  if (typeof node === "string" || Array.isArray(node)) throw new Error("top level must be a mapping");
  return node;
}

/** Parses a document whose root is a sequence (e.g. secrets.yml). */
export function parseYamlSequence(src: string): YamlNode[] {
  const lines = tokenize(src);
  if (lines.length === 0) return [];
  const [node, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) throw new Error(`line ${lines[next].lineNo}: unexpected content`);
  if (!Array.isArray(node)) throw new Error("top level must be a sequence");
  return node;
}
