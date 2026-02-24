"""Freshdesk webhook endpoint — receives real-time ticket events and updates the cache."""
import json
import os
from http.server import BaseHTTPRequestHandler

try:
    from api.fd_sync_lib import (
        kv_available,
        load_fd_cache,
        save_fd_cache,
        normalize_tickets,
        get_freshdesk_api_key,
        CONSULTANTS,
        FD_STATUS,
    )
except ImportError:
    from fd_sync_lib import (  # type: ignore
        kv_available,
        load_fd_cache,
        save_fd_cache,
        normalize_tickets,
        get_freshdesk_api_key,
        CONSULTANTS,
        FD_STATUS,
    )


def _utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _get_webhook_secret() -> str:
    return (os.getenv("FRESHDESK_WEBHOOK_SECRET") or os.getenv("FD_WEBHOOK_SECRET") or "").strip()


def _verify_token(handler) -> bool:
    """Verify the webhook request using a shared secret token (query param or header)."""
    secret = _get_webhook_secret()
    if not secret:
        # No secret configured — accept all requests (for easy initial setup).
        return True
    # Check query param ?token=...
    from urllib.parse import parse_qs, urlparse
    parsed = urlparse(handler.path)
    query = parse_qs(parsed.query)
    token = (query.get("token", [""])[0] or "").strip()
    if token and token == secret:
        return True
    # Check header
    header_token = (handler.headers.get("x-webhook-secret") or "").strip()
    if header_token and header_token == secret:
        return True
    return False


def _merge_ticket_into_cache(ticket_data: dict) -> dict:
    """Merge a single ticket update into the existing cache. Returns the updated cache payload."""
    cache = load_fd_cache()
    if not cache:
        # No cache yet — create a minimal one with just this ticket.
        cache = {
            "ok": True,
            "source": "freshdesk-webhook",
            "domain": "bookleafpublishing.freshdesk.com",
            "fetchedAt": _utc_now_iso(),
            "ticketCount": 0,
            "agentMapCount": 0,
            "meta": {"source": "webhook"},
            "tickets": [],
        }

    tickets = cache.get("tickets") or []
    ticket_id = ticket_data.get("id")

    # Normalize the incoming ticket using the same pipeline as cron sync.
    # The webhook payload from Freshdesk has the ticket data directly.
    normalized = normalize_tickets([ticket_data], _build_agent_map_from_cache(cache))
    if not normalized:
        return cache

    new_ticket = normalized[0]

    # Find and replace existing ticket, or append.
    found = False
    for i, t in enumerate(tickets):
        if t.get("id") == ticket_id:
            tickets[i] = new_ticket
            found = True
            break
    if not found:
        tickets.insert(0, new_ticket)  # newest first

    cache["tickets"] = tickets
    cache["ticketCount"] = len(tickets)
    cache["fetchedAt"] = _utc_now_iso()
    cache["meta"] = cache.get("meta") or {}
    cache["meta"]["lastWebhookAt"] = _utc_now_iso()

    return cache


def _build_agent_map_from_cache(cache: dict) -> dict:
    """Build a minimal agent map from cached tickets (to avoid extra API calls)."""
    # We don't have agent IDs in the webhook payload, so return empty.
    # The cron sync will fill these in on its next run.
    return {}


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        """Health check / info endpoint."""
        secret_configured = bool(_get_webhook_secret())
        cache_available = kv_available()
        self._send_json(200, {
            "ok": True,
            "endpoint": "freshdesk-webhook",
            "secretConfigured": secret_configured,
            "cacheStoreAvailable": cache_available,
            "usage": "POST ticket data from Freshdesk automation rules to this endpoint.",
        })

    def do_POST(self):
        if not _verify_token(self):
            self._send_json(401, {"error": "Invalid or missing webhook secret"})
            return

        if not kv_available():
            self._send_json(503, {"error": "Cache store not configured"})
            return

        # Read the POST body.
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._send_json(400, {"error": "Empty request body"})
            return

        raw = self.rfile.read(content_length)
        try:
            body = json.loads(raw.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(400, {"error": f"Invalid JSON: {exc}"})
            return

        # Freshdesk webhook payload structure:
        # The automation rule sends the ticket data. It could be:
        # 1. Direct ticket object: { "id": 123, "subject": "...", ... }
        # 2. Wrapped: { "freshdesk_webhook": { "ticket_id": 123, ... } }
        # 3. Custom payload with ticket fields
        ticket_data = None

        if "freshdesk_webhook" in body:
            # Wrapped format from Freshdesk automations
            fw = body["freshdesk_webhook"]
            ticket_data = {
                "id": fw.get("ticket_id") or fw.get("id"),
                "subject": fw.get("ticket_subject") or fw.get("subject") or "(No subject)",
                "status": _parse_status_code(fw.get("ticket_status") or fw.get("status")),
                "requester": {"email": fw.get("ticket_requester_email") or fw.get("requester_email") or ""},
                "responder_id": fw.get("ticket_agent_id") or fw.get("responder_id"),
                "created_at": fw.get("ticket_created_at") or fw.get("created_at"),
                "updated_at": fw.get("ticket_updated_at") or fw.get("updated_at") or _utc_now_iso(),
            }
        elif body.get("id") and (body.get("subject") or body.get("status")):
            # Direct ticket object
            ticket_data = body
        else:
            # Try to extract what we can
            ticket_id = body.get("ticket_id") or body.get("id")
            if ticket_id:
                ticket_data = {
                    "id": ticket_id,
                    "subject": body.get("ticket_subject") or body.get("subject") or "(No subject)",
                    "status": _parse_status_code(body.get("ticket_status") or body.get("status")),
                    "requester": {"email": body.get("ticket_requester_email") or body.get("requester_email") or body.get("email") or ""},
                    "responder_id": body.get("ticket_agent_id") or body.get("responder_id"),
                    "created_at": body.get("created_at"),
                    "updated_at": body.get("updated_at") or _utc_now_iso(),
                }

        if not ticket_data or not ticket_data.get("id"):
            self._send_json(400, {"error": "Could not extract ticket data from payload", "received_keys": list(body.keys())})
            return

        try:
            updated_cache = _merge_ticket_into_cache(ticket_data)
            save_fd_cache(updated_cache)
            self._send_json(200, {
                "ok": True,
                "ticketId": ticket_data["id"],
                "action": "merged",
                "totalCachedTickets": updated_cache.get("ticketCount", 0),
                "updatedAt": updated_cache.get("fetchedAt"),
            })
        except Exception as exc:
            self._send_json(500, {"error": f"Cache update failed: {exc}"})

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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret")


def _parse_status_code(val) -> int:
    """Convert Freshdesk status string/int to numeric code."""
    if isinstance(val, int):
        return val
    if isinstance(val, str):
        # Freshdesk sends status names in webhook payloads
        status_map = {"open": 2, "pending": 3, "resolved": 4, "closed": 5}
        lower = val.strip().lower()
        if lower in status_map:
            return status_map[lower]
        try:
            return int(val)
        except ValueError:
            pass
    return 0
