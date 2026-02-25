import Image from "next/image";
import QRCode from "qrcode";
import { headers } from "next/headers";
import { Client } from "pg";

export const runtime = "nodejs";

type Ticket = {
  event_name: string;
  ticket_type: string;
  price_isk: number;
  name?: string | null;
  email: string;
  used: boolean;
  used_at?: string | null;
  starts_at?: string | null;
  venue?: string | null;
};

type TicketApiResponse =
  | { ok: true; ticket: Ticket }
  | { ok: false; error: string };

function formatStartsAt(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Atlantic/Reykjavik",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = get("day");
  const month = get("month");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");

  if (!day || !month || !year || !hour || !minute) return "—";
  const d1 = String(Number(day));
  const m1 = String(Number(month));
  return `${hour}:${minute} ${d1}/${m1}/${year}`;
}

function extractUuid(raw: string): string | null {
  let s = String(raw ?? "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // ignore
  }

  // Normalize and clean up common character substitutions from copy/paste or rich text.
  // - NFKC fixes some “look-alike” characters
  // - Some clients replace '-' with other dash/minus characters
  // - Trim/strip whitespace
  try {
    s = s.normalize("NFKC");
  } catch {
    // ignore
  }
  s = s.replace(/[\s\u00A0]+/g, "");
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");

  // Remove common invisible characters that email clients sometimes inject.
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");

  const m = s.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  );
  return m ? m[0].toLowerCase() : null;
}

async function baseUrl() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (process.env.NODE_ENV === "development" ? "http" : "https");

  if (!host) {
    throw new Error("Missing host header");
  }

  return `${proto}://${host}`;
}

async function getTicket(id: string): Promise<TicketApiResponse> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const res = await client.query(
      `
      select
        t.id,
        t.email,
        t.name,
        t.used,
        t.used_at,
        t.issued_at,
        tt.name as ticket_type,
        tt.price_isk,
        e.name as event_name,
        e.starts_at,
        e.ends_at,
        e.venue
      from tickets t
      join ticket_types tt on tt.id = t.ticket_type_id
      join events e on e.id = tt.event_id
      where t.id = $1
      limit 1
      `,
      [id]
    );

    if (res.rowCount === 0) {
      return { ok: false, error: "NOT_FOUND" };
    }

    return { ok: true, ticket: res.rows[0] };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  } finally {
    try {
      await client.end();
    } catch {}
  }
}

export default async function TicketPage({
  params,
}: {
  params: { id?: string } | Promise<{ id?: string }>;
}) {
  const resolvedParams = await Promise.resolve(params);
  const raw = typeof resolvedParams?.id === "string" ? resolvedParams.id : "";
  const id = extractUuid(raw);

  if (!id) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Ticket not found</h1>
        <p>Invalid id (expected UUID)</p>
      </main>
    );
  }
  const data = await getTicket(id);

  if (!data.ok) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Ticket not found</h1>
        <p>{data.error}</p>
      </main>
    );
  }

  const t = data.ticket;
  const publicBase = process.env.TICKETS_PUBLIC_BASE_URL ?? (await baseUrl());
  const ticketUrl = `${publicBase}/t/${id}`;

  const qr = await QRCode.toDataURL(id, { margin: 1, scale: 8 });

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>{t.event_name}</h1>
      <div style={{ opacity: 0.8, marginBottom: 18 }}>{t.ticket_type}</div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          {/* QR */}
          <Image src={qr} alt="QR" width={280} height={280} unoptimized />
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8, wordBreak: "break-all" }}>
            Ticket ID: {id}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <h3 style={{ marginTop: 0 }}>Owner</h3>
          <div>{t.name ?? "—"}</div>
          <div style={{ opacity: 0.8 }}>{t.email}</div>

          <h3>Status</h3>
          {t.used ? (
            <div style={{ color: "crimson" }}>
              Used {t.used_at ? `at ${new Date(t.used_at).toLocaleString()}` : ""}
            </div>
          ) : (
            <div style={{ color: "green" }}>Valid</div>
          )}

          <h3>Details</h3>
          <div>Starts: {formatStartsAt(t.starts_at)}</div>
          <div>Venue: {t.venue ?? "—"}</div>

          <div style={{ marginTop: 18, fontSize: 12, opacity: 0.7 }}>
            Link: {ticketUrl}
          </div>
        </div>
      </div>
    </main>
  );
}