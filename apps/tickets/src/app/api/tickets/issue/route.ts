import { NextResponse } from "next/server";
import { Client } from "pg";
import { Resend } from "resend";
import QRCode from "qrcode";

export const runtime = "nodejs";

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
        e.name as event_name
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
    const priceIsk = ttRes.rows[0].price_isk as number;
    const eventName = ttRes.rows[0].event_name as string;
    const subjectEventName = /\bFV\b/i.test(eventName) ? eventName : `${eventName} FV`;

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

        const safeName = (name ?? "").toString().trim();
        const greeting = safeName ? `Hæ ${safeName}` : "Hæ";

        const sent = await resend.emails.send({
          from,
          to: email,
          subject: `Þinn miði á ${subjectEventName}`,
          html: `
            <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height: 1.4">
              <h1 style="margin: 0 0 8px">Þinn miði á ${subjectEventName}</h1>
              <p style="margin: 0 0 12px">${greeting}.</p>

              <p style="margin: 0 0 12px">Miði: <b>${ticketType}</b></p>

              <p style="margin: 0 0 8px">QR kóðinn er í viðhengi. Sýndu hann við inngang.</p>
              <p style="margin: 0 0 12px; font-size: 14px; color: #444">
                Viðhengi: <b>ticket-${ticketId}.png</b>
              </p>

              <p style="margin: 12px 0 0">Tengill á miðann: <a href="${ticketUrl}">${ticketUrl}</a></p>

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

        // Resend returns an object that includes an id on success.
        emailResult = { ok: true, id: (sent as unknown as { id?: string })?.id };
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
      email: emailResult,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try { await client.end(); } catch {}
  }
}