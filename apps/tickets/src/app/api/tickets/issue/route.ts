import { NextResponse } from "next/server";
import { Client } from "pg";
import { Resend } from "resend";
import QRCode from "qrcode";

export const runtime = "nodejs";

export async function POST(req: Request) {
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

    const qrUrl = `${publicBase}/api/tickets/qr?id=${ticketId}`;

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
        const sent = await resend.emails.send({
          from: "Tickets <onboarding@resend.dev>",
          to: email,
          subject: "Your ticket 🎟️",
          html: `
            <h1>Your ticket</h1>
            <p>Hi ${name ?? ""}</p>
            <p>Show this QR at the door (you may need to “Display images” in your email client):</p>
            <p><img src="${qrUrl}" alt="QR code" width="280" height="280" /></p>
            <p>Or open the link:</p>
            <p><a href="${ticketUrl}">${ticketUrl}</a></p>
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