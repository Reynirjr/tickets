import { NextResponse } from "next/server";
import { Client } from "pg";
import nodemailer from "nodemailer";
import QRCode from "qrcode";

export const runtime = "nodejs";

function parseEmailServer(value?: string | null): { host: string; port: number; secure: boolean } | null {
  const raw = (value ?? "").toString().trim();
  if (!raw) return null;

  // Support:
  // - "live.smtp.mailtrap.io" (defaults)
  // - "live.smtp.mailtrap.io:587"
  // - "smtp://user:pass@host:port" or "smtps://..."
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

function getSmtpTransport() {
  const server = parseEmailServer(process.env.EMAIL_SERVER);
  if (!server) {
    return { ok: false as const, error: "EMAIL_SERVER missing or invalid" };
  }

  const user = (process.env.EMAIL_USERNAME ?? "").toString().trim();
  const pass = (process.env.EMAIL_PASSWORD ?? "").toString();
  if (!user || !pass) {
    return { ok: false as const, error: "EMAIL_USERNAME/EMAIL_PASSWORD missing" };
  }

  const transporter = nodemailer.createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: { user, pass },
  });

  return { ok: true as const, transporter };
}

function normalizeTicketTypeKey(value?: string | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function formatEventDateParts(value?: string | null): { day: string; month: string } | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("is-IS", {
    timeZone: "Atlantic/Reykjavik",
    day: "numeric",
    month: "short",
  }).formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("day");
  const monthRaw = get("month");
  if (!day || !monthRaw) return null;

  // is-IS short months often include trailing '.' (e.g. 'feb.'). Normalize to 'feb'.
  const month = monthRaw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");

  if (!month) return null;
  return { day: String(Number(day)), month };
}

function formatTimeFromStartsAt(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const parts = new Intl.DateTimeFormat("is-IS", {
    timeZone: "Atlantic/Reykjavik",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour");
  const minute = get("minute");
  if (!hour || !minute) return "";
  return `${hour}:${minute}`;
}

function isFoodAndBallTicketType(normalizedKey: string): boolean {
  // Covers: "Matur + ball", "Mat og ball", "Matur og ball", and variants with extra text.
  const hasBall = /\bball\b/.test(normalizedKey);
  const hasFood = /\bmatur\b/.test(normalizedKey) || /\bmat\b/.test(normalizedKey);
  return hasBall && hasFood;
}

function isJustBallTicketType(normalizedKey: string): boolean {
  // Covers: "Bara ball" and variants with extra text.
  // Do NOT match generic "... ball ..." here (food+ball is handled separately).
  if (normalizedKey === "ball") return true;
  return /\bbara\b/.test(normalizedKey) && /\bball\b/.test(normalizedKey);
}

function formatSubjectStart(ticketType: string, startsAt: string | null): string {
  const date = formatEventDateParts(startsAt);
  if (!date) return "";

  const key = normalizeTicketTypeKey(ticketType);
  let time = "";

  // Precedence matters: "mat/matur" + "ball" must win over any "ball" matching.
  if (isFoodAndBallTicketType(key)) {
    time = "18:30";
  } else if (isJustBallTicketType(key)) {
    time = "21:00";
  } else {
    time = formatTimeFromStartsAt(startsAt);
  }

  if (!time) return "";
  return `${date.day}. ${date.month} kl:${time}`;
}

function toBooleanOrUndefined(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (!s) return undefined;
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
  }
  return undefined;
}

export async function POST(req: Request) {
  const requiredKey = process.env.ISSUE_API_KEY;
  if (requiredKey) {
    const auth = req.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1]?.trim() || "";
    if (!token || token !== requiredKey) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const { ticketTypeId, email, name, linkOnly, skipEmail } = await req.json().catch(() => ({}));

  if (!ticketTypeId || !email) {
    return NextResponse.json({ ok: false, error: "ticketTypeId and email are required" }, { status: 400 });
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const ttRes = await client.query(
      `
      select
        tt.id,
        tt.name as ticket_type,
        tt.price_isk,
        e.name as event_name,
        e.starts_at
      from ticket_types tt
      join events e on e.id = tt.event_id
      where tt.id = $1
      limit 1
      `,
      [ticketTypeId]
    );

    if (ttRes.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "Invalid ticketTypeId" }, { status: 400 });
    }

    const ticketType = ttRes.rows[0].ticket_type as string;
    const subjectLine = "Þinn miði á Árshátíð FV!";

    const res = await client.query(
      `insert into tickets (ticket_type_id, email, name)
       values ($1, $2, $3)
       returning id, issued_at`,
      [ticketTypeId, email, name ?? null]
    );

    const ticketId = res.rows[0].id as string;
    const origin = new URL(req.url).origin;
    const publicBase = process.env.TICKETS_PUBLIC_BASE_URL ?? origin;
    const ticketUrl = `${publicBase}/t/${ticketId}`;

    const linkOnlyParsed = toBooleanOrUndefined(linkOnly);
    const isLinkOnly = linkOnlyParsed ?? true;
    const shouldAttachQr = !isLinkOnly;
    let qrPngBase64: string | null = null;
    if (shouldAttachQr) {
      // QR should match what the door-scanner expects (ticket UUID).
      // Note: many email clients block/strip `data:` image URLs. We host the QR and also attach it.
      qrPngBase64 = (await QRCode.toBuffer(ticketId, { type: "png", margin: 1, scale: 8 })).toString("base64");
    }

    let emailResult:
      | { ok: true; id?: string }
      | { ok: false; error: string; skipped?: boolean }
      | undefined;
    let emailMeta: { from?: string; replyTo?: string | null } | undefined;

    const skipEmailParsed = toBooleanOrUndefined(skipEmail) ?? false;

    if (skipEmailParsed) {
      emailResult = { ok: false, error: "Skipped", skipped: true };
    } else {
      try {
        const from = (process.env.EMAIL_SENDER ?? process.env.RESEND_FROM ?? "mailtrap@nord.is").toString();
        const replyTo = (process.env.EMAIL_REPLY_TO ?? process.env.RESEND_REPLY_TO ?? "").toString().trim();
        emailMeta = { from, replyTo: replyTo || null };

        const mailer = getSmtpTransport();
        if (!mailer.ok) {
          emailResult = { ok: false, error: mailer.error, skipped: true };
        } else {
          const safeName = (name ?? "").toString().trim();
          const greeting = safeName ? `Hæ ${safeName}` : "Hæ";

          const html = `
            <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.4">
              <h1 style="margin: 0 0 8px">${subjectLine}</h1>
              <p style="margin: 0 0 12px">${greeting}.</p>

              <p style="margin: 0 0 8px">Opna miða: <a href="${ticketUrl}">${ticketUrl}</a></p>
              <p style="margin: 14px 0 0; font-size: 12px; color: #666">Miða-ID: ${ticketId}</p>
            </div>
          `;

          const text = `${subjectLine}\n\n${greeting}.\n\nOpna miða: ${ticketUrl}\n\nMiða-ID: ${ticketId}`;

          const info = await mailer.transporter.sendMail({
            from,
            to: email,
            ...(replyTo ? { replyTo } : {}),
            subject: subjectLine,
            text,
            html,
            ...(shouldAttachQr && qrPngBase64
              ? {
                  attachments: [
                    {
                      filename: `ticket-${ticketId}.png`,
                      content: Buffer.from(qrPngBase64, "base64"),
                      contentType: "image/png",
                    },
                  ],
                }
              : {}),
          });

          // Nodemailer returns a messageId; Mailtrap may also add extra metadata.
          emailResult = { ok: true, id: info.messageId };
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        emailResult = { ok: false, error: message };
      }
    }

    return NextResponse.json({
      ok: true,
      ticketId,
      ticketUrl,
      issuedAt: res.rows[0].issued_at,
      subject: subjectLine,
      emailMeta,
      email: emailResult,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try { await client.end(); } catch {}
  }
}