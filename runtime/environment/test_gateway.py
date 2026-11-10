"""Actual Unix gateway tests against a protected synthetic HTTP upstream."""
import http.server
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from model_gateway import ModelGateway, UnixHTTPConnection

class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.effects = []
        self.models = ['synthetic-model']
        case = self
        class Mock(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'data':[{'id':model} for model in case.models]}).encode())
            def do_POST(self):
                case.effects.append(self.path)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"choices":[]}')
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.tmp = tempfile.TemporaryDirectory(prefix='cf-b2-gateway-test-')
        self.path = Path(self.tmp.name) / 'ollama.sock'
        self.gateway = ModelGateway(self.path, 'synthetic-model', port=self.server.server_port, request_budget=1)
    def tearDown(self):
        self.gateway.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()
    def request(self, method, path, value=None):
        connection = UnixHTTPConnection(self.path, timeout=3)
        try:
            connection.request(method, path, None if value is None else json.dumps(value), {'Content-Type':'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()
    def payload(self):
        return {'model':'synthetic-model','messages':[{'role':'user','content':'fixture'}]}
    def test_readiness_requires_actual_upstream_model(self):
        self.assertEqual(self.request('GET','/v1/models')[0],200)
        self.models = []
        self.assertEqual(self.request('GET','/v1/models')[0],503)
        self.assertEqual(self.effects,[])
    def test_mock_effects_and_management_never_reach_upstream(self):
        for path in ['/effect','/api/delete','/api/pull','http://127.0.0.1/effect','//127.0.0.1/effect','/v1/chat/completions?url=http://elsewhere']:
            self.assertEqual(self.request('POST',path,{})[0],403)
        self.assertEqual(self.request('CONNECT','localhost:11434')[0],405)
        self.assertEqual(self.effects,[])
    def test_only_fixed_model_and_route_with_bounded_budget(self):
        self.assertEqual(self.request('POST','/v1/chat/completions',{**self.payload(),'model':'other'})[0],400)
        self.assertEqual(self.request('POST','/v1/chat/completions',{**self.payload(),'upstream':'http://other'})[0],400)
        self.assertEqual(self.request('POST','/v1/chat/completions',self.payload())[0],200)
        self.assertEqual(self.request('POST','/v1/chat/completions',self.payload())[0],429)
        self.assertEqual(self.effects,['/v1/chat/completions'])
    def test_bounded_output_and_concurrency(self):
        self.assertEqual(self.request('POST','/v1/chat/completions',{**self.payload(),'max_tokens':999999})[0],400)
        self.gateway.inference_lock.acquire()
        try:
            self.assertEqual(self.request('POST','/v1/chat/completions',self.payload())[0],429)
        finally:
            self.gateway.inference_lock.release()
        self.assertEqual(self.effects,[])
    def test_duplicate_framing_is_rejected(self):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(3)
            connection.connect(str(self.path))
            connection.sendall(b'POST /v1/chat/completions HTTP/1.0\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n')
            self.assertIn(b' 400 ',connection.recv(4096))
        self.assertEqual(self.effects,[])

if __name__ == '__main__':
    unittest.main()
