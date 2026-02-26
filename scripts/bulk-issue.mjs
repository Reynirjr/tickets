#!/usr/bin/env node
/*
Bulk issue tickets from a CSV export (e.g. Google Sheets).

Usage:
  node scripts/bulk-issue.mjs path/to/guests.csv [--email someone@x.y] [--dry-run]

Env:
  TICKETS_BASE_URL   Base URL of tickets app (default: http://localhost:3000)
  ISSUE_API_KEY      If set on server, also set here to send Authorization header
  ONLY_EMAIL         If set, only process rows matching this email (case-insensitive)
  DRY_RUN            If "1", do not call /api/tickets/issue; just print what would be sent
  ONLY_PAID          If "1" (default), only process rows where payment is confirmed

CSV columns (case-insensitive):
  - email (required)
  - name (optional)
  - ticket_type OR ticketType OR type (required unless ticketTypeId provided)
  - ticketTypeId (optional; if present, overrides name mapping)

Notes:
  - This script calls /api/tickets/types to map ticket type names to ids.
  - It calls /api/tickets/issue for each row.
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    // skip completely empty trailing line
    if (row.length === 1 && row[0] === "" && rows.length === 0) return;
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }

    if (ch === "\n") {
      pushField();
      pushRow();
      i += 1;
      continue;
    }

    if (ch === "\r") {
      // swallow \r (Windows newlines)
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  pushField();
  pushRow();
  return rows;
}

function normalizeHeader(h) {
  // Make headers stable across locales/diacritics (e.g. "HÍ email" -> "hi_email").
  return String(h || "")
    .trim()
    .toLowerCase()
    // Icelandic letters that are not simple diacritics
    .replace(/þ/g, "th")
    .replace(/ð/g, "d")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function normalizeTypeName(s) {
  return String(s || "").trim().toLowerCase();
}

async function main() {
  // Load apps/tickets/.env by default for local scripts.
  // (Vercel env vars will be set in the deployment environment instead.)
  loadDefaultEnv();

  const argv = process.argv.slice(2);
  let csvPath = "";
  let cliOnlyEmail = "";
  let cliDryRun = false;
  let cliBaseUrl = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--email") {
      cliOnlyEmail = String(argv[i + 1] || "").trim();
      i++;
      continue;
    }

    if (a === "--dry-run") {
      cliDryRun = true;
      continue;
    }

    if (a === "--base-url") {
      cliBaseUrl = String(argv[i + 1] || "").trim();
      i++;
      continue;
    }

    if (!a.startsWith("-") && !csvPath) {
      csvPath = a;
      continue;
    }
  }

  if (!csvPath) {
    console.error(
      "Missing CSV path. Usage: node scripts/bulk-issue.mjs guests.csv [--email someone@x.y] [--dry-run]"
    );
    process.exit(2);
  }

  const baseUrl = (cliBaseUrl || process.env.TICKETS_BASE_URL || "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  const issueApiKey = process.env.ISSUE_API_KEY || "";
  const onlyEmail = (cliOnlyEmail || process.env.ONLY_EMAIL || "").trim().toLowerCase();
  const dryRun = cliDryRun || String(process.env.DRY_RUN || "").trim() === "1";

  const vercelProtectionBypass = (
    process.env.VERCEL_PROTECTION_BYPASS ||
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    // Common ad-hoc names people use in local .env files
    process.env.PROTECTION_BYPASS ||
    process.env.Protection_Bypass ||
    process.env.PROTECTION_BYPASS_SECRET ||
    ""
  ).trim();

  const protectionHeaders = {};
  if (vercelProtectionBypass) {
    protectionHeaders["x-vercel-protection-bypass"] = vercelProtectionBypass;
  }

  const abs = path.resolve(process.cwd(), csvPath);
  const csv = fs.readFileSync(abs, "utf8");
  const rows = parseCsv(csv);

  if (rows.length < 2) {
    console.error("CSV must include a header row and at least one data row.");
    process.exit(2);
  }

  const header = rows[0].map(normalizeHeader);
  const idx = (name) => header.indexOf(name);

  // Google Forms often uses both "Email Address" and a separate "HÍ email".
  const emailIdxCandidates = [idx("hi_email"), idx("email_address"), idx("email")].filter(
    (v) => v !== -1
  );
  const iName = [idx("name"), idx("fullt_nafn"), idx("full_name")].find((v) => v !== -1) ?? -1;
  const iTicketTypeId = idx("tickettypeid");
  const iType = [
    idx("ticket_type"),
    idx("tickettype"),
    idx("type"),
    // "Hvernig miða ætlar þú að kaupa?" -> "hvernig_mida_aetlar_thu_ad_kaupa"
    idx("hvernig_mida_aetlar_thu_ad_kaupa"),
  ].find((v) => v !== -1) ?? -1;

  // Payment columns (optional). If present, we default to only sending when payment is confirmed.
  const iPaid1 = idx("buin_ad_borga");
  const iPaid2 = idx("greidsla_komin");
  const onlyPaid = (process.env.ONLY_PAID ?? "1").trim() !== "0";

  if (emailIdxCandidates.length === 0) {
    console.error("CSV is missing required column: email");
    process.exit(2);
  }
  function pickEmail(row) {
    for (const ix of emailIdxCandidates) {
      const v = String(row?.[ix] ?? "").trim();
      if (v) return v;
    }
    return "";
  }


  if (iTicketTypeId === -1 && iType === -1) {
    console.error("CSV must include either ticketTypeId or ticket_type/ticketType/type");
    process.exit(2);
  }

  // Fetch ticket types for name -> id mapping
  const typesRes = await fetch(`${baseUrl}/api/tickets/types`, {
    headers: protectionHeaders,
  });
  const typesJson = await typesRes.json();
  if (!typesRes.ok || !typesJson?.ok) {
    console.error("Failed to fetch ticket types:", typesJson);
    process.exit(1);
  }

  const typeMap = new Map();
  for (const r of typesJson.rows || []) {
    typeMap.set(normalizeTypeName(r.name), r.id);
  }

  const synonymToCanonical = new Map([
    // Sheet -> DB names
    ["mat og ball", "matur + ball"],
    ["matur og ball", "matur + ball"],
    ["ball", "bara ball"],
    ["bara ball", "bara ball"],
  ]);

  function isYes(v) {
    const s = String(v ?? "").trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    return s === "ja" || s === "yes" || s === "true" || s === "1";
  }

  function resolveTicketTypeId(typeNameRaw) {
    const typeName = String(typeNameRaw ?? "").trim();
    const key = normalizeTypeName(typeName);
    const direct = typeMap.get(key);
    if (direct) return direct;

    const canonical = synonymToCanonical.get(key);
    if (canonical) {
      const mapped = typeMap.get(normalizeTypeName(canonical));
      if (mapped) return mapped;
    }

    return "";
  }

  const headers = { ...protectionHeaders, "Content-Type": "application/json" };
  if (issueApiKey) headers["Authorization"] = `Bearer ${issueApiKey}`;

  let okCount = 0;
  let failCount = 0;
  let skippedOtherEmail = 0;
  let matchedOnlyEmail = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];

    const email = pickEmail(r);
    const name = iName === -1 ? undefined : String(r[iName] ?? "").trim() || undefined;

    if (onlyEmail) {
      if (!email) {
        skippedOtherEmail++;
        continue;
      }
      if (email.toLowerCase() !== onlyEmail) {
        skippedOtherEmail++;
        continue;
      }
      matchedOnlyEmail++;
    }

    if ((iPaid1 !== -1 || iPaid2 !== -1) && onlyPaid) {
      const paid = isYes(iPaid2 !== -1 ? r[iPaid2] : r[iPaid1]);
      if (!paid) {
        console.log(`[${i}/${rows.length - 1}] SKIP unpaid ${email || "(missing email)"}`);
        continue;
      }
    }

    const providedId = iTicketTypeId === -1 ? "" : String(r[iTicketTypeId] ?? "").trim();
    let ticketTypeId = providedId;

    if (!ticketTypeId) {
      const typeName = String(r[iType] ?? "").trim();
      ticketTypeId = resolveTicketTypeId(typeName);
      if (!ticketTypeId) {
        failCount++;
        console.error(
          `[${i}/${rows.length - 1}] ERROR unknown ticket type: "${typeName}" (email=${email})`
        );
        continue;
      }
    }

    if (!email) {
      failCount++;
      console.error(`[${i}/${rows.length - 1}] ERROR missing email`);
      continue;
    }

    if (dryRun) {
      okCount++;
      console.log(
        `[${i}/${rows.length - 1}] DRY_RUN ${email} -> would POST /api/tickets/issue with ticketTypeId=${ticketTypeId}`
      );
      continue;
    }

    const res = await fetch(`${baseUrl}/api/tickets/issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ticketTypeId, email, name }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json?.ok) {
      failCount++;
      console.error(`[${i}/${rows.length - 1}] FAIL ${email}:`, json);
    } else if (json?.email && json.email.ok !== true) {
      // Server created the ticket but did not successfully send the email.
      failCount++;
      console.error(`[${i}/${rows.length - 1}] FAIL email-not-sent ${email}:`, json.email);
    } else {
      okCount++;
      console.log(`[${i}/${rows.length - 1}] OK ${email} -> ${json.ticketId}`);
    }

    // small delay to avoid hammering email provider
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`Done. OK=${okCount} FAIL=${failCount}`);
  if (onlyEmail && matchedOnlyEmail === 0) {
    console.error(`No CSV rows matched ONLY_EMAIL=${onlyEmail} (skipped=${skippedOtherEmail}).`);
    process.exitCode = 1;
  }
  if (failCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
