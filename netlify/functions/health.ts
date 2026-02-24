export const handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, service: "tickets-api" }),
    headers: { "content-type": "application/json" },
  };
};