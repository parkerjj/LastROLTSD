import type { ProfileFiles } from '../profile-service';
import { KeFailure } from '../types';
import type { ConfigPatch } from './types';

/**
 * 对配置原文做最小的行级改动（一键应用 / 撤销）。只改补丁点名的行，保留注释、顺序、缩进和换行风格。
 * 应用前先核对“期望值”（按原文，不存在也是一种值），不一致就拒绝，避免覆盖用户自己改过的配置。
 * 块/行的语法对齐 KE core 的配置解析（crates/kore-core/src/config/parser.rs）。
 */

export interface PatchResult {
  files: ProfileFiles;
  /** 反向补丁：用它再应用一次即可撤销。 */
  revert: ConfigPatch;
}

const changed = () => new KeFailure('KE_CONFIG_CHANGED', 409, '配置已变化，请重新查看建议');

interface Doc {
  lines: string[];
  eol: string;
  trailing: boolean;
}

function parseDoc(text: string): Doc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  let trailing = true;
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  else if (lines.length > 0) trailing = false;
  return { lines, eol, trailing };
}

function render(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.trailing ? doc.eol : '');
}

const isComment = (line: string) => line.trim() === '' || line.trim().startsWith('#');

interface Block {
  name: string;
  selector: string;
  start: number;
  end: number; // 闭合 } 所在行
}

const HEADER = /^\s*(\S+?)(?:\s+(.+?))?\s*\{\s*$/;
const CLOSE = /^\s*\}\s*$/;

function findBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  lines.forEach((line, index) => {
    if (open) {
      if (CLOSE.test(line)) {
        open.end = index;
        blocks.push(open);
        open = null;
      }
      return;
    }
    if (isComment(line)) return;
    const match = HEADER.exec(line);
    if (match) open = { name: match[1]!, selector: (match[2] ?? '').trim(), start: index, end: -1 };
  });
  return blocks;
}

function inBlock(index: number, blocks: Block[]): boolean {
  return blocks.some((block) => index >= block.start && index <= block.end);
}

function splitKeyValue(line: string): { key: string; value: string } | null {
  const match = /^\s*(\S+)(?:\s+(.*?))?\s*$/.exec(line);
  return match ? { key: match[1]!, value: match[2] ?? '' } : null;
}

function insertAt(doc: Doc, index: number, line: string): void {
  doc.lines.splice(index, 0, line);
}

function applySetKey(doc: Doc, patch: Extract<ConfigPatch, { op: 'setKey' }>): ConfigPatch {
  const blocks = findBlocks(doc.lines);
  const index = doc.lines.findIndex((line, i) => {
    if (isComment(line) || inBlock(i, blocks)) return false;
    return splitKeyValue(line)?.key === patch.key;
  });
  const current = index >= 0 ? splitKeyValue(doc.lines[index]!)!.value : null;
  if (current !== patch.expected) throw changed();
  if (patch.value === null) {
    if (index >= 0) doc.lines.splice(index, 1);
  } else if (index >= 0) {
    doc.lines[index] = `${patch.key} ${patch.value}`;
  } else {
    doc.lines.push(`${patch.key} ${patch.value}`);
    doc.trailing = true;
  }
  return { op: 'setKey', file: patch.file, key: patch.key, expected: patch.value, value: patch.expected };
}

function applyUpsertLine(doc: Doc, patch: Extract<ConfigPatch, { op: 'upsertLine' }>): ConfigPatch {
  const index = doc.lines.findIndex((line) => !isComment(line) && splitKeyValue(line)?.key === patch.first);
  const current = index >= 0 ? doc.lines[index]!.trim() : null;
  if (current !== patch.expected) throw changed();
  if (patch.line === null) {
    if (index >= 0) doc.lines.splice(index, 1);
  } else if (index >= 0) {
    doc.lines[index] = patch.line;
  } else {
    doc.lines.push(patch.line);
    doc.trailing = true;
  }
  return { op: 'upsertLine', file: patch.file, first: patch.first, expected: patch.line, line: patch.expected };
}

function applyUpsertBlock(
  doc: Doc,
  patch: Extract<ConfigPatch, { op: 'upsertBlock' }>,
  itemIdOf: (name: string) => number | null,
): ConfigPatch {
  const matches = (block: Block) => {
    if (block.name !== patch.block) return false;
    if (block.selector === patch.selector) return true;
    if (patch.itemId == null) return false;
    const numeric = /^\d+$/.test(block.selector) ? Number(block.selector) : itemIdOf(block.selector);
    return numeric === patch.itemId;
  };
  const block = findBlocks(doc.lines).find(matches);

  if (!block) {
    if (patch.expected !== null) throw changed();
    if (patch.fields === null) return { ...patch, expected: null, fields: null };
    doc.lines.push(`${patch.block} ${patch.selector} {`);
    for (const [key, value] of patch.fields) if (value !== '') doc.lines.push(`\t${key} ${value}`);
    doc.lines.push('}');
    doc.trailing = true;
    const added = Object.fromEntries(patch.fields.filter(([, v]) => v !== '').map(([k, v]) => [k, v]));
    return { op: 'upsertBlock', file: patch.file, block: patch.block, selector: patch.selector, itemId: patch.itemId ?? null, expected: added, fields: null };
  }

  if (patch.expected === null) throw changed();
  const fieldLine = (key: string): number => {
    for (let i = block.start + 1; i < block.end; i += 1) {
      if (!isComment(doc.lines[i]!) && splitKeyValue(doc.lines[i]!)?.key === key) return i;
    }
    return -1;
  };
  for (const [key, want] of Object.entries(patch.expected)) {
    const at = fieldLine(key);
    const have = at >= 0 ? splitKeyValue(doc.lines[at]!)!.value : null;
    if (have !== want) throw changed();
  }

  if (patch.fields === null) {
    // 删除整块：撤销时要能把整块写回去，所以把现有字段原样带进反向补丁。
    const old: Array<[string, string]> = [];
    for (let i = block.start + 1; i < block.end; i += 1) {
      const kv = isComment(doc.lines[i]!) ? null : splitKeyValue(doc.lines[i]!);
      if (kv) old.push([kv.key, kv.value]);
    }
    doc.lines.splice(block.start, block.end - block.start + 1);
    return { op: 'upsertBlock', file: patch.file, block: patch.block, selector: block.selector, itemId: patch.itemId ?? null, expected: null, fields: old };
  }

  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  const undo: Array<[string, string]> = [];
  for (const [key, value] of patch.fields) {
    const at = fieldLine(key);
    const old = at >= 0 ? splitKeyValue(doc.lines[at]!)!.value : null;
    before[key] = old;
    undo.push([key, old ?? '']);
    if (value === '') {
      after[key] = null;
      if (at >= 0) {
        doc.lines.splice(at, 1);
        block.end -= 1;
      }
    } else if (at >= 0) {
      const lead = /^\s*/.exec(doc.lines[at]!)![0];
      const sep = /^\s*\S+(\s+)/.exec(doc.lines[at]!)?.[1] ?? ' ';
      doc.lines[at] = `${lead}${key}${sep}${value}`;
      after[key] = value;
    } else {
      insertAt(doc, block.end, `\t${key} ${value}`);
      block.end += 1;
      after[key] = value;
    }
  }
  return { op: 'upsertBlock', file: patch.file, block: patch.block, selector: block.selector, itemId: patch.itemId ?? null, expected: after, fields: undo };
}

export function applyConfigPatch(files: ProfileFiles, patch: ConfigPatch, itemIdOf: (name: string) => number | null): PatchResult {
  const file = patch.file;
  if (file !== 'config.txt' && file !== 'mon_control.txt') throw new KeFailure('KE_BAD_REQUEST', 400, '不支持的配置文件');
  if (patch.op === 'upsertLine' && file !== 'mon_control.txt') throw new KeFailure('KE_BAD_REQUEST', 400, '补丁与文件不匹配');
  if (patch.op !== 'upsertLine' && file !== 'config.txt') throw new KeFailure('KE_BAD_REQUEST', 400, '补丁与文件不匹配');
  const doc = parseDoc(files[file]);
  let revert: ConfigPatch;
  switch (patch.op) {
    case 'setKey': revert = applySetKey(doc, patch); break;
    case 'upsertLine': revert = applyUpsertLine(doc, patch); break;
    case 'upsertBlock': revert = applyUpsertBlock(doc, patch, itemIdOf); break;
    default: throw new KeFailure('KE_BAD_REQUEST', 400, '未知的补丁类型');
  }
  return { files: { ...files, [file]: render(doc) }, revert };
}
