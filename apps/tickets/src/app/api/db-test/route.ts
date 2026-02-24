import { NextResponse } from "next/server";
import { Client } from "pg";

export async function GET() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL missing" }, { status: 500 });
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const res = await client.query("select now() as now");
    return NextResponse.json({ ok: true, now: res.rows[0].now });
  } catch (e: unknown) {
    const errorMessage =
      e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 });
  } finally {
    try { await client.end(); } catch {}
  }
}