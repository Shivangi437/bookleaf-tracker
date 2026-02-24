"""DB-backed mutable state API (author overrides, tracker overrides, callbacks, sheet URLs)."""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

try:
    from api.db_store import (
        DOC_AUTHOR_OVERRIDES,
        DOC_AUTHORS_RUNTIME,
        DOC_CALLBACKS,
        DOC_SHEET_URLS,
        DOC_TRACKER_OVERRIDES,
        db_available,
        delete_doc_object_keys,
        get_all_runtime_state,
        merge_doc_object,
        set_doc,
    )
except ImportError:
    from db_store import (  # type: ignore
        DOC_AUTHOR_OVERRIDES,
        DOC_AUTHORS_RUNTIME,
        DOC_CALLBACKS,
        DOC_SHEET_URLS,
        DOC_TRACKER_OVERRIDES,
        db_available,
        delete_doc_object_keys,
        get_all_runtime_state,
        merge_doc_object,
        set_doc,
    )


VALID_VIEWS = {"admin", "Vandana", "Sapna", "Tannu", "Roosha", "Firdaus"}
CONSULTANT_VIEWS = VALID_VIEWS - {"admin"}


def _get_admin_password():
    return (
        os.getenv("BOOKLEAF_TRACKER_ADMIN_PASSWORD")
        or os.getenv("ADMIN_PASSWORD")
        or "bookleaf2025"
    )


def _is_admin(handler: BaseHTTPRequestHandler) -> bool:
    supplied = (handler.headers.get("x-admin-password") or "").strip()
    return bool(supplied) and supplied == _get_admin_password()


def _request_view(handler: BaseHTTPRequestHandler, body_obj=None) -> str:
    parsed = urlparse(handler.path)
    query = parse_qs(parsed.query)
    q_view = (query.get("view", [""])[0] or "").strip()
    if q_view:
        return q_view
    if isinstance(body_obj, dict):
        return str(body_obj.get("view") or "").strip()
    return ""


def _is_consultant_scoped_write(handler: BaseHTTPRequestHandler, body_obj) -> tuple[bool, str]:
    view = _request_view(handler, body_obj)
    if view not in CONSULTANT_VIEWS:
        return False, ""
    return True, view


def _validate_author_override_items(items, consultant_scope: str | None = None):
    patch = {}
    allowed_keys = {"c", "st", "rm", "ie", "ar", "fu", "my", "fg", "am", "pp", "ce"}
    for item in items or []:
        if not isinstance(item, dict):
            continue
        email = str(item.get("e") or "").strip().lower()
        if not email:
            continue
        consultant = str(item.get("c") or "").strip()
        if consultant_scope and consultant and consultant != consultant_scope:
            raise ValueError(f"Consultant scope mismatch for {email}")
        compact = {}
        for k in allowed_keys:
            if k in item:
                compact[k] = item[k]
        if consultant_scope and "c" not in compact:
            compact["c"] = consultant_scope
        if compact:
            patch[email] = compact
    return patch


def _validate_tracker_override_map(rows, consultant_scope: str | None = None):
    patch = {}
    allowed_keys = {"c", "n", "ie", "ar", "fu", "my", "fg", "am", "pp", "ce", "rm", "st"}
    if isinstance(rows, list):
        normalized = {}
        for entry in rows:
            if isinstance(entry, dict):
                email = str(entry.get("email") or entry.get("e") or "").strip().lower()
                data = entry.get("data") if isinstance(entry.get("data"), dict) else entry
                if email and isinstance(data, dict):
                    normalized[email] = data
        rows = normalized
    if not isinstance(rows, dict):
        return patch
    for email_raw, item in rows.items():
        email = str(email_raw or "").strip().lower()
        if not email or not isinstance(item, dict):
            continue
        consultant = str(item.get("c") or "").strip()
        if consultant_scope and consultant and consultant != consultant_scope:
            raise ValueError(f"Consultant scope mismatch for {email}")
        compact = {}
        for k in allowed_keys:
            if k in item:
                compact[k] = item[k]
        if consultant_scope and "c" not in compact:
            compact["c"] = consultant_scope
        if compact:
            patch[email] = compact
    return patch


def _validate_callbacks(callbacks, consultant_scope: str | None = None):
    if not isinstance(callbacks, list):
        raise ValueError("callbacks must be an array")
    cleaned = []
    for cb in callbacks:
        if not isinstance(cb, dict):
            continue
        item = {
            "id": str(cb.get("id") or ""),
            "authorEmail": str(cb.get("authorEmail") or "").strip(),
            "authorName": str(cb.get("authorName") or "").strip(),
            "consultant": str(cb.get("consultant") or "").strip(),
            "datetime": str(cb.get("datetime") or "").strip(),
            "notes": str(cb.get("notes") or ""),
            "status": str(cb.get("status") or "upcoming"),
        }
        if not item["id"] or not item["authorEmail"]:
            continue
        if consultant_scope and item["consultant"] != consultant_scope:
            raise ValueError("Callback consultant scope mismatch")
        cleaned.append(item)
    return cleaned


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not db_available():
            self._send_json(503, {"error": "Database not configured", "configured": False})
            return
        try:
            state = get_all_runtime_state()
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return

        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        view = (query.get("view", ["admin"])[0] or "admin").strip()
        if view not in VALID_VIEWS:
            self._send_json(400, {"error": "Invalid view"})
            return

        if view == "admin":
            if not _is_admin(self):
                self._send_json(401, {"error": "Invalid admin password"})
                return
            self._send_json(200, {"ok": True, **state})
            return

        # Consultant-scoped read (current app still uses URL-based consultant access)
        callbacks = [cb for cb in (state.get("callbacks") or []) if cb.get("consultant") == view]
        tracker_overrides = {
            k: v
            for k, v in (state.get("trackerOverrides") or {}).items()
            if isinstance(v, dict) and v.get("c") == view
        }
        author_overrides = {
            k: v
            for k, v in (state.get("authorOverrides") or {}).items()
            if isinstance(v, dict) and v.get("c") == view
        }
        sheet_urls = state.get("consultantSheetUrls") or {}
        self._send_json(
            200,
            {
                "ok": True,
                "db": state.get("db", {"configured": True}),
                "authorOverrides": author_overrides,
                "trackerOverrides": tracker_overrides,
                "callbacks": callbacks,
                "consultantSheetUrls": {view: sheet_urls.get(view)} if isinstance(sheet_urls, dict) else {},
            },
        )

    def do_POST(self):
        if not db_available():
            self._send_json(503, {"error": "Database not configured", "configured": False})
            return

        content_length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(content_length) if content_length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._send_json(400, {"error": "Invalid JSON body"})
            return

        action = str((body or {}).get("action") or "").strip()
        is_admin = _is_admin(self)
        is_consultant, consultant_view = _is_consultant_scoped_write(self, body)
        if not is_admin and not is_consultant:
            self._send_json(401, {"error": "Unauthorized"})
            return
        consultant_scope = None if is_admin else consultant_view

        try:
            if action == "upsert_author_overrides":
                patch = _validate_author_override_items(body.get("items"), consultant_scope=consultant_scope)
                merge_doc_object(DOC_AUTHOR_OVERRIDES, patch)
                self._send_json(200, {"ok": True, "action": action, "updated": len(patch)})
                return

            if action == "replace_authors_runtime":
                if not is_admin:
                    self._send_json(403, {"error": "Admin required"})
                    return
                authors = body.get("authors")
                if not isinstance(authors, list):
                    self._send_json(400, {"error": "authors must be an array"})
                    return
                # Keep payload shape compact and bounded; trust client schema but sanitize obvious cases.
                cleaned = []
                for a in authors:
                    if not isinstance(a, dict):
                        continue
                    email = str(a.get("e") or "").strip().lower()
                    if not email:
                        continue
                    row = {"e": email}
                    for k in ("n", "ph", "pk", "pl", "dt", "c", "st", "ie", "ar", "fu", "my", "fg", "am", "pp", "ce", "rm"):
                        if k in a:
                            row[k] = a.get(k)
                    cleaned.append(row)
                set_doc(DOC_AUTHORS_RUNTIME, cleaned)
                self._send_json(200, {"ok": True, "action": action, "count": len(cleaned)})
                return

            if action == "upsert_tracker_overrides":
                patch = _validate_tracker_override_map(body.get("rows"), consultant_scope=consultant_scope)
                merge_doc_object(DOC_TRACKER_OVERRIDES, patch)
                self._send_json(200, {"ok": True, "action": action, "updated": len(patch)})
                return

            if action == "delete_tracker_overrides":
                keys = [str(x).strip().lower() for x in (body.get("emails") or []) if str(x).strip()]
                if consultant_scope:
                    # Consultant-scoped deletes are allowed only when rows belong to their own scope.
                    # We don't re-read+validate each row here for performance; keep this admin-only for safety.
                    self._send_json(403, {"error": "Consultant-scoped delete not allowed"})
                    return
                delete_doc_object_keys(DOC_TRACKER_OVERRIDES, keys)
                self._send_json(200, {"ok": True, "action": action, "deleted": len(keys)})
                return

            if action == "replace_callbacks":
                callbacks = _validate_callbacks(body.get("callbacks"), consultant_scope=consultant_scope)
                if consultant_scope:
                    current = get_all_runtime_state().get("callbacks") or []
                    kept = [cb for cb in current if cb.get("consultant") != consultant_scope]
                    set_doc(DOC_CALLBACKS, kept + callbacks)
                else:
                    set_doc(DOC_CALLBACKS, callbacks)
                self._send_json(200, {"ok": True, "action": action, "count": len(callbacks)})
                return

            if action == "set_sheet_url":
                consultant = str((body.get("consultant") or "")).strip()
                if consultant not in CONSULTANT_VIEWS:
                    self._send_json(400, {"error": "Invalid consultant"})
                    return
                if consultant_scope and consultant != consultant_scope:
                    self._send_json(403, {"error": "Consultant scope mismatch"})
                    return
                url = str((body.get("url") or "")).strip()
                merge_doc_object(DOC_SHEET_URLS, {consultant: url})
                self._send_json(200, {"ok": True, "action": action, "consultant": consultant})
                return

            if action == "health":
                self._send_json(200, {"ok": True, "dbConfigured": True, "isAdmin": is_admin, "view": consultant_scope or "admin"})
                return

            self._send_json(400, {"error": "Unsupported action"})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _send_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-admin-password")
