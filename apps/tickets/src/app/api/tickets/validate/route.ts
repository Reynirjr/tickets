import { NextResponse } from "next/server";
import { Client } from "pg";
import crypto from "crypto";

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin");
  const allow = process.env.CORS_ALLOW_ORIGIN;

  const h: Record<string, string> = {};
  const base = () => {
    h["Access-Control-Allow-Methods"] = "POST,OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  };

  // If CORS_ALLOW_ORIGIN is unset:
  // - allow any origin in development (helps local scan app)
  // - otherwise allow same-origin only (no CORS headers)
  if (!allow) {
    if (process.env.NODE_ENV === "development") {
      base();
      h["Access-Control-Allow-Origin"] = origin ?? "*";
      h["Vary"] = "Origin";
      return h;
    }
    return h;
  }

  if (allow.trim() === "*") {
    base();
    h["Access-Control-Allow-Origin"] = "*";
    return h;
  }

  const allowed = allow
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isAllowed = !!origin && allowed.includes(origin);
  if (!isAllowed) return h;

  base();
  h["Access-Control-Allow-Origin"] = origin;
  h["Vary"] = "Origin";
  return h;
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export async function POST(req: Request) {
  const { ticketId } = await req.json().catch(() => ({}));

  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim() || null;

  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Missing Authorization Bearer token" },
      { status: 401, headers: corsHeaders(req) }
    );
  }

  if (!ticketId) {
    return NextResponse.json(
      { ok: false, error: "ticketId is required" },
      { status: 400, headers: corsHeaders(req) }
    );
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    const keyRes = await client.query(
      `
      select id, event_id
      from scanner_keys
      where key_hash = $1
        and active = true
        and (expires_at is null or expires_at > now())
      limit 1
      `,
      [tokenHash]
    );

    if (keyRes.rowCount === 0) {
      return NextResponse.json(
        { ok: false, error: "Invalid scanner key" },
        { status: 403, headers: corsHeaders(req) }
      );
    }

    const scannerEventId = keyRes.rows[0].event_id as string;
    const scannerKeyId = keyRes.rows[0].id as string;

    async function loadTicketRow() {
      const info = await client.query(
        `
        select
          t.id,
          t.email,
          t.name,
          t.used,
          t.used_at,
          t.issued_at,
          t.used_by_scanner_key_id,
          tt.name as ticket_type,
          tt.price_isk,
          e.name as event_name,
          e.starts_at,
          e.ends_at,
          e.venue
          , sk.label as scanned_by
        from tickets t
        join ticket_types tt on tt.id = t.ticket_type_id
        join events e on e.id = tt.event_id
        left join scanner_keys sk on sk.id = t.used_by_scanner_key_id
        where t.id = $1
          and tt.event_id = $2
        `,
        [ticketId, scannerEventId]
      );
      return info.rowCount ? info.rows[0] : null;
    }

    // Atomic update: only flip used=false -> true
    const updated = await client.query(
      `
      update tickets t
      set used = true,
          used_at = now(),
          used_by_scanner_key_id = $3
      from ticket_types tt
      where t.id = $1
        and t.used = false
        and t.ticket_type_id = tt.id
        and tt.event_id = $2
      returning t.id
      `,
      [ticketId, scannerEventId, scannerKeyId]
    );

    if (updated.rowCount === 1) {
      const ticket = await loadTicketRow();
      return NextResponse.json(
        { ok: true, status: "VALID", ticket },
        { headers: corsHeaders(req) }
      );
    }

    // Not updated: check why
    const ticket = await loadTicketRow();
    if (!ticket) {
      return NextResponse.json(
        { ok: true, status: "NOT_FOUND" },
        { headers: corsHeaders(req) }
      );
    }

    return NextResponse.json(
      { ok: true, status: "ALREADY_USED", ticket },
      { headers: corsHeaders(req) }
    );
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: corsHeaders(req) }
    );
  } finally {
    try { await client.end(); } catch {}
  }
}