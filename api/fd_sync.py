"""Freshdesk background sync endpoint (for Vercel Cron or admin manual trigger)."""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

try:
    from api.fd_sync_lib import (
        FreshdeskHttpError,
        cache_store_kind,
        build_cache_payload,
        blob_available,
        get_admin_password,
        get_cron_secret,
        get_freshdesk_api_key,
        kv_available,
        kv_native_available,
        load_fd_cache,
        save_fd_cache,
    )
except ImportError:
    from fd_sync_lib import (  # type: ignore
        FreshdeskHttpError,
        cache_store_kind,
        build_cache_payload,
        blob_available,
        get_admin_password,
        get_cron_secret,
        get_freshdesk_api_key,
        kv_available,
        kv_native_available,
        load_fd_cache,
        save_fd_cache,
    )


def _authorized(handler: BaseHTTPRequestHandler) -> bool:
    cron_secret = get_cron_secret()
    auth_header = (handler.headers.get("Authorization") or "").strip()
    if cron_secret and auth_header == f"Bearer {cron_secret}":
        return True
    try:
        parsed = urlparse(handler.path)
        query = parse_qs(parsed.query)
        token = (query.get("token", [""])[0] or "").strip()
        if cron_secret and token and token == cron_secret:
            return True
    except Exception:
        pass
    supplied_admin = (handler.headers.get("x-admin-password") or "").strip()
    if supplied_admin and supplied_admin == get_admin_password():
        return True
    # If no cron secret configured, allow manual GET so setup can be completed incrementally.
    return not cron_secret


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._run_sync()

    def do_POST(self):
        self._run_sync()

    def _run_sync(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if self.command == "GET" and str(query.get("status", [""])[0]).strip().lower() in {"1", "true", "yes"}:
            self._send_status()
            return

        if not _authorized(self):
            self._send_json(401, {"error": "Unauthorized"})
            return

        if not kv_available():
            self._send_json(
                503,
                {
                    "error": "Cache store not configured",
                    "requiredEnvAnyOf": [
                        ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
                        ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
                        ["BLOB_READ_WRITE_TOKEN"],
                    ],
                },
            )
            return

        try:
            max_pages = int((query.get("maxPages", ["3"])[0] or "3").strip())
        except Exception:
            max_pages = 3
        max_pages = max(1, min(max_pages, 10))

        try:
            payload = build_cache_payload(max_pages=max_pages)
            save_fd_cache(payload)
            self._send_json(
                200,
                {
                    "ok": True,
                    "ticketCount": payload.get("ticketCount", 0),
                    "fetchedAt": payload.get("fetchedAt"),
                    "meta": payload.get("meta", {}),
                    "agentMapCount": payload.get("agentMapCount", 0),
                },
            )
        except FreshdeskHttpError as exc:
            body = {"error": f"Freshdesk API error {exc.status}", "detail": exc.detail[:600]}
            if exc.retry_after:
                body["retryAfter"] = exc.retry_after
            self._send_json(exc.status, body)
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _send_status(self):
        cache_exists = False
        cache_fetched_at = None
        cache_ticket_count = None
        cache_error = None
        if kv_available():
            try:
                cached = load_fd_cache()
                if cached:
                    cache_exists = True
                    cache_fetched_at = cached.get("fetchedAt")
                    cache_ticket_count = cached.get("ticketCount")
            except Exception as exc:
                cache_error = str(exc)
        self._send_json(
            200,
            {
                "ok": True,
                "mode": "status",
                "freshdeskConfigured": bool(get_freshdesk_api_key()),
                "kvConfigured": kv_native_available(),
                "blobConfigured": blob_available(),
                "cacheStore": cache_store_kind(),
                "cacheStoreConfigured": kv_available(),
                "cronSecretConfigured": bool(get_cron_secret()),
                "defaultVercelCronSchedule": "*/10 * * * *",
                "cacheExists": cache_exists,
                "cacheFetchedAt": cache_fetched_at,
                "cacheTicketCount": cache_ticket_count,
                "cacheError": cache_error,
            },
        )

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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-password")
