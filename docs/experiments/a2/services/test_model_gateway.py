"""Adversarial fixture tests. No desktop model, database, Docker or external calls."""

import http.server
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest

from model_gateway import LoopbackAdapter, ModelGateway, UnixHTTPConnection, MAX_REQUEST


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.upstream_status = 200
        self.delay = 0
        case = self
        class Upstream(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                content = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                case.requests.append({'path': self.path, 'body': content, 'authorization': self.headers.get('Authorization')})
                if case.delay:
                    time.sleep(case.delay)
                self.send_response(case.upstream_status)
                self.send_header('Content-Type', 'application/json')
                if case.upstream_status == 302:
                    self.send_header('Location', 'http://127.0.0.1:1/forbidden')
                self.end_headers()
                try:
                    self.wfile.write(b'{"choices":[{"message":{"content":"OK"}}]}')
                except BrokenPipeError:
                    pass
        self.upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        self.thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.thread.start()
        self.tmp = tempfile.TemporaryDirectory(prefix='cf-a2-gateway-test-')
        self.path = Path(self.tmp.name) / 'gateway.sock'
        self.gateway = ModelGateway(self.path, 'fixture-model', port=self.upstream.server_port, request_budget=2)

    def tearDown(self):
        self.gateway.close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def request(self, method, path, data=None, headers=None):
        conn = UnixHTTPConnection(self.path)
        try:
            conn.request(method, path, json.dumps(data).encode() if data is not None else None,
                         headers or {'Content-Type': 'application/json'})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def payload(self):
        return {'model': 'fixture-model', 'messages': [{'role': 'user', 'content': 'synthetic'}]}

    def test_only_fixed_route_model_and_destination_can_reach_upstream(self):
        for path in ['/api/pull', '/api/delete', '/api/push', '/effect', '//127.0.0.1/',
                     '/v1/chat/completions?url=http://127.0.0.1', 'http://127.0.0.1/v1/chat/completions',
                     '/v1/%63hat/completions']:
            self.assertEqual(self.request('POST', path, self.payload())[0], 403)
        self.assertEqual(self.request('CONNECT', 'localhost:11434')[0], 405)
        self.assertEqual(self.request('POST', '/v1/chat/completions', {**self.payload(), 'model': 'other'})[0], 400)
        self.assertEqual(self.request('POST', '/v1/chat/completions', {**self.payload(), 'upstream': 'http://elsewhere'})[0], 400)
        self.assertEqual(self.requests, [])
        status, _ = self.request('POST', '/v1/chat/completions', self.payload(), {'Authorization': 'Bearer synthetic-private-token', 'Host': 'evil.invalid'})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.requests), 1)
        self.assertIsNone(self.requests[0]['authorization'])
        self.assertEqual(self.requests[0]['path'], '/v1/chat/completions')
        self.assertEqual(self.requests[0]['body']['max_tokens'], 512)

    def test_framing_size_and_output_limits_fail_before_upstream(self):
        for data in [{**self.payload(), 'max_tokens': 1000000}, {**self.payload(), 'max_tokens': True},
                     {**self.payload(), 'max_completion_tokens': -1}, {**self.payload(), 'stream': 'yes'},
                     {**self.payload(), 'messages': []}]:
            self.assertEqual(self.request('POST', '/v1/chat/completions', data)[0], 400)
        self.assertEqual(self.request('POST', '/v1/chat/completions', {**self.payload(), 'messages': ['x' * MAX_REQUEST]})[0], 413)
        for headers in ['Content-Length: 1\r\nContent-Length: 2', 'Transfer-Encoding: chunked', 'Content-Length: nope']:
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(2)
                connection.connect(str(self.path))
                connection.sendall(f'POST /v1/chat/completions HTTP/1.0\r\n{headers}\r\n\r\n'.encode())
                self.assertIn(b' 400 ', connection.recv(4096).split(b'\r\n')[0])
        self.assertEqual(self.requests, [])

    def test_redirects_and_request_budget_do_not_open_proxy_or_fallback(self):
        self.upstream_status = 302
        self.assertEqual(self.request('POST', '/v1/chat/completions', self.payload())[0], 502)
        self.upstream_status = 200
        self.assertEqual(self.request('POST', '/v1/chat/completions', self.payload())[0], 200)
        self.assertEqual(self.request('POST', '/v1/chat/completions', self.payload())[0], 429)
        self.assertEqual(len(self.requests), 2)

    def test_concurrent_inference_is_rejected_and_loopback_adapter_preserves_boundary(self):
        self.gateway.inference_lock.acquire()
        try:
            self.assertEqual(self.request('POST', '/v1/chat/completions', self.payload())[0], 429)
        finally:
            self.gateway.inference_lock.release()
        adapter = LoopbackAdapter(self.path, port=0)
        try:
            import http.client
            connection = http.client.HTTPConnection('127.0.0.1', adapter.server.server_port)
            connection.request('POST', '/v1/chat/completions', json.dumps(self.payload()))
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(b'OK', response.read())
            connection.close()
        finally:
            adapter.close()

    def test_slow_upstream_is_cut_off_without_fallback(self):
        self.gateway.seconds = 0.05
        self.delay = 0.2
        self.assertEqual(self.request('POST', '/v1/chat/completions', self.payload())[0], 502)
        self.assertEqual(self.gateway.counters['accepted'], 1)
        self.assertEqual(self.gateway.counters['upstreamErrors'], 1)

    def test_idle_connections_cannot_create_unbounded_gateway_threads(self):
        connections = []
        try:
            for _ in range(4):
                connection = socket.socket(socket.AF_UNIX)
                connection.settimeout(1)
                connection.connect(str(self.path))
                connection.sendall(b'GET /v1/models HTTP/1.0\r\n')
                connections.append(connection)
            time.sleep(0.05)
            with socket.socket(socket.AF_UNIX) as extra:
                extra.settimeout(1)
                extra.connect(str(self.path))
                extra.sendall(b'GET /v1/models HTTP/1.0\r\n\r\n')
                try:
                    self.assertEqual(extra.recv(4096), b'')
                except ConnectionResetError:
                    pass
        finally:
            for connection in connections:
                connection.close()
        time.sleep(0.05)
        self.assertEqual(self.request('GET', '/v1/models')[0], 200)


if __name__ == '__main__':
    unittest.main()
