"""Razorpay webhook receiver (Vercel serverless function)."""
import json
import os
import time
import hmac
import hashlib
from http.server import BaseHTTPRequestHandler


RECENT_EVENTS = []
MAX_RECENT_EVENTS = 20


def _get_secret():
    return (
        os.getenv("RAZORPAY_WEBHOOK_SECRET")
        or os.getenv("BOOKLEAF_RAZORPAY_WEBHOOK_SECRET")
        or ""
    )


def _append_recent(event):
    RECENT_EVENTS.append(event)
    if len(RECENT_EVENTS) > MAX_RECENT_EVENTS:
        del RECENT_EVENTS[:-MAX_RECENT_EVENTS]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        secret = _get_secret()
        self._send_json(
            200,
            {
                "ok": True,
                "configured": bool(secret),
                "recent": list(reversed(RECENT_EVENTS[-10:])),
            },
        )

    def do_POST(self):
        secret = _get_secret()
        if not secret:
            self._send_json(500, {"error": "RAZORPAY_WEBHOOK_SECRET not configured"})
            return

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(content_length) if content_length else b""

        signature = (self.headers.get("X-Razorpay-Signature") or "").strip()
        if not signature:
            self._send_json(400, {"error": "Missing X-Razorpay-Signature"})
            return

        expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            self._send_json(401, {"error": "Invalid webhook signature"})
            return

        event_name = "unknown"
        payload = None
        if raw_body:
            try:
                payload = json.loads(raw_body.decode("utf-8"))
                event_name = payload.get("event") or "unknown"
            except Exception:
                # Keep accepting the webhook even if body parsing fails; signature already passed.
                payload = None

        _append_recent(
            {
                "receivedAt": int(time.time()),
                "event": event_name,
                "contentLength": len(raw_body),
            }
        )

        # TODO: Persist/process events if/when business logic is finalized.
        self._send_json(200, {"ok": True, "event": event_name})

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Razorpay-Signature")

