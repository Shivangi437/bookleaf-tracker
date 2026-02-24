"""Shared Freshdesk background sync helpers (Freshdesk + KV store)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Tuple


FD_DOMAIN = "bookleafpublishing.freshdesk.com"
FD_STATUS = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed"}
FD_CACHE_KEY = "bookleaf:fd_cache:v1"
FD_CACHE_TTL_SECONDS = 60 * 60 * 24 * 2  # 48h
DATA_DIR = Path(__file__).resolve().parent / "_data"
AUTHORS_PATH = DATA_DIR / "authors.json"

CONSULTANTS = [
    {"name": "Vandana", "email": "vandana@bookleafpub.in"},
    {"name": "Sapna", "email": "sapna@bookleafpub.in"},
    {"name": "Tannu", "email": "tannu@bookleafpub.in"},
    {"name": "Roosha", "email": "roosha@bookleafpub.in"},
    {"name": "Firdaus", "email": ""},
]

VALID_VIEWS = {"admin", "Vandana", "Sapna", "Tannu", "Roosha", "Firdaus"}


def get_env(*names: str) -> str:
    for name in names:
        val = os.getenv(name)
        if val:
            return val
    return ""


def get_admin_password() -> str:
    return get_env("BOOKLEAF_TRACKER_ADMIN_PASSWORD", "ADMIN_PASSWORD") or "bookleaf2025"


def get_freshdesk_api_key() -> str:
    return get_env("FRESHDESK_API_KEY", "BOOKLEAF_FRESHDESK_API_KEY", "FRESHDESK_KEY")


def get_cron_secret() -> str:
    return get_env("CRON_SECRET", "VERCEL_CRON_SECRET")


def get_blob_cache_path() -> str:
    # Blob store is public in this project. Use a deterministic secret-derived path to avoid guessable URLs.
    seed = f"{get_cron_secret()}|{get_admin_password()}|{FD_DOMAIN}|fd-cache-v1"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:20]
    return f"bookleaf/freshdesk/fd-cache-{digest}.json"


def _basic_auth_header_from_key(key: str) -> str:
    token = base64.b64encode(f"{key}:X".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def freshdesk_headers() -> Dict[str, str]:
    key = get_freshdesk_api_key()
    if not key:
        raise RuntimeError("FRESHDESK_API_KEY not configured")
    return {
        "Authorization": _basic_auth_header_from_key(key),
        "Content-Type": "application/json",
    }


def freshdesk_url(path: str) -> str:
    return f"https://{FD_DOMAIN}/api/v2/{path}"


def http_json(url: str, headers=None, method="GET", body=None):
    req = urllib.request.Request(url, headers=headers or {}, method=method, data=body)
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
        text = raw.decode("utf-8", errors="replace") if raw else ""
        return resp.status, resp.headers, (json.loads(text) if text else None)


def _load_authors_seed() -> List[dict]:
    with AUTHORS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def _authors_by_email() -> Dict[str, dict]:
    authors = _load_authors_seed()
    by_email = {}
    for a in authors:
        email = (a.get("e") or "").strip().lower()
        if not email:
            continue
        by_email[email] = {
            "name": a.get("n"),
            "consultant": a.get("c"),
        }
    return by_email


def _consultant_agent_map() -> Dict[str, int]:
    try:
        _status, _headers, agents = http_json(
            freshdesk_url("agents?per_page=100"), headers=freshdesk_headers()
        )
    except Exception:
        return {}

    email_to_consultant = {
        (c.get("email") or "").strip().lower(): c["name"]
        for c in CONSULTANTS
        if (c.get("email") or "").strip()
    }
    agent_map = {}
    for agent in agents or []:
        contact = agent.get("contact") or {}
        email = (contact.get("email") or "").strip().lower()
        name = email_to_consultant.get(email)
        if name and agent.get("id") is not None:
            agent_map[name] = agent["id"]
    return agent_map


def fetch_freshdesk_tickets(max_pages: int = 3) -> Tuple[List[dict], Dict[str, int], Dict[str, int]]:
    headers = freshdesk_headers()
    all_tickets = []
    pages_fetched = 0
    page = 1
    has_more = True
    while has_more and page <= max_pages:
        url = freshdesk_url(
            f"tickets?per_page=100&page={page}&include=requester&order_by=created_at&order_type=desc"
        )
        try:
            status, resp_headers, data = http_json(url, headers=headers)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise FreshdeskHttpError(exc.code, body, retry_after=retry_after_seconds(exc.headers))
        pages_fetched += 1
        batch = data or []
        all_tickets.extend(batch)
        has_more = len(batch) == 100
        page += 1
        _ = status, resp_headers  # keep names for symmetry/readability
    agent_map = _consultant_agent_map()
    meta = {"pagesFetched": pages_fetched, "maxPages": max_pages}
    return all_tickets, agent_map, meta


def normalize_tickets(raw_tickets: List[dict], agent_map: Dict[str, int]) -> List[dict]:
    authors = _authors_by_email()
    normalized = []
    for t in raw_tickets or []:
        requester = t.get("requester") if isinstance(t.get("requester"), dict) else {}
        email = ((requester.get("email") if requester else None) or t.get("email") or "").strip().lower()
        author = authors.get(email)
        if not isinstance(author, dict):
            author = None
        matched_consultant = author.get("consultant") if author else None
        status_code = t.get("status")
        try:
            status_code = int(status_code)
        except Exception:
            status_code = 0
        current_assignee = t.get("responder_id")
        expected_agent = agent_map.get(matched_consultant) if matched_consultant else None
        normalized.append(
            {
                "id": t.get("id"),
                "subject": t.get("subject") or "(No subject)",
                "requesterEmail": email,
                "matchedAuthor": author.get("name") if author else None,
                "matchedConsultant": matched_consultant,
                "currentAssignee": current_assignee,
                "status": FD_STATUS.get(status_code, f"Status {status_code}" if status_code else "Unknown"),
                "statusCode": status_code,
                "isMatched": bool(author),
                "needsReassign": bool(expected_agent and current_assignee != expected_agent),
                "createdAt": t.get("created_at"),
                "updatedAt": t.get("updated_at"),
            }
        )
    return normalized


def build_cache_payload(max_pages: int = 3) -> dict:
    raw_tickets, agent_map, meta = fetch_freshdesk_tickets(max_pages=max_pages)
    normalized = normalize_tickets(raw_tickets, agent_map)
    return {
        "ok": True,
        "source": "freshdesk-cron",
        "domain": FD_DOMAIN,
        "fetchedAt": _utc_now_iso(),
        "ticketCount": len(normalized),
        "agentMapCount": len(agent_map),
        "meta": meta,
        "tickets": normalized,
    }


def _utc_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def retry_after_seconds(headers) -> int | None:
    try:
        raw = headers.get("Retry-After") if headers else None
        if not raw:
            return None
        sec = int(raw)
        return sec if sec > 0 else None
    except Exception:
        return None


class FreshdeskHttpError(Exception):
    def __init__(self, status: int, detail: str = "", retry_after=None):
        super().__init__(f"Freshdesk API error {status}")
        self.status = status
        self.detail = detail
        self.retry_after = retry_after


def kv_native_available() -> bool:
    return bool(get_env("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL")) and bool(
        get_env("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN")
    )


def blob_available() -> bool:
    return bool(get_env("BLOB_READ_WRITE_TOKEN"))


def cache_store_kind() -> str:
    if kv_native_available():
        return "kv"
    if blob_available():
        return "blob"
    return "none"


def kv_available() -> bool:
    # Backward-compatible name used by existing endpoints. It now means "any supported cache store".
    return cache_store_kind() != "none"


def _kv_url() -> str:
    return (get_env("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL") or "").rstrip("/")


def _kv_token() -> str:
    return get_env("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN")


def kv_command(*parts):
    if not kv_native_available():
        raise RuntimeError("KV store not configured")
    body = json.dumps([str(p) for p in parts]).encode("utf-8")
    req = urllib.request.Request(
        _kv_url(),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {_kv_token()}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw else {}
        if data.get("error"):
            raise RuntimeError(data["error"])
        return data.get("result")


def _blob_client():
    try:
        from vercel.blob import BlobClient  # type: ignore
    except Exception as exc:  # local dev may not have the SDK installed; Vercel runtime does.
        raise RuntimeError("Vercel Blob SDK unavailable") from exc
    return BlobClient()


def _coerce_blob_get_payload(raw):
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray, str, dict, list)):
        return raw
    # SDK versions may return wrapper objects (e.g. GetBlobResult) instead of raw bytes.
    for attr in ("content", "body", "data", "value"):
        try:
            candidate = getattr(raw, attr, None)
        except Exception:
            candidate = None
        if candidate is None:
            continue
        if callable(candidate):
            try:
                candidate = candidate()
            except Exception:
                continue
        if candidate is not None:
            return candidate
    # Last-resort stream-like readers.
    for method in ("read", "readall"):
        fn = getattr(raw, method, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    return raw


def save_fd_cache(payload: dict):
    encoded = json.dumps(payload, separators=(",", ":"))
    store = cache_store_kind()
    if store == "kv":
        kv_command("SET", FD_CACHE_KEY, encoded, "EX", str(FD_CACHE_TTL_SECONDS))
        return
    if store == "blob":
        client = _blob_client()
        client.put(
            get_blob_cache_path(),
            encoded.encode("utf-8"),
            access="public",
            content_type="application/json",
            add_random_suffix=False,
            overwrite=True,
        )
        return
    raise RuntimeError("No cache store configured")


def load_fd_cache() -> dict | None:
    store = cache_store_kind()
    if store == "kv":
        raw = kv_command("GET", FD_CACHE_KEY)
        if not raw:
            return None
        if isinstance(raw, (dict, list)):
            return raw
        return json.loads(raw)
    if store == "blob":
        client = _blob_client()
        try:
            raw = client.get(get_blob_cache_path(), timeout=20)
        except Exception as exc:
            msg = str(exc).lower()
            if "not found" in msg or "404" in msg or "does not exist" in msg:
                return None
            raise
        raw = _coerce_blob_get_payload(raw)
        if not raw:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        if isinstance(raw, (dict, list)):
            return raw
        return json.loads(raw)
    return None
