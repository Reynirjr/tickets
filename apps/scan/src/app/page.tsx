"use client";

import { BrowserMultiFormatReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";

type TicketRow = {
  id: string;
  email: string;
  name?: string | null;
  used: boolean;
  used_at?: string | null;
  issued_at?: string | null;
  ticket_type: string;
  price_isk?: number;
  event_name: string;
  starts_at?: string | null;
  ends_at?: string | null;
  venue?: string | null;
};

type ValidateResponse =
  | { ok: true; status: "VALID"; ticket: TicketRow | null }
  | { ok: true; status: "ALREADY_USED"; ticket: TicketRow | null }
  | { ok: true; status: "NOT_FOUND" }
  | { ok: false; error: string };

type HistoryItem =
  | { at: string; scanned_status: "VALID" | "ALREADY_USED"; ticket: TicketRow | null }
  | { at: string; scanned_status: "NOT_FOUND"; ticketId: string }
  | { at: string; scanned_status: "ERROR"; error: string };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractTicketId(raw: string) {
  const text = raw.trim();
  const m = text.match(UUID_RE);
  return (m?.[0] ?? text).trim();
}

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastSeenRef = useRef<{ value: string; at: number } | null>(null);
  const busyRef = useRef(false);

  const [manualTicketId, setManualTicketId] = useState("");
  const [status, setStatus] = useState<ValidateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const ticketsBaseUrl = process.env.NEXT_PUBLIC_TICKETS_BASE_URL?.replace(/\/$/, "");
  const scannerKey = process.env.NEXT_PUBLIC_SCANNER_KEY;

  async function validateTicket(ticketId: string) {
    const id = ticketId.trim();
    if (!id) return;

    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    try {
      const url = ticketsBaseUrl
        ? `${ticketsBaseUrl}/api/tickets/validate`
        : "/api/tickets/validate";

      if (!scannerKey) {
        throw new Error("NEXT_PUBLIC_SCANNER_KEY is missing");
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${scannerKey}`,
        },
        body: JSON.stringify({ ticketId: id }),
      });

      const data = (await res.json()) as ValidateResponse;
      setStatus(data);

      const at = new Date().toISOString();
      if (data.ok && (data.status === "VALID" || data.status === "ALREADY_USED")) {
        const item: HistoryItem = { at, scanned_status: data.status, ticket: data.ticket };
        setHistory((h) => [item, ...h].slice(0, 25));
      } else if (data.ok && data.status === "NOT_FOUND") {
        const item: HistoryItem = { at, scanned_status: "NOT_FOUND", ticketId: id };
        setHistory((h) => [item, ...h].slice(0, 25));
      } else if (!data.ok) {
        const item: HistoryItem = { at, scanned_status: "ERROR", error: data.error };
        setHistory((h) => [item, ...h].slice(0, 25));
      }

      // Quick feedback, then clear for next scan.
      window.setTimeout(() => setStatus(null), 900);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ ok: false, error: message });
      const at = new Date().toISOString();
      const item: HistoryItem = { at, scanned_status: "ERROR", error: message };
      setHistory((h) => [item, ...h].slice(0, 25));
      window.setTimeout(() => setStatus(null), 1200);
    } finally {
      window.setTimeout(() => {
        busyRef.current = false;
        setBusy(false);
      }, 250);
    }
  }

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;
    let active = true;

    async function start() {
      const video = videoRef.current;
      if (!video) return;

      try {
        controlsRef.current = await reader.decodeFromVideoDevice(undefined, video, (result, err) => {
          if (!active) return;

          if (result) {
            const raw = result.getText();
            const id = extractTicketId(raw);

            const now = Date.now();
            const last = lastSeenRef.current;
            if (last && last.value === id && now - last.at < 1500) return;
            lastSeenRef.current = { value: id, at: now };

            void validateTicket(id);
          }

          if (err) {
            // "NotFoundException" effectively means "no QR in frame"; ignore.
            const name = (err as { name?: unknown } | null)?.name;
            if (name !== "NotFoundException") {
              // Other errors can happen occasionally; keep scanning.
              console.warn(err);
            }
          }
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        setStatus({ ok: false, error: `Could not access camera: ${message}` });
      }
    }

    void start();

    return () => {
      active = false;
      try {
        controlsRef.current?.stop();
      } catch {}
      controlsRef.current = null;
      readerRef.current = null;
    };
  }, []);

  const banner = (() => {
    if (!status) return null;
    if (!status.ok) return { kind: "bad" as const, title: status.error };
    if (status.status === "VALID") return { kind: "good" as const, title: "Valid ticket" };
    if (status.status === "ALREADY_USED") return { kind: "warn" as const, title: "Already used" };
    return { kind: "bad" as const, title: "Not found" };
  })();

  return (
    <main style={{ padding: 16, fontFamily: "system-ui", maxWidth: 520, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Scan</h1>

      <div style={{ borderRadius: 14, overflow: "hidden", border: "1px solid #ddd" }}>
        <video ref={videoRef} style={{ width: "100%", height: "auto" }} muted playsInline />
      </div>

      {banner && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #ddd",
            backgroundColor:
              banner.kind === "good" ? "#eaffea" : banner.kind === "warn" ? "#fff7e6" : "#ffecec",
          }}
        >
          <div style={{ fontWeight: 800 }}>
            {banner.kind === "good" ? "✅" : banner.kind === "warn" ? "🟠" : "❌"} {banner.title}
          </div>

          {status?.ok &&
            (status.status === "VALID" || status.status === "ALREADY_USED") &&
            status.ticket && (
              <div style={{ marginTop: 6, opacity: 0.9 }}>
                <div>
                  <b>{status.ticket.name ?? "—"}</b> · {status.ticket.ticket_type}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{status.ticket.email}</div>
              </div>
            )}
        </div>
      )}

      <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
        <input
          value={manualTicketId}
          onChange={(e) => setManualTicketId(e.target.value)}
          placeholder="Manual ticket ID (fallback)"
          style={{ flex: 1, padding: 12, fontSize: 16 }}
        />
        <button
          onClick={() => void validateTicket(extractTicketId(manualTicketId))}
          disabled={busy}
          style={{ padding: 12, minWidth: 110 }}
        >
          {busy ? "…" : "Check"}
        </button>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 10 }}>Recent</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {history.map((item, idx) => {
          if (item.scanned_status === "ERROR") {
            return (
              <div
                key={`err-${idx}-${item.at}`}
                style={{ border: "1px solid #ddd", borderRadius: 12, padding: 10 }}
              >
                <div style={{ fontWeight: 700 }}>❌ Error</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{item.error}</div>
              </div>
            );
          }

          if (item.scanned_status === "NOT_FOUND") {
            return (
              <div
                key={`nf-${idx}-${item.at}`}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 12,
                  padding: 10,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{item.ticketId}</div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(item.at).toLocaleString()}</div>
                </div>
                <div style={{ fontWeight: 800 }}>❌</div>
              </div>
            );
          }

          const t = item.ticket;
          return (
            <div
              key={`${t?.id ?? "unknown"}-${idx}-${item.at}`}
              style={{
                border: "1px solid #ddd",
                borderRadius: 12,
                padding: 10,
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t?.name ?? "—"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {t?.ticket_type ?? ""}
                  {t?.email ? ` · ${t.email}` : ""}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(item.at).toLocaleString()}</div>
              </div>

              <div style={{ fontWeight: 900 }}>
                {item.scanned_status === "VALID" ? "✅" : "🟠"}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}