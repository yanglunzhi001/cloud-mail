#!/usr/bin/env node
/**
 * Auto-generates wrangler.toml from wrangler-action.toml during `pnpm install`.
 * Runs in Cloudflare Pages CI so that `npx wrangler deploy` finds a valid config.
 * Exits silently in local dev and GitHub Actions (which has its own pipeline).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENV = process.env;
const ROOT = path.join(__dirname, '..');

// Only run in Cloudflare Pages CI
if (!ENV.JWT_SECRET || !ENV.DOMAIN || !ENV.ADMIN || ENV.GITHUB_ACTIONS) {
  process.exit(0);
}

const NAME = ENV.NAME || 'cloud-mail';

let text = fs.readFileSync(path.join(ROOT, 'wrangler-action.toml'), 'utf8');

// Remove a [[section]] block: from the header line to the next blank line (inclusive)
function removeSectionToBlank(src, headerPattern) {
  const lines = src.split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (!skip && headerPattern.test(line)) { skip = true; continue; }
    if (skip) {
      if (line.trim() === '') { skip = false; }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// Remove a range of lines from startPattern to endPattern (both inclusive)
function removeLinesRange(src, startPattern, endPattern) {
  const lines = src.split('\n');
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (!skip && startPattern.test(line)) { skip = true; continue; }
    if (skip) {
      if (endPattern.test(line)) { skip = false; }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function wrangler(args) {
  return execSync(`npx wrangler ${args}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseJsonArray(raw) {
  const match = raw.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

// Remove optional sections based on missing env vars
if (!ENV.R2_BUCKET_NAME) text = removeSectionToBlank(text, /^\[\[r2_buckets\]\]/);
if (!ENV.CUSTOM_DOMAIN)  text = removeSectionToBlank(text, /^\[\[routes\]\]/);
if (!ENV.PROJECT_LINK)   text = text.split('\n').filter(l => !/^project_link = /.test(l)).join('\n');
if (!ENV.LINUXDO_CLIENT_ID || !ENV.LINUXDO_CLIENT_SECRET) {
  text = removeLinesRange(text, /^linuxdo_client_id = /, /^linuxdo_switch = /);
}

// KV Namespace: use provided ID or auto-create
let KV_NAMESPACE_ID = ENV.KV_NAMESPACE_ID;
if (!KV_NAMESPACE_ID) {
  console.log('🔍 Looking up KV namespace...');
  try {
    const list = parseJsonArray(wrangler('kv namespace list'));
    const found = list.find(ns => ns.title === NAME);
    if (found) {
      KV_NAMESPACE_ID = found.id;
      console.log(`✅ KV found: ${KV_NAMESPACE_ID}`);
    } else {
      console.log(`⚠️  Creating KV namespace: ${NAME} ...`);
      execSync(`npx wrangler kv namespace create "${NAME}"`, { stdio: 'inherit' });
      const list2 = parseJsonArray(wrangler('kv namespace list'));
      KV_NAMESPACE_ID = list2.find(ns => ns.title === NAME)?.id;
      console.log(`✅ KV created: ${KV_NAMESPACE_ID}`);
    }
  } catch (e) {
    console.error('❌ KV setup failed:', e.message);
    process.exit(1);
  }
}

// D1 Database: use provided ID or auto-create
let D1_DATABASE_ID = ENV.D1_DATABASE_ID;
if (!D1_DATABASE_ID) {
  console.log('🔍 Looking up D1 database...');
  try {
    const list = parseJsonArray(wrangler('d1 list --json'));
    const found = list.find(db => db.name === NAME);
    if (found) {
      D1_DATABASE_ID = found.uuid;
      console.log(`✅ D1 found: ${D1_DATABASE_ID}`);
    } else {
      console.log(`⚠️  Creating D1 database: ${NAME} ...`);
      execSync(`npx wrangler d1 create "${NAME}"`, { stdio: 'inherit' });
      const list2 = parseJsonArray(wrangler('d1 list --json'));
      D1_DATABASE_ID = list2.find(db => db.name === NAME)?.uuid;
      console.log(`✅ D1 created: ${D1_DATABASE_ID}`);
    }
  } catch (e) {
    console.error('❌ D1 setup failed:', e.message);
    process.exit(1);
  }
}

// Substitute all template variables
text = text
  .replace(/\$\{NAME\}/g,                NAME)
  .replace(/"\$\{DOMAIN\}"/g,            ENV.DOMAIN)
  .replace(/\$\{CUSTOM_DOMAIN\}/g,       ENV.CUSTOM_DOMAIN || '')
  .replace(/\$\{ADMIN\}/g,               ENV.ADMIN)
  .replace(/\$\{JWT_SECRET\}/g,          ENV.JWT_SECRET)
  .replace(/\$\{D1_DATABASE_ID\}/g,      D1_DATABASE_ID)
  .replace(/\$\{KV_NAMESPACE_ID\}/g,     KV_NAMESPACE_ID)
  .replace(/\$\{R2_BUCKET_NAME\}/g,      ENV.R2_BUCKET_NAME || '')
  .replace(/\$\{PROJECT_LINK\}/g,        ENV.PROJECT_LINK || '')
  .replace(/\$\{ANALYSIS_CACHE\}/g,      ENV.ANALYSIS_CACHE || 'false')
  .replace(/\$\{AI_MODEL\}/g,            ENV.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct')
  .replace(/\$\{LINUXDO_CLIENT_ID\}/g,   ENV.LINUXDO_CLIENT_ID || '')
  .replace(/\$\{LINUXDO_CLIENT_SECRET\}/g, ENV.LINUXDO_CLIENT_SECRET || '')
  .replace(/\$\{LINUXDO_CALLBACK_URL\}/g,  ENV.LINUXDO_CALLBACK_URL || '')
  .replace(/\$\{LINUXDO_SWITCH\}/g,      ENV.LINUXDO_SWITCH || '');

// Append send_email binding if CLOUDFLARE_EMAIL is "true"
if ((ENV.CLOUDFLARE_EMAIL || '').toLowerCase() === 'true') {
  text += '\n[[send_email]]\nname = "email"\n';
}

fs.writeFileSync(path.join(ROOT, 'wrangler.toml'), text);
console.log('✅ wrangler.toml generated for Cloudflare Pages CI');
