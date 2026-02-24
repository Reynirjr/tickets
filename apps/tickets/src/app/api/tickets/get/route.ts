import { NextResponse } from "next/server";
import { Client } from "pg";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing query param: id" }, { status: 400 });
  }

  // Prevent accidental queries like id="undefined" and ensure Postgres UUID casts won't throw.
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidRegex.test(id)) {
    return NextResponse.json({ ok: false, error: "Invalid id (expected UUID)" }, { status: 400 });
  }

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
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, ticket: res.rows[0] });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {}
  }
}
