#!/usr/bin/env node
/*
Resend ticket-link emails from a previous bulk send log (JSONL).

This does NOT create new tickets; it only re-sends the link for existing tickets.

Usage:
  node scripts/resend-ticket-links-from-log.mjs --in tmp-send-log.jsonl --out tmp-resend-log.jsonl

Options:
  --in <path>            Input JSONL (default: tmp-send-log.jsonl)
  --out <path>           Output JSONL with resend results (default: tmp-resend-log.jsonl)
  --delay-ms <n>         Delay between emails (default: 800)
  --subject <text>       Email subject (default: "Þinn miði á Árshátíð FV!")
  --dry-run              Print what would be sent
  --only <email,...>     Only resend to these emails
  --skip <email,...>     Skip these emails

Env (auto-loaded from apps/tickets/.env if present):
  EMAIL_SERVER
  EMAIL_PORT (optional; default 587)
  EMAIL_USERNAME
  EMAIL_PASSWORD
  EMAIL_SENDER
  EMAIL_REPLY_TO (optional)
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function parseEmailServer(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (/^smtps?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const host = u.hostname;
      const port = u.port ? Number(u.port) : u.protocol.toLowerCase() === "smtps:" ? 465 : 587;
      const secure = u.protocol.toLowerCase() === "smtps:" || port === 465;
      if (!host || !Number.isFinite(port)) return null;
      return { host, port, secure };
    } catch {
      return null;
    }
  }

  const m = raw.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const host = m[1].trim();
  const port = m[2] ? Number(m[2]) : Number(process.env.EMAIL_PORT ?? 587);
  const secure = port === 465;
  if (!host || !Number.isFinite(port)) return null;
  return { host, port, secure };
}

function argValue(argv, name, fallback = "") {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return String(argv[i + 1] ?? fallback);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function parseCsvEmails(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore
    }
  }
  return out;
}

async function main() {
  loadDefaultEnv();

  const argv = process.argv.slice(2);
  const inPath = argValue(argv, "--in", "tmp-send-log.jsonl");
  const outPath = argValue(argv, "--out", "tmp-resend-log.jsonl");
  const delayMs = Number(argValue(argv, "--delay-ms", "800")) || 0;
  const subject = argValue(argv, "--subject", "Þinn miði á Árshátíð FV!").trim();
  const dryRun = hasFlag(argv, "--dry-run");
  const only = parseCsvEmails(argValue(argv, "--only", ""));
  const skip = parseCsvEmails(argValue(argv, "--skip", ""));

  const rows = readJsonl(inPath).filter((r) => r && r.ok === true && r.email && r.ticketUrl);
  if (rows.length === 0) {
    console.error(JSON.stringify({ ok: false, error: `No ok rows found in ${inPath}` }, null, 2));
    process.exit(2);
  }

  // Resume: skip emails already resent successfully
  const already = new Set();
  for (const r of readJsonl(outPath)) {
    if (r && r.ok === true && r.email) already.add(String(r.email).toLowerCase());
  }

  const server = parseEmailServer(process.env.EMAIL_SERVER);
  if (!server) {
    console.error("EMAIL_SERVER missing/invalid");
    process.exit(2);
  }

  const user = String(process.env.EMAIL_USERNAME ?? "").trim();
  const pass = String(process.env.EMAIL_PASSWORD ?? "");
  if (!user || !pass) {
    console.error("EMAIL_USERNAME/EMAIL_PASSWORD missing");
    process.exit(2);
  }

  const from = String(process.env.EMAIL_SENDER ?? "").trim();
  if (!from) {
    console.error("Missing sender: set EMAIL_SENDER");
    process.exit(2);
  }

  const replyTo = String(process.env.EMAIL_REPLY_TO ?? "").trim();

  const transporter = nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user, pass },
  });

  let attempted = 0;
  let sent = 0;
  let skipped = 0;

  for (const r of rows) {
    const email = String(r.email).trim();
    const emailKey = email.toLowerCase();
    const url = String(r.ticketUrl).trim();

    if (!email || !url) continue;
    if (already.has(emailKey)) {
      skipped++;
      continue;
    }
    if (only.size > 0 && !only.has(emailKey)) {
      skipped++;
      continue;
    }
    if (skip.has(emailKey)) {
      skipped++;
      continue;
    }

    attempted++;

      // Strict link-only: plain text with only the URL.
      const text = `${url}`;

    const startedAt = new Date().toISOString();

    if (dryRun) {
      console.log(`[dry-run] Would resend to ${email} -> ${url}`);
      appendJsonl(outPath, { ok: true, dryRun: true, startedAt, email, ticketUrl: url, subject });
      sent++;
    } else {
      try {
        const info = await transporter.sendMail({
          from,
          to: email,
          ...(replyTo ? { replyTo } : {}),
          subject,
          text,
        });

        appendJsonl(outPath, {
          ok: true,
          startedAt,
          email,
          ticketUrl: url,
          subject,
          messageId: info.messageId,
          response: info.response,
          accepted: info.accepted,
          rejected: info.rejected,
        });

        sent++;
      } catch (e) {
        appendJsonl(outPath, {
          ok: false,
          startedAt,
          email,
          ticketUrl: url,
          subject,
          error: e?.message ?? String(e),
        });
      }
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(JSON.stringify({ ok: true, in: inPath, out: outPath, attempted, sent, skipped, delayMs }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2));
  process.exit(1);
});
