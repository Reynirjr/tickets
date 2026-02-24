import { NextResponse } from "next/server";
import { Client } from "pg";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const eventId = url.searchParams.get("eventId");

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const res = await client.query(
      `
      select
        tt.id,
        tt.event_id,
        tt.name,
        tt.price_isk,
        e.name as event_name,
        e.starts_at,
        e.ends_at,
        e.venue
      from ticket_types tt
      join events e on e.id = tt.event_id
      ${eventId ? "where tt.event_id = $1" : ""}
      order by e.starts_at desc nulls last, tt.price_isk asc, tt.name asc
      `,
      eventId ? [eventId] : []
    );

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
