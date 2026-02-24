import { NextResponse } from "next/server";
import { Client } from "pg";

function toCsv(rows: Array<Record<string, unknown>>) {
  const headers = ["used_at", "ticket_id", "name", "email", "ticket_type", "event_name", "scanned_by"]; 
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    if (/[\n\r\",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      headers
        .map((h) => escape(r[h]))
        .join(",")
    );
  }
  return lines.join("\n");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const eventId = url.searchParams.get("eventId");
  const format = url.searchParams.get("format");

  const limitRaw = url.searchParams.get("limit");
  const limitParsed = limitRaw ? Number(limitRaw) : 200;
  const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(1, limitParsed), 2000) : 200;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const baseSql = `
      select
        t.used_at,
        t.id as ticket_id,
        t.name,
        t.email,
        tt.name as ticket_type,
          e.name as event_name,
          sk.label as scanned_by
      from tickets t
      join ticket_types tt on tt.id = t.ticket_type_id
      join events e on e.id = tt.event_id
        left join scanner_keys sk on sk.id = t.used_by_scanner_key_id
      where t.used = true
      ${eventId ? "and e.id = $1" : ""}
      order by t.used_at desc
      limit ${limit}
    `;

    const res = await client.query(baseSql, eventId ? [eventId] : []);

    if (format === "csv") {
      const csv = toCsv(res.rows as Array<Record<string, unknown>>);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=attendance.csv",
        },
      });
    }

    return NextResponse.json({ ok: true, rows: res.rows }, { status: 200 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {}
  }
}
