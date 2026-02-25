import { NextResponse } from "next/server";
import { Client } from "pg";
import { Resend } from "resend";
import QRCode from "qrcode";

export const runtime = "nodejs";

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

  const { ticketTypeId, email, name } = await req.json().catch(() => ({}));

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
    const eventName = ttRes.rows[0].event_name as string;
    const startsAt = (ttRes.rows[0].starts_at as string | null | undefined) ?? null;
    const subjectEventName = /\bFV\b/i.test(eventName) ? eventName : `${eventName} FV`;
    const subjectStart = formatSubjectStart(ticketType, startsAt);
    const subjectLine = `Þinn miði á ${subjectEventName}${subjectStart ? ` ${subjectStart}` : ""}`;

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

    // QR should match what the door-scanner expects (ticket UUID).
    // Note: many email clients block/strip `data:` image URLs. We host the QR and also attach it.
    const qrPngBase64 = (await QRCode.toBuffer(ticketId, { type: "png", margin: 1, scale: 8 })).toString(
      "base64"
    );

    const apiKey = process.env.RESEND_API_KEY;
    let emailResult:
      | { ok: true; id?: string }
      | { ok: false; error: string; skipped?: boolean }
      | undefined;

    if (!apiKey) {
      emailResult = { ok: false, error: "RESEND_API_KEY missing", skipped: true };
    } else {
      try {
        const resend = new Resend(apiKey);
        const from = process.env.RESEND_FROM ?? "Tickets <onboarding@resend.dev>";
        const replyTo = (process.env.RESEND_REPLY_TO ?? "").toString().trim();

        const safeName = (name ?? "").toString().trim();
        const greeting = safeName ? `Hæ ${safeName}` : "Hæ";

        const sent = await resend.emails.send({
          from,
          to: email,
          ...(replyTo ? { replyTo } : {}),
          subject: subjectLine,
          html: `
            <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.4">
              <h1 style="margin: 0 0 8px">${subjectLine}</h1>
              <p style="margin: 0 0 12px">${greeting}.</p>

              <p style="margin: 0 0 12px">Miði: <b>${ticketType}</b></p>

              <p style="margin: 0 0 8px">QR kóðinn er í viðhengi. Sýndu hann við inngang.</p>
              <p style="margin: 14px 0 0; font-size: 12px; color: #666">Miða-ID: ${ticketId}</p>
            </div>
          `,
          attachments: [
            {
              filename: `ticket-${ticketId}.png`,
              content: qrPngBase64,
              contentType: "image/png",
            },
          ],
        });

        // resend@6 returns { data, error } and does not necessarily throw on API errors.
        const maybeError = (sent as unknown as { error?: { message?: string } | string | null })?.error;
        if (maybeError) {
          const message =
            typeof maybeError === "string" ? maybeError : maybeError?.message ? maybeError.message : String(maybeError);
          emailResult = { ok: false, error: message };
        } else {
          const id =
            (sent as unknown as { data?: { id?: string } | null })?.data?.id ??
            (sent as unknown as { id?: string })?.id;
          emailResult = { ok: true, id };
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
      email: emailResult,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try { await client.end(); } catch {}
  }
}