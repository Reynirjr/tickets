#!/usr/bin/env node
/*
Send a simple ticket-link email via SMTP (no attachments).

Usage:
  node scripts/send-ticket-link.mjs --to someone@example.com --url https://... --subject "..." [--from "Name <email@x>" | --from email@x]

Env (auto-loaded from apps/tickets/.env if present):
  EMAIL_SERVER
  EMAIL_PORT (optional; default 587)
  EMAIL_USERNAME
  EMAIL_PASSWORD
  EMAIL_SENDER
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

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

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return "";
  return String(argv[i + 1] ?? "");
}

async function main() {
  loadDefaultEnv();

  const argv = process.argv.slice(2);
  const to = argValue(argv, "--to").trim();
  const url = argValue(argv, "--url").trim();
  const subject = (argValue(argv, "--subject") || "Ticket link").trim();
  const fromCli = argValue(argv, "--from").trim();

  if (!to) {
    console.error("Missing --to");
    process.exit(2);
  }
  if (!url) {
    console.error("Missing --url");
    process.exit(2);
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

  const fromEnv = String(process.env.EMAIL_SENDER ?? "").trim();
  const from = fromCli || fromEnv;
  if (!from) {
    console.error("Missing sender: set EMAIL_SENDER or pass --from");
    process.exit(2);
  }

  const transporter = nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user, pass },
  });

  // Strict link-only: plain text with only the URL.
  const text = `${url}`;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        from,
        to,
        host: server.host,
        port: server.port,
        secure: server.secure,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2));
  process.exit(1);
});
