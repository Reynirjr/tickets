#!/usr/bin/env node
/*
Create a ticket directly in Postgres, then send a link-only email via SMTP.

This avoids the API email path entirely (no attachments).

Usage:
  node scripts/issue-link-only-db.mjs --email someone@example.com [--name "Full Name"] [--type "Matur + ball"] [--public-base https://www.whoops.is]

Env (auto-loaded from apps/tickets/.env if present):
  DATABASE_URL
  TICKETS_PUBLIC_BASE_URL (optional)
  EMAIL_SERVER
  EMAIL_PORT (optional)
  EMAIL_USERNAME
  EMAIL_PASSWORD
  EMAIL_SENDER
  EMAIL_REPLY_TO (optional)
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import nodemailer from "nodemailer";

const { Client } = pg;

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
  const email = argValue(argv, "--email").trim();
  const name = argValue(argv, "--name").trim() || null;
  const typeName = (argValue(argv, "--type") || "Matur + ball").trim();
  const publicBase = (argValue(argv, "--public-base") || process.env.TICKETS_PUBLIC_BASE_URL || "https://www.whoops.is")
    .trim()
    .replace(/\/$/, "");

  if (!email) {
    console.error("Missing --email");
    process.exit(2);
  }

  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.error("Missing DATABASE_URL");
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

  const from = String(process.env.EMAIL_SENDER ?? "").trim();
  if (!from) {
    console.error("Missing EMAIL_SENDER");
    process.exit(2);
  }

  const replyTo = String(process.env.EMAIL_REPLY_TO ?? "").trim();

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  let ticketId = "";
  try {
    await client.connect();

    const ttRes = await client.query(
      `select id, name from ticket_types where lower(name) = lower($1) limit 1`,
      [typeName]
    );

    if (ttRes.rowCount === 0) {
      console.error(`No ticket type named "${typeName}" in DB`);
      process.exit(2);
    }

    const ticketTypeId = ttRes.rows[0].id;

    const res = await client.query(
      `insert into tickets (ticket_type_id, email, name)
       values ($1, $2, $3)
       returning id`,
      [ticketTypeId, email, name]
    );

    ticketId = String(res.rows[0].id);
  } finally {
    try {
      await client.end();
    } catch {}
  }

  const ticketUrl = `${publicBase}/t/${ticketId}`;
  const subject = "Þinn miði á Árshátíð FV!";

  const transporter = nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user, pass },
  });

  const greeting = name ? `Hæ ${name}` : "Hæ";
  const text = `${subject}\n\n${greeting}.\n\n${ticketUrl}`;
  const html = `<div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.4">
    <h1 style="margin:0 0 12px">${subject}</h1>
    <p style="margin:0 0 12px">${greeting}.</p>
    <p style="margin:0 0 8px"><a href="${ticketUrl}">${ticketUrl}</a></p>
  </div>`;

  const info = await transporter.sendMail({
    from,
    to: email,
    ...(replyTo ? { replyTo } : {}),
    subject,
    text,
    html,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        email,
        name,
        ticketId,
        ticketUrl,
        subject,
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
