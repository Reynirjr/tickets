#!/usr/bin/env node
/*
Send LINK-ONLY tickets to everyone who has "Greiðsla komin?" = "Já" in responses.csv.

- Issues tickets via the deployed API (sequentially, with delay + retries).
- Requests link-only email content (no attachments).
- Skips a built-in skip list plus any passed via --skip.
- Writes a JSONL log so you can resume safely.

Usage:
  node scripts/send-paid-link-tickets.mjs \
    --base-url https://www.whoops.is \
    --csv responses.csv \
    --delay-ms 800 \
    --log tmp-send-log.jsonl

Options:
  --dry-run            Do not issue anything, just show what would happen
  --max N              Limit number of sends
  --delay-ms N         Delay between sends (default 800)
  --log PATH           JSONL log path (default tmp-send-log.jsonl)
  --skip a@b.com,c@d   Comma-separated emails to skip (can be repeated)

Env (auto-loaded from apps/tickets/.env if present):
  ISSUE_API_KEY (optional)
  VERCEL_PROTECTION_BYPASS (or PROTECTION_BYPASS / Protection_Bypass)
  TICKETS_BASE_URL (optional)
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

    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
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

function normalizeEmail(s) {
  return String(s ?? "").trim().toLowerCase();
}

function stripDiacriticsLower(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isYesIcelandic(s) {
  const v = stripDiacriticsLower(s);
  return v === "ja" || v === "já" || v === "ja,";
}

function isProbablyEmail(s) {
  const v = String(s ?? "").trim();
  return /.+@.+\..+/.test(v);
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = line[i + 1];
        if (next === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === ',') {
      out.push(cur);
      cur = "";
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJsonlSet(logPath) {
  const sent = new Set();
  if (!logPath || !fs.existsSync(logPath)) return sent;
  const raw = fs.readFileSync(logPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj?.ok && obj?.email) sent.add(normalizeEmail(obj.email));
    } catch {
      // ignore
    }
  }
  return sent;
}

function appendJsonl(logPath, obj) {
  fs.appendFileSync(logPath, JSON.stringify(obj) + "\n");
}

async function fetchJsonWithRetry(url, init, opts) {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 800;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, json };

      const shouldRetry = res.status === 429 || res.status >= 500;
      if (!shouldRetry || attempt === maxAttempts) {
        return { ok: false, status: res.status, json };
      }

      const delay = Math.round(baseDelayMs * Math.pow(2, attempt - 1));
      await sleep(delay);
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) break;
      const delay = Math.round(baseDelayMs * Math.pow(2, attempt - 1));
      await sleep(delay);
    }
  }

  return { ok: false, status: 0, json: { ok: false, error: lastErr?.message ?? String(lastErr) } };
}

async function main() {
  loadDefaultEnv();

  const argv = process.argv.slice(2);
  const baseUrl = (argValue(argv, "--base-url", process.env.TICKETS_BASE_URL || "https://www.whoops.is") || "")
    .trim()
    .replace(/\/$/, "");
  const csvPath = argValue(argv, "--csv", "responses.csv").trim();
  const delayMs = Number(argValue(argv, "--delay-ms", "800"));
  const dryRun = hasFlag(argv, "--dry-run");
  const max = Number(argValue(argv, "--max", "0"));
  const logPath = argValue(argv, "--log", "tmp-send-log.jsonl").trim();

  const skipDefault = ["ros30@hi.is", "hfd2@hi.is", "ilv3@hi.is", "emj38@hi.is", "eto5@hi.is"].map(normalizeEmail);
  const skipFromCli = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip") skipFromCli.push(String(argv[i + 1] ?? ""));
  }
  const skipFromCliExpanded = skipFromCli
    .flatMap((s) => String(s || "").split(/[,\s]+/g).filter(Boolean))
    .map(normalizeEmail);
  const skip = new Set([...skipDefault, ...skipFromCliExpanded]);

  const issueApiKey = String(process.env.ISSUE_API_KEY ?? "").trim();
  const bypass = (
    process.env.VERCEL_PROTECTION_BYPASS ||
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    process.env.PROTECTION_BYPASS ||
    process.env.Protection_Bypass ||
    process.env.PROTECTION_BYPASS_SECRET ||
    ""
  ).trim();

  const protectionHeaders = {};
  if (bypass) protectionHeaders["x-vercel-protection-bypass"] = bypass;

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(2);
  }

  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    console.error("CSV has no rows");
    process.exit(2);
  }

  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const idxName = idx("Fullt nafn");
  const idxEmail = idx("HÍ email");
  const idxType = idx("Hvernig miða ætlar þú að kaupa?");
  const idxPaid = idx("Greiðsla komin?");

  const missing = [];
  if (idxName === -1) missing.push("Fullt nafn");
  if (idxEmail === -1) missing.push("HÍ email");
  if (idxType === -1) missing.push("Hvernig miða ætlar þú að kaupa?");
  if (idxPaid === -1) missing.push("Greiðsla komin?");
  if (missing.length) {
    console.error("CSV missing columns:", missing);
    process.exit(2);
  }

  // Load ticket types once
  const typesRes = await fetchJsonWithRetry(`${baseUrl}/api/tickets/types`, { headers: protectionHeaders }, {});
  if (!typesRes.ok || !typesRes.json?.ok) {
    console.error("Failed to fetch ticket types:", typesRes);
    process.exit(1);
  }

  const typesRows = Array.isArray(typesRes.json.rows) ? typesRes.json.rows : [];
  const typeIdByName = new Map();
  for (const row of typesRows) {
    const nm = String(row?.name ?? "").trim();
    const id = row?.id;
    if (nm && id) typeIdByName.set(stripDiacriticsLower(nm), id);
  }

  const paidRows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const emailRaw = cols[idxEmail] ?? "";
    const paidRaw = cols[idxPaid] ?? "";
    if (!isYesIcelandic(paidRaw)) continue;

    const email = normalizeEmail(emailRaw);
    if (!email || !isProbablyEmail(email)) continue;
    if (skip.has(email)) continue;

    const fullName = String(cols[idxName] ?? "").trim();
    const ticketChoice = String(cols[idxType] ?? "").trim();
    const ticketChoiceKey = stripDiacriticsLower(ticketChoice);

    let wantedTypeName = "";
    if (ticketChoiceKey.includes("mat") && ticketChoiceKey.includes("ball")) {
      wantedTypeName = "Matur + ball";
    } else if (ticketChoiceKey.includes("ball")) {
      wantedTypeName = "Bara ball";
    }

    if (!wantedTypeName) continue;

    const wantedId = typeIdByName.get(stripDiacriticsLower(wantedTypeName));
    if (!wantedId) continue;

    paidRows.push({ email, name: fullName || undefined, wantedTypeName, ticketTypeId: wantedId });
  }

  // Dedupe by email (keep first occurrence)
  const deduped = [];
  const seen = new Set();
  for (const r of paidRows) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    deduped.push(r);
  }

  const alreadySent = readJsonlSet(logPath);
  const pending = deduped.filter((r) => !alreadySent.has(r.email));

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        csv: csvPath,
        dryRun,
        delayMs,
        totalPaidEligible: deduped.length,
        alreadySent: alreadySent.size,
        pending: pending.length,
        log: logPath,
        skipCount: skip.size,
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log("Dry run sample (first 10 pending):");
    console.log(
      pending
        .slice(0, 10)
        .map((r) => ({ email: r.email, name: r.name, ticketType: r.wantedTypeName }))
        .map((o) => JSON.stringify(o))
        .join("\n")
    );
    return;
  }

  let sentCount = 0;
  const limit = Number.isFinite(max) && max > 0 ? max : pending.length;

  for (const row of pending.slice(0, limit)) {
    const headers = {
      ...protectionHeaders,
      "Content-Type": "application/json",
      ...(issueApiKey ? { Authorization: `Bearer ${issueApiKey}` } : {}),
    };

    const body = {
      ticketTypeId: row.ticketTypeId,
      email: row.email,
      ...(row.name ? { name: row.name } : {}),
      linkOnly: true,
    };

    const startedAt = new Date().toISOString();
    const res = await fetchJsonWithRetry(
      `${baseUrl}/api/tickets/issue`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      { maxAttempts: 6, baseDelayMs: 800 }
    );

    if (!res.ok || !res.json?.ok) {
      appendJsonl(logPath, {
        ok: false,
        startedAt,
        email: row.email,
        name: row.name,
        ticketType: row.wantedTypeName,
        status: res.status,
        error: res.json?.error ?? res.json,
      });
      console.error("Failed:", row.email, res.status, res.json?.error ?? res.json);
      await sleep(Math.max(500, delayMs));
      continue;
    }

    appendJsonl(logPath, {
      ok: true,
      startedAt,
      email: row.email,
      name: row.name,
      ticketType: row.wantedTypeName,
      ticketId: res.json.ticketId,
      ticketUrl: res.json.ticketUrl,
      emailResult: res.json.email,
    });

    sentCount++;
    console.log(`[${sentCount}/${limit}] Sent: ${row.email} -> ${res.json.ticketUrl}`);
    await sleep(Math.max(0, delayMs));
  }

  console.log(JSON.stringify({ ok: true, sent: sentCount, attempted: limit, log: logPath }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2));
  process.exit(1);
});
