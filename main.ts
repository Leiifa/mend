// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface TextFile {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): TextFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: '\r\n' | '\n', final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const stripTrailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWS = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadWS = (s: string): string => {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
};

function lineMatches(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return stripTrailWS(fileLine) === stripTrailWS(patchLine);
  return stripBothWS(fileLine) === stripBothWS(patchLine);
}

function findMatches(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  minPos = 0,
  exactEnd = false,
): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  const k = oldLines.length;
  if (k === 0) return null;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const positions: number[] = [];
    if (exactEnd) {
      const start = fileLines.length - k;
      if (start >= minPos) {
        let ok = true;
        for (let j = 0; j < k; j += 1) {
          if (!lineMatches(fileLines[start + j]!, oldLines[j]!, tier)) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(start);
      }
    } else {
      const limit = fileLines.length - k;
      for (let i = minPos; i <= limit; i += 1) {
        let ok = true;
        for (let j = 0; j < k; j += 1) {
          if (!lineMatches(fileLines[i + j]!, oldLines[j]!, tier)) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindentLine(line: string, fileLead: string, patchLead: string): string {
  if (!blank(line) && line.startsWith(patchLead)) return fileLead + line.slice(patchLead.length);
  return line;
}

interface HunkOp {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function buildReplacement(fileLines: string[], pos: number, ops: HunkOp[], tier: number, oldFirst: string): string[] {
  const fileLead = tier === 2 ? leadWS(fileLines[pos]!) : '';
  const patchLead = tier === 2 ? leadWS(oldFirst) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (op.kind === '-') {
      oi += 1;
    } else if (op.kind === '+') {
      out.push(tier === 2 ? reindentLine(op.text, fileLead, patchLead) : op.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function stripSurroundingSpaces(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

function parseDiffGitLine(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (!m) return null;
  const x = m[1]!;
  const y = m[2]!;
  if (x === '' || y === '' || x.trim() !== x || y.trim() !== y) return null;
  return [x, y];
}

function parseUnifiedPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = stripSurroundingSpaces(s);
  if (s !== '/dev/null' && (s.startsWith('a/') || s.startsWith('b/'))) s = s.slice(2);
  return s;
}

interface UnifiedHunk {
  oldStart: number;
  ops: HunkOp[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNewMode: boolean;
  isDelMode: boolean;
  hunks: UnifiedHunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;

  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isDashPairAt = (idx: number): boolean =>
    lines[idx]!.startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1]!.startsWith('+++ ');

  const startSection = (gitOld: string | null, gitNew: string | null): UnifiedSection => {
    const s: UnifiedSection = {
      gitOld,
      gitNew,
      hdrOld: null,
      hdrNew: null,
      renameFrom: null,
      renameTo: null,
      isNewMode: false,
      isDelMode: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const parsed = parseDiffGitLine(l);
      if (parsed === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(parsed[0], parsed[1]);
      i += 1;
      continue;
    }

    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        const oldP = parseUnifiedPath(l);
        const newP = parseUnifiedPath(lines[i + 1]!);
        if (cur.hdrOld !== null) {
          const s = startSection(null, null);
          s.hdrOld = oldP;
          s.hdrNew = newP;
        } else {
          cur.hdrOld = oldP;
          cur.hdrNew = newP;
        }
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = stripSurroundingSpaces(l.slice(12));
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = stripSurroundingSpaces(l.slice(10));
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.isNewMode = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.isDelMode = true;
        i += 1;
        continue;
      }
    } else if (isDashPairAt(i)) {
      const s = startSection(null, null);
      s.hdrOld = parseUnifiedPath(l);
      s.hdrNew = parseUnifiedPath(lines[i + 1]!);
      i += 2;
      continue;
    }

    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const oldStart = Number(m[1]);
      inHeader = false;
      i += 1;
      const rawBody: Array<{ op: HunkOp; emptyLine: boolean }> = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (isDiffGit(bl) || isDashPairAt(i)) break;
        if (bl === '') {
          rawBody.push({ op: { kind: ' ', text: '' }, emptyLine: true });
          i += 1;
        } else if (bl[0] === ' ') {
          rawBody.push({ op: { kind: ' ', text: bl.slice(1) }, emptyLine: false });
          i += 1;
        } else if (bl[0] === '-') {
          rawBody.push({ op: { kind: '-', text: bl.slice(1) }, emptyLine: false });
          i += 1;
        } else if (bl[0] === '+') {
          rawBody.push({ op: { kind: '+', text: bl.slice(1) }, emptyLine: false });
          i += 1;
        } else if (bl[0] === '\\') {
          rawBody.push({ op: { kind: '\\', text: bl.slice(1) }, emptyLine: false });
          i += 1;
        } else {
          break;
        }
      }
      while (rawBody.length > 0 && rawBody[rawBody.length - 1]!.emptyLine) rawBody.pop();
      cur.hunks.push({ oldStart, ops: rawBody.map((r) => r.op) });
      continue;
    }

    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.hdrOld ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.hdrNew ?? sec.renameTo ?? sec.gitNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.isNewMode;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.isDelMode);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    if (isCreate) {
      return (tree) => {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const outLines: string[] = [];
        let lastPlusNoEol = false;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.ops.length; k += 1) {
            if (h.ops[k]!.kind === '+') {
              outLines.push(h.ops[k]!.text);
              lastPlusNoEol = h.ops[k + 1]?.kind === '\\';
            }
          }
        }
        tree.now.set(newPath, joinFile(outLines, '\n', !lastPlusNoEol));
      };
    }

    if (isDelete) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }

    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const file = splitFile(before);
      const fileLines = file.lines;
      let final = file.final;
      let delta = 0;

      for (const h of sec.hunks) {
        const oldLines = h.ops.filter((op) => op.kind === ' ' || op.kind === '-').map((op) => op.text);
        const newOpsCount = h.ops.filter((op) => op.kind === ' ' || op.kind === '+').length;
        let lastNewOrCtx = -1;
        for (let k = 0; k < h.ops.length; k += 1) {
          if (h.ops[k]!.kind === ' ' || h.ops[k]!.kind === '+') lastNewOrCtx = k;
        }
        const noEol = lastNewOrCtx >= 0 && h.ops[lastNewOrCtx + 1]?.kind === '\\';

        if (oldLines.length === 0) {
          const insLines = h.ops.filter((op) => op.kind === '+').map((op) => op.text);
          const insPos = Math.max(0, Math.min(fileLines.length, h.oldStart + delta));
          const atEnd = insPos === fileLines.length;
          fileLines.splice(insPos, 0, ...insLines);
          if (atEnd) final = !noEol;
          delta += newOpsCount;
        } else {
          const found = findMatches(fileLines, oldLines, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          const target = h.oldStart - 1 + delta;
          let best = found.positions[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.positions) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const atEnd = best + oldLines.length === fileLines.length;
          const rep = buildReplacement(fileLines, best, h.ops, found.tier, oldLines[0]!);
          fileLines.splice(best, oldLines.length, ...rep);
          if (atEnd) final = !noEol;
          delta += rep.length - oldLines.length;
        }
      }

      const out = joinFile(fileLines, file.br, final);
      if (isMove) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, out);
      }
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const trimmed = lines[j]!.trim();
      if (trimmed === '' || trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;

    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const blockPath = path;

    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldLines.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const file = splitFile(before);
      const found = findMatches(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.positions[0]!;
      const rep =
        found.tier === 2
          ? newLines.map((nl) => reindentLine(nl, leadWS(file.lines[pos]!), leadWS(oldLines[0]!)))
          : newLines;
      file.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(blockPath, joinFile(file.lines, file.br, file.final));
    });

    prevEnd = repIdx;
    i = repIdx + 1;
  }

  return edits;
}

interface V4AChunk {
  anchor: string | null;
  ops: HunkOp[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const isSectionHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    const headerLineNo = i + 1;
    if (!isSectionHeader(header)) throw new Exit2(`error: parse ${headerLineNo}`);

    if (header.startsWith('*** Delete File: ')) {
      const path = stripSurroundingSpaces(header.slice(17));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < last && !isSectionHeader(lines[end]!)) end += 1;
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;

    if (header.startsWith('*** Add File: ')) {
      const path = stripSurroundingSpaces(header.slice(14));
      const addLines: string[] = [];
      for (let j = i + 1; j < bodyEnd; j += 1) {
        const l = lines[j]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(addLines, '\n', true));
      });
    } else {
      const path = stripSurroundingSpaces(header.slice(17));
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = stripSurroundingSpaces(lines[j]!.slice(13));
        j += 1;
      }

      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;

      while (j < bodyEnd) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          const anchorText = stripSurroundingSpaces(l.slice(2));
          curChunk = { anchor: anchorText === '' ? null : anchorText, ops: [], eof: false };
          chunks.push(curChunk);
          j += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          curChunk = null;
          j += 1;
          continue;
        }
        let op: HunkOp | null = null;
        if (l === '') op = { kind: ' ', text: '' };
        else if (l[0] === ' ') op = { kind: ' ', text: l.slice(1) };
        else if (l[0] === '-') op = { kind: '-', text: l.slice(1) };
        else if (l[0] === '+') op = { kind: '+', text: l.slice(1) };
        if (op === null) throw new Exit2(`error: parse ${j + 1}`);
        if (curChunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
          curChunk = { anchor: null, ops: [], eof: false };
          chunks.push(curChunk);
        }
        curChunk.ops.push(op);
        j += 1;
      }

      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLineNo}`);

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const file = splitFile(before);
        const fileLines = file.lines;
        let cursor = 0;

        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const anchorMatch = findMatches(fileLines, [ch.anchor], strict, cursor, false);
            if (anchorMatch === null) throw new Fail('no-match', path);
            cursor = anchorMatch.positions[0]! + 1;
          }
          const oldLines = ch.ops.filter((op) => op.kind === ' ' || op.kind === '-').map((op) => op.text);
          if (oldLines.length === 0) {
            const insLines = ch.ops.filter((op) => op.kind === '+').map((op) => op.text);
            const insPos = ch.eof ? fileLines.length : cursor;
            fileLines.splice(insPos, 0, ...insLines);
            cursor = insPos + insLines.length;
          } else {
            const found = findMatches(fileLines, oldLines, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const rep = buildReplacement(fileLines, pos, ch.ops, found.tier, oldLines[0]!);
            fileLines.splice(pos, oldLines.length, ...rep);
            cursor = pos + rep.length;
          }
        }

        const out = joinFile(fileLines, file.br, file.final);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
    }

    i = end;
  }

  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    if (was === null && now !== null) added.add(p);
    else if (was !== null && now === null) deleted.add(p);
  }
  const renameByNew = new Map<string, string>();
  const renamedOlds = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (deleted.has(oldP) && added.has(newP) && !renamedOlds.has(oldP) && !renameByNew.has(newP)) {
      renameByNew.set(newP, oldP);
      renamedOlds.add(oldP);
    }
  }
  const sortedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: string[] = [];
  for (const p of sortedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!renamedOlds.has(p)) {
      if (renameByNew.has(p)) rows.push(`R ${renameByNew.get(p)!} -> ${p}`);
      else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    }
  }
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
