#!/usr/bin/env node

// Agent-context gate (#718, ENG-0006). Three checks over the files that steer
// agents:
//
//   1. AGENTS.md length is a DOWNWARD ratchet, like a coverage floor inverted.
//      Progressive disclosure only holds if growth costs something.
//   2. Every vendor adapter points at the canonical file, so no vendor's agent
//      is reading a file that has quietly become a second source of truth.
//   3. No substantial paragraph is shared between AGENTS.md and an adapter —
//      "a shared fact stated in two agent files is a bug" (ENG-0006 item 1).
//
// (3) overlaps docs-gov's `duplicateParagraphs` rule for the markdown files in
// its `include` list, but `.cursor/rules/*.mdc` sits outside that list entirely,
// which is exactly where a duplicated process-guard rule would hide.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CANONICAL = 'AGENTS.md';

// Ratchet. Lower it whenever a pass removes content; raising it requires a
// stated reason in the PR that does so, the same bar as a docs-gov token budget.
export const AGENTS_MAX_LINES = 230;

// Harness adapters were removed (qwts/qwts-agent-sop#89): these paths must
// not exist. AGENTS.md is the only agent context.
const ADAPTERS = ['CLAUDE.md', '.github/copilot-instructions.md', '.claude/settings.json'];
const ADAPTER_DIRS = ['.cursor/rules'];

// Long enough that shared vocabulary and short imperative bullets do not trip
// it; short enough to catch a restated rule or paragraph.
const DUPLICATE_MIN_LENGTH = 160;

function countLines(text) {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.length === 0 ? 0 : body.split('\n').length;
}

function adapterFiles(readDir) {
  const extra = ADAPTER_DIRS.flatMap((dir) =>
    readDir(dir)
      .filter((entry) => entry.endsWith('.md') || entry.endsWith('.mdc'))
      .map((entry) => `${dir}/${entry}`),
  );
  return [...ADAPTERS, ...extra];
}

// Markdown/frontmatter noise removed so a reflowed copy still matches.
function normalize(block) {
  return block
    .replaceAll(/[`*_>#]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/u;

// A blank-line split alone would make an entire bullet list one unit, so an
// adapter copying a single long bullet would be compared against the whole list
// and pass. Bullets are the dominant shape in these files, so each list item is
// its own unit, continuation lines included.
function units(block) {
  const lines = block.split('\n');
  if (!lines.some((line) => LIST_ITEM.test(line))) return [block];

  const items = [];
  let current = null;
  for (const line of lines) {
    if (LIST_ITEM.test(line)) {
      if (current !== null) items.push(current);
      current = line;
    } else if (current === null) {
      items.push(line);
    } else {
      current += `\n${line}`;
    }
  }
  if (current !== null) items.push(current);
  return items;
}

export function paragraphs(text) {
  return text
    .split(/\n\s*\n/u)
    .flatMap(units)
    .map(normalize)
    .filter((unit) => unit.length >= DUPLICATE_MIN_LENGTH);
}

export function evaluateAgentContext({ readText, readDir, maxLines = AGENTS_MAX_LINES }) {
  const failures = [];

  const canonical = readText(CANONICAL);
  const lines = countLines(canonical);
  if (lines > maxLines) {
    failures.push(
      `${CANONICAL} is ${lines} lines, over its ${maxLines}-line budget. The budget is a downward ratchet: ` +
        `move depth into docs/ and link it, or raise AGENTS_MAX_LINES in this script with a reason in the PR.`,
    );
  }

  const canonicalParagraphs = new Set(paragraphs(canonical));

  for (const file of adapterFiles(readDir)) {
    const text = readText(file);
    if (text === null) continue;
    failures.push(`${file} must not exist: harness adapters were removed and ${CANONICAL} is the only agent context.`);
    for (const unit of paragraphs(text)) {
      if (canonicalParagraphs.has(unit)) {
        failures.push(`${file} repeats a paragraph or list item from ${CANONICAL}: "${unit.slice(0, 80)}…". Link to it instead.`);
      }
    }
  }

  return failures;
}

function main() {
  const root = process.cwd();
  const readText = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
  const readDir = (dir) => {
    try {
      return readdirSync(path.join(root, dir));
    } catch {
      return [];
    }
  };

  const failures = evaluateAgentContext({ readText, readDir });
  if (failures.length > 0) {
    console.error(`Agent-context gate failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Agent-context gate OK: ${CANONICAL} within ${AGENTS_MAX_LINES} lines, no harness adapters present.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
