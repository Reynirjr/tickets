/*
  SMTP smoke test for Mailtrap Live SMTP (or any SMTP server).
  Usage:
    node apps/tickets/scripts/smtp-test.cjs you@example.com

  It loads env vars from apps/tickets/.env if they aren't already set.
*/

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

function loadDotEnvIfPresent(envPath) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // supports: KEY=value OR KEY = value
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let value = m[2] ?? "";

    // Strip surrounding quotes
    value = value.replace(/^['"]/, "").replace(/['"]$/, "");

    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
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

async function main() {
  const envPath = path.resolve(__dirname, "..", ".env");
  loadDotEnvIfPresent(envPath);

  const to = process.argv[2] || "brj46@hi.is";

  const server = parseEmailServer(process.env.EMAIL_SERVER);
  if (!server) {
    console.error("EMAIL_SERVER missing/invalid");
    process.exit(2);
  }

  const user = String(process.env.EMAIL_USERNAME ?? "").trim();
  const pass = String(process.env.EMAIL_PASSWORD ?? "");
  const from = String(process.env.EMAIL_SENDER ?? "Tickets <tickets@nord.is>").trim();

  if (!user || !pass) {
    console.error("EMAIL_USERNAME/EMAIL_PASSWORD missing");
    process.exit(2);
  }

  const transporter = nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from,
    to,
    subject: "Tickets SMTP test",
    text: `This is a test email from the tickets app.\n\nTime: ${new Date().toISOString()}`,
  });

  console.log(JSON.stringify({
    ok: true,
    to,
    host: server.host,
    port: server.port,
    secure: server.secure,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2));
  process.exit(1);
});
