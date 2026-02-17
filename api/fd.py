"""Freshdesk API proxy – Vercel serverless function"""
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

FD_DOMAIN = "bookleafpublishing.freshdesk.com"

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
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
