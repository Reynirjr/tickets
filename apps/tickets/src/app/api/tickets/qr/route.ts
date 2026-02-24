import QRCode from "qrcode";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return new Response("Missing query param: id", { status: 400 });
  }

  if (!isUuid(id)) {
    return new Response("Invalid id (expected UUID)", { status: 400 });
  }

  const png = await QRCode.toBuffer(id, { type: "png", margin: 1, scale: 8 });
  const body = new Uint8Array(png);

  return new Response(body, {
    headers: {
      "Content-Type": "image/png",
      // Cache is safe because ticket IDs are immutable, but keep it short in case you ever rotate formats.
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
