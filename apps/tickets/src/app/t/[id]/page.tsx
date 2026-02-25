import Image from "next/image";
import QRCode from "qrcode";
import { headers } from "next/headers";

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
  const origin = await baseUrl();
  const res = await fetch(`${origin}/api/tickets/get?id=${id}`, {
    cache: "no-store",
  });
  return res.json();
}

export default async function TicketPage({ params }: { params: { id: string } }) {
  const raw = params.id;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // If the URL is malformed, fall back to the raw value.
    id = raw;
  }
  id = id.trim();
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
      <div style={{ opacity: 0.8, marginBottom: 18 }}>
        {t.ticket_type} · {t.price_isk} ISK
      </div>

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
          <div>Starts: {t.starts_at ? new Date(t.starts_at).toLocaleString() : "—"}</div>
          <div>Venue: {t.venue ?? "—"}</div>

          <div style={{ marginTop: 18, fontSize: 12, opacity: 0.7 }}>
            Link: {ticketUrl}
          </div>
        </div>
      </div>
    </main>
  );
}