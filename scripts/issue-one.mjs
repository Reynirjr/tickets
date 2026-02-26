#!/usr/bin/env node
/*
Issue ONE ticket via the deployed tickets app.

Usage:
  node scripts/issue-one.mjs --email you@example.com [--name "Full Name"] [--type "matur + ball"] [--base-url https://...]

Env (loaded from apps/tickets/.env automatically if present):
  ISSUE_API_KEY
  VERCEL_PROTECTION_BYPASS (or PROTECTION_BYPASS / Protection_Bypass)
  TICKETS_BASE_URL
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

function normalizeTypeName(s) {
  return String(s || "").trim().toLowerCase();
}

async function main() {
  loadDefaultEnv();

  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? "" : String(argv[i + 1] ?? "");
  };
  const hasFlag = (name) => argv.includes(name);

  const email = (arg("--email") || "").trim();
  const name = (arg("--name") || "").trim() || undefined;
  const typeRaw = (arg("--type") || "matur + ball").trim();
  const baseUrl = (arg("--base-url") || process.env.TICKETS_BASE_URL || "https://tickets-ten-gray.vercel.app")
    .trim()
    .replace(/\/$/, "");
  const attachQr = hasFlag("--attach-qr");
  const linkOnly = hasFlag("--link-only") ? true : attachQr ? false : true;

  if (!email) {
    console.error("Missing --email");
    process.exit(2);
  }

  const issueApiKey = (process.env.ISSUE_API_KEY || "").trim();

  const vercelProtectionBypass = (
    process.env.VERCEL_PROTECTION_BYPASS ||
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
    process.env.PROTECTION_BYPASS ||
    process.env.Protection_Bypass ||
    process.env.PROTECTION_BYPASS_SECRET ||
    ""
  ).trim();

  const protectionHeaders = {};
  if (vercelProtectionBypass) {
    protectionHeaders["x-vercel-protection-bypass"] = vercelProtectionBypass;
  }

  // 1) Load types
  const typesRes = await fetch(`${baseUrl}/api/tickets/types`, {
    headers: protectionHeaders,
    cache: "no-store",
  });
  const typesJson = await typesRes.json().catch(() => ({}));
  if (!typesRes.ok || !typesJson?.ok) {
    console.error("Failed to fetch ticket types:", typesJson);
    process.exit(1);
  }

  const wanted = normalizeTypeName(typeRaw);
  const row = (typesJson.rows || []).find((r) => normalizeTypeName(r?.name) === wanted);
  if (!row?.id) {
    const names = Array.from(
      new Set((typesJson.rows || []).map((r) => String(r?.name ?? "")).filter(Boolean))
    ).sort();
    console.error(`No ticket type named "${typeRaw}". Available:`, names);
    process.exit(2);
  }

  // 2) Issue ticket
  const headers = {
    ...protectionHeaders,
    "Content-Type": "application/json",
    ...(issueApiKey ? { Authorization: `Bearer ${issueApiKey}` } : {}),
  };

  const res = await fetch(`${baseUrl}/api/tickets/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ticketTypeId: row.id,
      email,
      ...(name ? { name } : {}),
      ...(linkOnly ? { linkOnly: true } : {}),
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    console.error("Issue failed:", json);
    process.exit(1);
  }

  if (json?.email && json.email.ok !== true) {
    console.error("Ticket created but email failed:", json.email);
    console.log(JSON.stringify({ ticketId: json.ticketId, ticketUrl: json.ticketUrl }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        ticketType: row.name,
        ticketId: json.ticketId,
        ticketUrl: json.ticketUrl,
        email: email,
        emailResult: json.email,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
