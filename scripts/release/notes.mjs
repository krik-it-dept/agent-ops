#!/usr/bin/env node
// Writes the release notes for a tag: the CHANGELOG.md section whose heading
// starts with "## <tag>", up to the next "## " heading. Fails when the section is
// missing or empty.
// Usage: node scripts/release/notes.mjs v1.2.3 dist/electron/release-notes.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseNotes(changelog, tag) {
  const lines = changelog.replaceAll('\r\n', '\n').split('\n');
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^## ${escaped}(\\s|$)`).test(line));
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no '## ${tag}' section.`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (!notes) {
    throw new Error(`The ${tag} section of CHANGELOG.md is empty.`);
  }
  return `${notes}\n`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [tag, output] = process.argv.slice(2);
  try {
    if (!tag || !output) {
      throw new Error('Usage: node scripts/release/notes.mjs <tag> <output file>');
    }
    const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), tag);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, notes);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
