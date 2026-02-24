import { headers } from "next/headers";

type AttendanceRow = {
  used_at: string;
  ticket_id: string;
  name: string | null;
  email: string;
  ticket_type: string;
  event_name: string;
  scanned_by?: string | null;
};

type AttendanceApiResponse =
  | { ok: true; rows: AttendanceRow[] }
  | { ok: false; error: string };

async function baseUrl() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (process.env.NODE_ENV === "development" ? "http" : "https");
  if (!host) throw new Error("Missing host header");
  return `${proto}://${host}`;
}

async function getAttendance(eventId?: string) {
  const origin = await baseUrl();
  const qs = new URLSearchParams();
  if (eventId) qs.set("eventId", eventId);
  qs.set("limit", "500");

  const res = await fetch(`${origin}/api/admin/attendance?${qs.toString()}`, { cache: "no-store" });
  return (await res.json()) as AttendanceApiResponse;
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams?: { eventId?: string };
}) {
  const eventId = searchParams?.eventId;
  const data = await getAttendance(eventId);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Attendance</h1>

      <div style={{ marginBottom: 14, opacity: 0.8 }}>
        {eventId ? (
          <span>Event: {eventId}</span>
        ) : (
          <span>All events (add ?eventId=... to filter)</span>
        )}
      </div>

      <div style={{ marginBottom: 18 }}>
        <a
          href={`/api/admin/attendance?${new URLSearchParams({
            ...(eventId ? { eventId } : {}),
            format: "csv",
            limit: "2000",
          }).toString()}`}
        >
          Download CSV
        </a>
      </div>

      {!data.ok ? (
        <div style={{ color: "crimson" }}>{data.error}</div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Time</th>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Name</th>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Email</th>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Type</th>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Event</th>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Scanned by</th>
                <th style={{ padding: 10, borderBottom: "1px solid #ddd" }}>Ticket</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.ticket_id}>
                  <td style={{ padding: 10, borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                    {r.used_at ? new Date(r.used_at).toLocaleString() : "—"}
                  </td>
                  <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.name ?? "—"}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.email}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.ticket_type}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.event_name}</td>
                  <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{r.scanned_by ?? "—"}</td>
                  <td
                    style={{
                      padding: 10,
                      borderBottom: "1px solid #eee",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: 12,
                    }}
                  >
                    {r.ticket_id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
