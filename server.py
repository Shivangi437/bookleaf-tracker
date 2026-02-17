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
import os

PORT = 8080
FD_DOMAIN = "bookleafpublishing.freshdesk.com"
RP_BASE = "https://api.razorpay.com/v1"

class ProxyHandler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/fd-api/'):
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
        headers = {
            'Authorization': auth,
            'Content-Type': 'application/json',
        }

        # Read body for PUT/POST
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
                'error': f'Freshdesk API error {e.code}',
                'detail': error_body
            }).encode())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

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
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.end_headers()

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
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
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.HTTPServer(('', PORT), ProxyHandler)
    print(f"Bookleaf Tracker running at http://localhost:{PORT}")
    print(f"Freshdesk proxy: /fd-api/* → https://{FD_DOMAIN}/api/v2/*")
    print(f"Razorpay proxy:  /rp-api/* → {RP_BASE}/*")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
