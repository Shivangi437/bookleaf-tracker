"""Bootstrap data API for author-consultant tracker (Vercel serverless)."""
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DATA_DIR = Path(__file__).resolve().parent / "_data"
AUTHORS_PATH = DATA_DIR / "authors.json"
TRACKER_PATH = DATA_DIR / "tracker.json"

VALID_VIEWS = {"admin", "Vandana", "Sapna", "Tannu", "Roosha", "Firdaus"}

try:
    from api.db_store import db_available as _db_available, get_all_runtime_state
except ImportError:
    try:
        from db_store import db_available as _db_available, get_all_runtime_state  # type: ignore
    except ImportError:
        _db_available = lambda: False  # type: ignore
        get_all_runtime_state = None  # type: ignore


def _load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _get_admin_password():
    # Env-first, with legacy fallback for local continuity.
    return (
        os.getenv("BOOKLEAF_TRACKER_ADMIN_PASSWORD")
        or os.getenv("ADMIN_PASSWORD")
        or "bookleaf2025"
    )


def _get_reassign_cutoff():
    return os.getenv("BOOKLEAF_REASSIGN_CUTOFF", "2026-02-17")


def _filter_authors_for_view(authors, view):
    if view == "admin":
        return authors
    return [a for a in authors if a.get("c") == view]


def _merge_tracker_overrides(base_tracker: dict, tracker_overrides: dict):
    if not isinstance(base_tracker, dict):
        base_tracker = {}
    if not isinstance(tracker_overrides, dict):
        return base_tracker
    merged = dict(base_tracker)
    for email_raw, row in tracker_overrides.items():
        email = str(email_raw or "").strip().lower()
        if not email or not isinstance(row, dict):
            continue
        prev = merged.get(email)
        if not isinstance(prev, dict):
            prev = {}
        next_row = dict(prev)
        for key in ("c", "n", "ie", "ar", "fu", "my", "fg", "am", "pp", "ce", "rm", "st"):
            if key in row:
                next_row[key] = row.get(key)
        merged[email] = next_row
    return merged


def _merge_author_overrides(base_authors: list, author_overrides: dict):
    if not isinstance(base_authors, list):
        return []
    if not isinstance(author_overrides, dict):
        return base_authors
    merged = []
    for a in base_authors:
        if not isinstance(a, dict):
            merged.append(a)
            continue
        email = str(a.get("e") or "").strip().lower()
        ov = author_overrides.get(email) if email else None
        if not isinstance(ov, dict):
            merged.append(a)
            continue
        row = dict(a)
        for key in ("c", "st", "rm", "ie", "ar", "fu", "my", "fg", "am", "pp", "ce"):
            if key in ov:
                row[key] = ov.get(key)
        merged.append(row)
    return merged

def _tracker_counts(tracker):
    counts = {}
    for item in tracker.values():
        consultant = item.get("c") if isinstance(item, dict) else None
        if not consultant:
            continue
        counts[consultant] = counts.get(consultant, 0) + 1
    return counts


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        kind = (query.get("kind", ["bootstrap"])[0] or "bootstrap").strip()
        view = (query.get("view", ["admin"])[0] or "admin").strip()

        if kind != "bootstrap":
            self._send_json(400, {"error": "Unsupported kind"})
            return
        if view not in VALID_VIEWS:
            self._send_json(400, {"error": "Invalid view"})
            return

        try:
            authors = _load_json(AUTHORS_PATH)
            tracker = _load_json(TRACKER_PATH)
        except FileNotFoundError as exc:
            self._send_json(500, {"error": f"Missing data file: {exc.filename}"})
            return
        except json.JSONDecodeError as exc:
            self._send_json(500, {"error": f"Invalid JSON in data file: {exc.msg}"})
            return

        runtime_state = None
        if callable(get_all_runtime_state) and _db_available():
            try:
                runtime_state = get_all_runtime_state()
            except Exception:
                runtime_state = None

        if runtime_state:
            authors_runtime = runtime_state.get("authorsRuntime")
            if isinstance(authors_runtime, list) and authors_runtime:
                authors = authors_runtime
            tracker = _merge_tracker_overrides(tracker, runtime_state.get("trackerOverrides") or {})
            authors = _merge_author_overrides(authors, runtime_state.get("authorOverrides") or {})
        tracker_counts = _tracker_counts(tracker)

        if view == "admin":
            supplied = self.headers.get("x-admin-password", "")
            if supplied != _get_admin_password():
                self._send_json(401, {"error": "Invalid admin password"})
                return
            payload = {
                "scope": "admin",
                "view": "admin",
                "authors": authors,
                "tracker": tracker,
                "trackerCounts": tracker_counts,
                "reassignCutoff": _get_reassign_cutoff(),
                "callbacks": (runtime_state or {}).get("callbacks", []),
                "consultantSheetUrls": (runtime_state or {}).get("consultantSheetUrls", {}),
                "dbPersistence": (runtime_state or {}).get("db", {"configured": False}),
            }
            self._send_json(200, payload)
            return

        payload = {
            "scope": "consultant",
            "view": view,
            "authors": _filter_authors_for_view(authors, view),
            # Do not expose tracker-stage maps to consultant links.
            "tracker": {},
            "trackerCounts": tracker_counts,
            "reassignCutoff": _get_reassign_cutoff(),
            "callbacks": [
                cb
                for cb in ((runtime_state or {}).get("callbacks") or [])
                if isinstance(cb, dict) and cb.get("consultant") == view
            ],
            "consultantSheetUrls": {
                view: (((runtime_state or {}).get("consultantSheetUrls") or {}).get(view))
            },
            "dbPersistence": (runtime_state or {}).get("db", {"configured": False}),
        }
        self._send_json(200, payload)

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
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-admin-password")
