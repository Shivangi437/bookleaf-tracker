#!/usr/bin/env python3
"""
Local server that:
1. Serves static files (HTML/CSS/JS)
2. Proxies Freshdesk API calls to avoid CORS issues
"""

import http.server
import json
import urllib.request
import urllib.error
import urllib.parse
import os
import time
import hmac
import hashlib
import base64

PORT = 8080
FD_DOMAIN = "bookleafpublishing.freshdesk.com"
RP_BASE = "https://api.razorpay.com/v1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "api", "_data")
VALID_VIEWS = {"admin", "Vandana", "Sapna", "Tannu", "Roosha", "Firdaus"}
RECENT_RAZORPAY_WEBHOOK_EVENTS = []


def freshdesk_server_key():
    return (
        os.getenv('FRESHDESK_API_KEY')
        or os.getenv('BOOKLEAF_FRESHDESK_API_KEY')
        or os.getenv('FRESHDESK_KEY')
        or ''
    )


def freshdesk_basic_auth_from_key(key):
    token = base64.b64encode(f'{key}:X'.encode('utf-8')).decode('ascii')
    return f'Basic {token}'

def tracker_counts(tracker):
    counts = {}
    for item in tracker.values():
        if not isinstance(item, dict):
            continue
        consultant = item.get('c')
        if not consultant:
            continue
        counts[consultant] = counts.get(consultant, 0) + 1
    return counts

class ProxyHandler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/api/data'):
            self._serve_data_api()
        elif self.path.startswith('/api/razorpay-webhook'):
            self._serve_razorpay_webhook_status()
        elif self.path.startswith('/fd-api/config'):
            self._serve_freshdesk_proxy_config()
        elif self.path.startswith('/fd-api/'):
            self._proxy_freshdesk('GET')
        elif self.path.startswith('/rp-api/'):
            self._proxy_razorpay('GET')
        else:
            super().do_GET()

    def do_PUT(self):
        if self.path.startswith('/fd-api/'):
            self._proxy_freshdesk('PUT')
        else:
            self.send_error(405)

    def do_POST(self):
        if self.path.startswith('/fd-api/'):
            self._proxy_freshdesk('POST')
        elif self.path.startswith('/api/razorpay-webhook'):
            self._handle_razorpay_webhook()
        elif self.path.startswith('/rp-api/'):
            self._proxy_razorpay('POST')
        else:
            self.send_error(405)

    def _proxy_freshdesk(self, method):
        # Build Freshdesk URL
        fd_path = self.path.replace('/fd-api/', '', 1)
        fd_url = f"https://{FD_DOMAIN}/api/v2/{fd_path}"

        # Forward Authorization header
        auth = self.headers.get('Authorization', '')
        if not auth:
            key = freshdesk_server_key()
            if key:
                auth = freshdesk_basic_auth_from_key(key)
        headers = {
            'Authorization': auth,
            'Content-Type': 'application/json',
        }

        print(f"[FD Proxy] {method} {fd_url}")
        print(f"[FD Proxy] Auth header present: {bool(auth)}")

        # Read body for PUT/POST
        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))

        try:
            req = urllib.request.Request(fd_url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req) as resp:
                resp_body = resp.read()
                print(f"[FD Proxy] Response: {resp.status}, {len(resp_body)} bytes")
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8', errors='replace')
            print(f"[FD Proxy] ERROR: {e.code} — {error_body[:200]}")
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'error': f'Freshdesk API error {e.code}',
                'detail': error_body
            }).encode())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _serve_freshdesk_proxy_config(self):
        self._send_json(200, {
            'configured': bool(freshdesk_server_key()),
            'domain': FD_DOMAIN,
        })

    def _proxy_razorpay(self, method):
        """Proxy Razorpay API calls (Basic Auth: key_id:key_secret)"""
        rp_path = self.path.replace('/rp-api/', '', 1)
        rp_url = f"{RP_BASE}/{rp_path}"

        auth = self.headers.get('Authorization', '')
        headers = {
            'Authorization': auth,
            'Content-Type': 'application/json',
        }

        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))

        try:
            req = urllib.request.Request(rp_url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8', errors='replace')
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'error': f'Razorpay API error {e.code}',
                'detail': error_body
            }).encode())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _serve_data_api(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        kind = (query.get('kind', ['bootstrap'])[0] or 'bootstrap').strip()
        view = (query.get('view', ['admin'])[0] or 'admin').strip()

        if kind != 'bootstrap':
            self._send_json(400, {'error': 'Unsupported kind'})
            return
        if view not in VALID_VIEWS:
            self._send_json(400, {'error': 'Invalid view'})
            return

        try:
            authors = self._load_data_json('authors.json')
            tracker = self._load_data_json('tracker.json')
            counts = tracker_counts(tracker)
        except FileNotFoundError as e:
            self._send_json(500, {'error': f'Missing data file: {e.filename}'})
            return
        except json.JSONDecodeError as e:
            self._send_json(500, {'error': f'Invalid JSON in data file: {e.msg}'})
            return

        if view == 'admin':
            supplied = self.headers.get('x-admin-password', '')
            admin_password = os.getenv('BOOKLEAF_TRACKER_ADMIN_PASSWORD') or os.getenv('ADMIN_PASSWORD') or 'bookleaf2025'
            if supplied != admin_password:
                self._send_json(401, {'error': 'Invalid admin password'})
                return
            self._send_json(200, {
                'scope': 'admin',
                'view': 'admin',
                'authors': authors,
                'tracker': tracker,
                'trackerCounts': counts,
                'reassignCutoff': os.getenv('BOOKLEAF_REASSIGN_CUTOFF', '2026-02-17'),
            })
            return

        filtered_authors = [a for a in authors if a.get('c') == view]
        self._send_json(200, {
            'scope': 'consultant',
            'view': view,
            'authors': filtered_authors,
            'tracker': {},
            'trackerCounts': counts,
            'reassignCutoff': os.getenv('BOOKLEAF_REASSIGN_CUTOFF', '2026-02-17'),
        })

    def _serve_razorpay_webhook_status(self):
        secret = os.getenv('RAZORPAY_WEBHOOK_SECRET') or os.getenv('BOOKLEAF_RAZORPAY_WEBHOOK_SECRET') or ''
        self._send_json(200, {
            'ok': True,
            'configured': bool(secret),
            'recent': list(reversed(RECENT_RAZORPAY_WEBHOOK_EVENTS[-10:])),
        })

    def _handle_razorpay_webhook(self):
        secret = os.getenv('RAZORPAY_WEBHOOK_SECRET') or os.getenv('BOOKLEAF_RAZORPAY_WEBHOOK_SECRET') or ''
        if not secret:
            self._send_json(500, {'error': 'RAZORPAY_WEBHOOK_SECRET not configured'})
            return

        content_length = int(self.headers.get('Content-Length', '0') or '0')
        raw_body = self.rfile.read(content_length) if content_length else b''
        signature = (self.headers.get('X-Razorpay-Signature') or '').strip()
        if not signature:
            self._send_json(400, {'error': 'Missing X-Razorpay-Signature'})
            return

        expected = hmac.new(secret.encode('utf-8'), raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            self._send_json(401, {'error': 'Invalid webhook signature'})
            return

        event_name = 'unknown'
        if raw_body:
            try:
                payload = json.loads(raw_body.decode('utf-8'))
                event_name = payload.get('event') or 'unknown'
            except Exception:
                pass

        RECENT_RAZORPAY_WEBHOOK_EVENTS.append({
            'receivedAt': int(time.time()),
            'event': event_name,
            'contentLength': len(raw_body),
        })
        if len(RECENT_RAZORPAY_WEBHOOK_EVENTS) > 20:
            del RECENT_RAZORPAY_WEBHOOK_EVENTS[:-20]

        self._send_json(200, {'ok': True, 'event': event_name})

    def _load_data_json(self, filename):
        with open(os.path.join(DATA_DIR, filename), 'r', encoding='utf-8') as f:
            return json.load(f)

    def _send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-admin-password, X-Razorpay-Signature')
        self.end_headers()

    def end_headers(self):
        super().end_headers()

    def log_message(self, format, *args):
        # Cleaner logging
        msg = str(args[0]) if args else ''
        if '/fd-api/' in msg:
            print(f"[Freshdesk Proxy] {msg}")
        elif '/rp-api/' in msg:
            print(f"[Razorpay Proxy] {msg}")
        else:
            pass  # suppress static file logs

if __name__ == '__main__':
    os.chdir(os.path.join(BASE_DIR, 'public'))
    server = http.server.HTTPServer(('', PORT), ProxyHandler)
    print(f"Bookleaf Tracker running at http://localhost:{PORT}")
    print(f"Freshdesk proxy: /fd-api/* → https://{FD_DOMAIN}/api/v2/*")
    print(f"Razorpay proxy:  /rp-api/* → {RP_BASE}/*")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
