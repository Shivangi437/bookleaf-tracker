"""Cached Freshdesk tickets API (reads cron-synced snapshot from KV)."""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

try:
    from api.fd_sync_lib import (VALID_VIEWS, get_admin_password, kv_available, load_fd_cache)
except ImportError:
    from fd_sync_lib import (  # type: ignore
        VALID_VIEWS,
        get_admin_password,
        kv_available,
        load_fd_cache,
    )


def _filter_tickets_for_view(tickets, view):
    if view == "admin":
        return tickets
    return [t for t in (tickets or []) if t.get("matchedConsultant") == view]


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        view = (query.get("view", ["admin"])[0] or "admin").strip()

        if view not in VALID_VIEWS:
            self._send_json(400, {"error": "Invalid view"})
            return

        if not kv_available():
            self._send_json(
                503,
                {
                    "error": "Cache store not configured",
                    "configured": False,
                    "store": "none",
                    "supportedStores": ["upstash-rest", "vercel-blob"],
                },
            )
            return

        if view == "admin":
            supplied = (self.headers.get("x-admin-password") or "").strip()
            if supplied != get_admin_password():
                self._send_json(401, {"error": "Invalid admin password"})
                return

        try:
            payload = load_fd_cache()
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return

        if not payload:
            self._send_json(404, {"error": "No cached Freshdesk snapshot yet"})
            return

        tickets = payload.get("tickets") or []
        filtered = _filter_tickets_for_view(tickets, view)
        response = {
            "ok": True,
            "scope": "admin" if view == "admin" else "consultant",
            "view": view,
            "fetchedAt": payload.get("fetchedAt"),
            "ticketCount": len(filtered),
            "totalCachedTickets": payload.get("ticketCount", len(tickets)),
            "meta": payload.get("meta", {}),
            "tickets": filtered,
        }
        self._send_json(200, response)

    def _send_json(self, status, body):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-admin-password")
