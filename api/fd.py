"""Freshdesk API proxy – Vercel serverless function"""
import json
import os
import base64
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

FD_DOMAIN = "bookleafpublishing.freshdesk.com"


def _server_freshdesk_key():
    return (
        os.getenv("FRESHDESK_API_KEY")
        or os.getenv("BOOKLEAF_FRESHDESK_API_KEY")
        or os.getenv("FRESHDESK_KEY")
        or ""
    )


def _basic_auth_from_key(key):
    token = base64.b64encode(f"{key}:X".encode("utf-8")).decode("ascii")
    return f"Basic {token}"

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/api/fd/config', '/api/fd/config/'):
            self._send_json(200, {
                'configured': bool(_server_freshdesk_key()),
                'domain': FD_DOMAIN,
            })
            return
        self._proxy('GET')

    def do_PUT(self):
        self._proxy('PUT')

    def do_POST(self):
        self._proxy('POST')

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _proxy(self, method):
        # Strip /api/fd prefix to get the Freshdesk path
        path = self.path
        if path.startswith('/api/fd/'):
            path = path[len('/api/fd/'):]
        elif path.startswith('/api/fd'):
            path = path[len('/api/fd'):]

        fd_url = f"https://{FD_DOMAIN}/api/v2/{path}"

        auth = self.headers.get('Authorization', '')
        if not auth:
            key = _server_freshdesk_key()
            if key:
                auth = _basic_auth_from_key(key)
        headers = {
            'Authorization': auth,
            'Content-Type': 'application/json',
        }

        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))

        try:
            req = urllib.request.Request(fd_url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self._cors()
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8', errors='replace')
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(json.dumps({
                'error': f'Freshdesk API error {e.code}',
                'detail': error_body
            }).encode())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')

    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
