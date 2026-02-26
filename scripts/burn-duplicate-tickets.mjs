#!/usr/bin/env node
/*
Burn (invalidate) duplicate tickets for one or more emails.

Mechanism: marks tickets as used=true so the scanner returns ALREADY_USED.

Usage:
  node scripts/burn-duplicate-tickets.mjs --base-url https://www.whoops.is --email brj46@hi.is --keep 566a6afc-...
  node scripts/burn-duplicate-tickets.mjs --base-url https://www.whoops.is --emails brj46@hi.is,benjaminreynir@hi.is,nord@hi.is --keep-latest

Options:
  --base-url <url>         Default: https://www.whoops.is
  --email <email>          Single email
  --emails <a,b,c>         Multiple emails
  --keep <ticketId>        Keep this ticketId for all emails (only valid if single --email)
  --keep-latest            Keep newest (by issued_at)
  --dry-run                Print what would be burned

Env (auto-loaded from apps/tickets/.env if present):
  ISSUE_API_KEY (used as Authorization Bearer; server also accepts ADMIN_API_KEY)
  VERCEL_PROTECTION_BYPASS (optional)
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnvIfPresent(envPath) {
  if (!envPath) return;
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2] ?? "";
    value = value.replace(/^['"]/, "").replace(/['"]$/, "");
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

function loadDefaultEnv() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const candidates = [
    path.resolve(process.cwd(), "apps", "tickets", ".env"),
    path.resolve(__dirname, "..", "apps", "tickets", ".env"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      loadDotEnvIfPresent(p);
      break;
    }
  }
}

function argValue(argv, name, fallback = "") {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return String(argv[i + 1] ?? fallback);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function parseEmails(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseIsoOrZero(v) {
  const d = new Date(String(v ?? ""));
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function main() {
  loadDefaultEnv();

  const argv = process.argv.slice(2);
  const baseUrl = argValue(argv, "--base-url", "https://www.whoops.is").replace(/\/$/, "");
  const emailOne = argValue(argv, "--email", "").trim();
  const emailsMany = parseEmails(argValue(argv, "--emails", ""));
  const keep = argValue(argv, "--keep", "").trim();
  const keepLatest = hasFlag(argv, "--keep-latest");
  const dryRun = hasFlag(argv, "--dry-run");

  const emails = emailOne ? [emailOne] : emailsMany;
  if (emails.length === 0) {
    console.error("Missing --email or --emails");
    process.exit(2);
  }
  if (keep && emails.length !== 1) {
    console.error("--keep is only allowed with a single --email");
    process.exit(2);
  }
  if (!keep && !keepLatest) {
    console.error("Specify either --keep <ticketId> or --keep-latest");
    process.exit(2);
  }

  const issueApiKey = String(process.env.ISSUE_API_KEY ?? "").trim();
  if (!issueApiKey) {
    console.error("Missing ISSUE_API_KEY in env (needed for admin endpoints)");
    process.exit(2);
  }

  const vercelProtectionBypass = (
    process.env.VERCEL_PROTECTION_BYPASS ||
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    process.env.PROTECTION_BYPASS ||
    process.env.Protection_Bypass ||
    process.env.PROTECTION_BYPASS_SECRET ||
    ""
  ).trim();

  const protectionHeaders = {};
  if (vercelProtectionBypass) protectionHeaders["x-vercel-protection-bypass"] = vercelProtectionBypass;

  for (const email of emails) {
    const headers = {
      ...protectionHeaders,
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueApiKey}`,
    };

    const listUrl = `${baseUrl}/api/admin/tickets/by-email`;
    const { res: listRes, json: listJson } = await fetchJson(listUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, limit: 200 }),
    });

    if (!listRes.ok || !listJson?.ok) {
      console.error("List failed:", { email, status: listRes.status, body: listJson });
      continue;
    }

    const rows = Array.isArray(listJson.rows) ? listJson.rows : [];
    const unused = rows.filter((r) => r && r.used === false);
    if (unused.length <= 1) {
      console.log(JSON.stringify({ email, ok: true, unusedCount: unused.length, burned: 0 }, null, 2));
      continue;
    }

    let keepId = keep;
    if (!keepId) {
      // keep-latest: choose by issued_at
      unused.sort((a, b) => parseIsoOrZero(b.issued_at) - parseIsoOrZero(a.issued_at));
      keepId = String(unused[0]?.id ?? "");
    }

    const toBurn = unused.map((r) => String(r.id)).filter((id) => id && id !== keepId);

    if (dryRun) {
      console.log(JSON.stringify({ email, keepId, toBurn, burned: 0, dryRun: true }, null, 2));
      continue;
    }

    const burnUrl = `${baseUrl}/api/admin/tickets/burn`;
    const { res: burnRes, json: burnJson } = await fetchJson(burnUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ticketIds: toBurn }),
    });

    if (!burnRes.ok || !burnJson?.ok) {
      console.error("Burn failed:", { email, status: burnRes.status, body: burnJson });
      continue;
    }

    console.log(JSON.stringify({ email, keepId, burned: burnJson.burned }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
