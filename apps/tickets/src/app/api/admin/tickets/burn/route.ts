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

function normalizeTicketIds(input: unknown): string[] {
  const ids: string[] = [];
  if (typeof input === "string") ids.push(input);
  if (Array.isArray(input)) {
    for (const v of input) {
      if (typeof v === "string") ids.push(v);
    }
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return Array.from(new Set(ids.map((s) => s.trim()).filter((s) => uuid.test(s))));
}

export async function POST(req: Request) {
  const auth = requireAdminAuth(req);
  if (!auth.ok) return auth.res;

  const { ticketId, ticketIds } = await req.json().catch(() => ({}));
  const ids = normalizeTicketIds(ticketIds ?? ticketId);
  if (ids.length === 0) {
    return NextResponse.json(
      { ok: false, error: "ticketId or ticketIds (UUID) is required" },
      { status: 400 }
    );
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const res = await client.query(
      `
      update tickets
      set used = true,
          used_at = now(),
          used_by_scanner_key_id = null
      where id = any($1::uuid[])
      returning id, used
      `,
      [ids]
    );

    return NextResponse.json({ ok: true, burned: res.rowCount, rows: res.rows }, { status: 200 });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    try {
      await client.end();
    } catch {}
  }
}
