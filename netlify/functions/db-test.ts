import { Client } from "pg";

export const handler = async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "DATABASE_URL missing" }),
      headers: { "content-type": "application/json" },
    };
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Neon þarf SSL
  });

  try {
    await client.connect();
    const res = await client.query("select now() as now");
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, now: res.rows[0].now }),
      headers: { "content-type": "application/json" },
    };
  } catch (e: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
      headers: { "content-type": "application/json" },
    };
  } finally {
    try {
      await client.end();
    } catch {}
  }
};