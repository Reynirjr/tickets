import { NextResponse } from "next/server";
import { Client } from "pg";

export const runtime = "nodejs";

function requireAdminAuth(req: Request): { ok: true } | { ok: false; res: NextResponse } {
  const requiredKey = (process.env.ADMIN_API_KEY ?? process.env.ISSUE_API_KEY ?? "").trim();
  if (!requiredKey) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: "Admin auth not configured" }, { status: 500 }),
    };
  }

  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() || "";
  if (!token || token !== requiredKey) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}

export async function POST(req: Request) {
  const auth = requireAdminAuth(req);
  if (!auth.ok) return auth.res;

  const { email, limit } = await req.json().catch(() => ({}));
  const emailTrimmed = String(email ?? "").trim();
  const limitParsed = Number(limit ?? 50);
  const safeLimit = Number.isFinite(limitParsed) ? Math.min(Math.max(1, limitParsed), 500) : 50;

  if (!emailTrimmed) {
    return NextResponse.json({ ok: false, error: "email is required" }, { status: 400 });
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
        e.name as event_name,
        e.starts_at
      from tickets t
      join ticket_types tt on tt.id = t.ticket_type_id
      join events e on e.id = tt.event_id
      where lower(t.email) = lower($1)
      order by t.issued_at desc
      limit ${safeLimit}
      `,
      [emailTrimmed]
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
