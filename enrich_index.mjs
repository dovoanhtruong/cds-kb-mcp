#!/usr/bin/env node
// enrich_index.mjs — Build search_index.json from the view .md files.
//
// Usage: node enrich_index.mjs <path-to-cds-kb-data>
//
// The view .md files are the single source of truth. For each view we read the
// YAML frontmatter (name, description, app_component, tags) plus the DDL
// @EndUserText.label, and derive the searchable document. Optional frontmatter
// fields make richer enrichment possible without touching this script again:
//
//   semantic_en: <one-line English business description>
//   semantic_vi: <one-line Vietnamese business description>
//   keywords:                      # extra synonyms (any language)
//     - đơn mua hàng
//     - procurement
//
// Backward compatible: views without semantic_*/keywords fall back to the DDL
// label exactly like before. bo/lob/module are now taken from the frontmatter
// (tags + app_component), not from the previous index, so edits to the data
// repo are reflected and deleted views drop out.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const dataRoot = process.argv[2];
if (!dataRoot) {
  console.error('Usage: node enrich_index.mjs <path-to-cds-kb-data>');
  process.exit(1);
}

const viewsDir = path.join(dataRoot, 'views');
const indexFile = path.join(dataRoot, 'index', 'search_index.json');

// ── Read current index (for options/schemaVersion only) & taxonomy ─────────
console.log('Reading index options and taxonomy...');
const indexData = JSON.parse(await fs.readFile(indexFile, 'utf-8'));
const options = indexData.options;
if (!options.fields.includes('synonyms')) options.fields.push('synonyms');
if (!options.storeFields.includes('synonyms')) options.storeFields.push('synonyms');

let taxonomy = null;
try {
  taxonomy = JSON.parse(await fs.readFile(path.join(dataRoot, 'index', 'taxonomy.json'), 'utf-8'));
  console.log('Loaded taxonomy with', Object.keys(taxonomy.tagToKeywords || {}).length, 'tag→keyword maps.');
} catch { console.log('No taxonomy.json found, skipping taxonomy synonyms.'); }

// ── Minimal frontmatter helpers ────────────────────────────────────────────
function frontmatter(md) { const m = md.match(/^---\n([\s\S]*?)\n---/); return m ? m[1] : ''; }
function scalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^['"]|['"]$/g, '').trim();
}
function listBlock(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\n((?:[ \\t]*-[ \\t].*\\n?)*)`, 'm'));
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/^[ \t]*-[ \t]+/, '').trim()).filter(Boolean);
}

// ── Build one document per view file (source of truth) ──────────────────────
console.log('Scanning view files...');
const viewFiles = (await fs.readdir(viewsDir)).filter((f) => f.endsWith('.md'));

const docs = [];
let enriched = 0, withLabel = 0, withBo = 0, synCount = 0;

for (let i = 0; i < viewFiles.length; i++) {
  const file = viewFiles[i];
  const content = await fs.readFile(path.join(viewsDir, file), 'utf-8');
  const name = file.replace(/\.md$/i, '');
  const fm = frontmatter(content);

  const tags = listBlock(fm, 'tags');
  const lob = (tags.find((t) => t.startsWith('lob:')) || '').slice(4);
  const bo = (tags.find((t) => t.startsWith('bo:')) || '').slice(3);
  const appComponent = scalar(fm, 'app_component');
  const module = appComponent ? appComponent.split('-')[0] : '';

  const label = (content.match(/@EndUserText\.label\s*:\s*'([^']+)'/) || [])[1]?.trim() || '';
  let description = scalar(fm, 'description') || label;
  if ((description.length < 40 || !description.includes(' ')) && label) description = label;

  const semEn = scalar(fm, 'semantic_en');
  const semVi = scalar(fm, 'semantic_vi');
  const semantic = [semEn, semVi].filter(Boolean).join(' — ');
  const semanticDescription = semantic || label || description;
  if (semEn || semVi) enriched++;
  if (label) withLabel++;
  if (bo) withBo++;

  // synonyms: taxonomy keywords for lob+bo + per-view frontmatter keywords
  const kw = new Set();
  const t2k = taxonomy?.tagToKeywords || {};
  if (lob && t2k[`lob:${lob.toLowerCase()}`]) for (const k of t2k[`lob:${lob.toLowerCase()}`]) kw.add(k);
  if (bo && t2k[`bo:${bo.toLowerCase()}`]) for (const k of t2k[`bo:${bo.toLowerCase()}`]) kw.add(k);
  for (const k of listBlock(fm, 'keywords')) kw.add(k);
  if (kw.size) synCount++;

  docs.push({
    id: i,
    name,
    semanticDescription,
    description,
    tagText: tags.join(' '),
    appComponent,
    synonyms: [...kw].join(' '),
    path: `views/${file}`,
    module,
    lob,
    bo,
  });
}

console.log(`Views: ${docs.length} | with DDL label: ${withLabel} | with bo: ${withBo}`);
console.log(`Genuinely enriched (semantic_en/vi): ${enriched} | with synonyms: ${synCount}`);

// ── Build MiniSearch index ─────────────────────────────────────────────────
const MiniSearch = (await import('minisearch')).default;
const mini = new MiniSearch(options);
mini.addAll(docs);

const output = {
  schemaVersion: indexData.schemaVersion,
  builtAt: new Date().toISOString(),
  viewCount: docs.length,
  enrichedCount: enriched, // now: views with a real semantic_en/semantic_vi (not just a copied label)
  options,
  minisearch: JSON.stringify(mini),
};

try { await fs.copyFile(indexFile, indexFile + '.bak'); } catch {}
await fs.writeFile(indexFile, JSON.stringify(output), 'utf-8');
const sizeKB = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(0);
console.log(`\nWrote ${indexFile} (${sizeKB} KB) — viewCount=${docs.length}, enrichedCount=${enriched}`);

// ── version manifest ───────────────────────────────────────────────────────
function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execSync(`git -C "${dataRoot}" rev-parse HEAD`, { encoding: 'utf-8' }).trim(); }
  catch { return `builtAt:${output.builtAt}`; }
}
const versionManifest = {
  schemaVersion: output.schemaVersion ?? 1,
  commit: resolveCommit(),
  builtAt: output.builtAt,
  viewCount: output.viewCount,
  enrichedCount: output.enrichedCount,
};
await fs.writeFile(path.join(dataRoot, 'index', 'version.json'), JSON.stringify(versionManifest, null, 2) + '\n', 'utf-8');
console.log(`version manifest commit=${versionManifest.commit.slice(0, 8)}`);
