"""A2 experiment: fixed local model gateway and worker loopback adapter.

This is a feasibility fixture, not an installed Code Foundry service. The trusted
side has one fixed upstream and no proxy destination selected by requests.
"""

import http.client
import http.server
import json
from pathlib import Path
import socket
import socketserver
import threading

MAX_REQUEST = 131072
MAX_RESPONSE = 8 * 1024 * 1024


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=130):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class QuietHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def result(self, code, value):
        content = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(content)
        self.close_connection = True

    def body(self):
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1:
            raise ValueError('Unsupported body framing')
        if not lengths[0].isascii() or not lengths[0].isdigit():
            raise ValueError('Invalid body length')
        size = int(lengths[0])
        if size > MAX_REQUEST:
            raise OverflowError('Request too large')
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError('Incomplete body')
        return data


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 4

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class ModelGateway:
    def __init__(self, path, model, *, port=11434, request_budget=16, seconds=120):
        self.path = Path(path)
        self.model = model
        self.port = port
        self.budget = request_budget
        self.seconds = seconds
        self.inference_lock = threading.Lock()
        self.current_socket = None
        self.counters = {'accepted': 0, 'denied': 0, 'upstreamErrors': 0}
        gateway = self

        class Handler(QuietHandler):
            def deny(self, code=403):
                gateway.counters['denied'] += 1
                self.result(code, {'error': 'Model gateway denied request'})

            def do_GET(self):
                if self.path != '/v1/models':
                    return self.deny()
                self.result(200, {'object': 'list', 'data': [{'id': gateway.model, 'object': 'model', 'owned_by': 'local'}]})

            def do_POST(self):
                if self.path != '/v1/chat/completions':
                    return self.deny()
                try:
                    raw = self.body()
                    value = json.loads(raw)
                    allowed = {'model', 'messages', 'tools', 'tool_choice', 'temperature', 'top_p',
                               'max_tokens', 'max_completion_tokens', 'stream', 'stream_options',
                               'seed', 'stop', 'presence_penalty', 'frequency_penalty',
                               'reasoning_effort', 'parallel_tool_calls'}
                    if not isinstance(value, dict) or set(value) - allowed:
                        raise ValueError('Unsupported request')
                    if value.get('model') != gateway.model or not isinstance(value.get('messages'), list):
                        raise ValueError('Unapproved model or message format')
                    if not 1 <= len(value['messages']) <= 128:
                        raise ValueError('Message count out of bounds')
                    if 'stream' in value and not isinstance(value['stream'], bool):
                        raise ValueError('Invalid stream flag')
                    for key in ['max_tokens', 'max_completion_tokens']:
                        if key in value and (type(value[key]) is not int or not 1 <= value[key] <= 4096):
                            raise ValueError('Unbounded output')
                    if 'max_tokens' not in value and 'max_completion_tokens' not in value:
                        value['max_tokens'] = 512
                except OverflowError:
                    return self.deny(413)
                except (ValueError, TypeError, RecursionError):
                    return self.deny(400)
                if not gateway.inference_lock.acquire(blocking=False):
                    return self.deny(429)
                connection = None
                timer = None
                started_response = False
                try:
                    if gateway.counters['accepted'] >= gateway.budget:
                        return self.deny(429)
                    gateway.counters['accepted'] += 1
                    # Fixed loopback destination; ignore client Host/Authorization/URL fields.
                    connection = http.client.HTTPConnection('127.0.0.1', gateway.port, timeout=gateway.seconds)
                    connection.connect()
                    upstream_socket = connection.sock
                    gateway.current_socket = upstream_socket
                    def expire():
                        try:
                            upstream_socket.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    timer = threading.Timer(gateway.seconds, expire)
                    timer.daemon = True
                    timer.start()
                    connection.request('POST', '/v1/chat/completions', json.dumps(value).encode(),
                                       {'Content-Type': 'application/json', 'Accept-Encoding': 'identity'})
                    response = connection.getresponse()
                    content_type = response.getheader('Content-Type', '')
                    if response.status != 200 or content_type.split(';')[0] not in ['application/json', 'text/event-stream']:
                        raise ValueError('Unexpected upstream response; redirects are never followed')
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    started_response = True
                    count = 0
                    while True:
                        chunk = response.read1(4096)
                        if not chunk:
                            break
                        count += len(chunk)
                        if count > MAX_RESPONSE:
                            raise ValueError('Upstream response too large')
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (OSError, ValueError, http.client.HTTPException):
                    gateway.counters['upstreamErrors'] += 1
                    if not started_response:
                        self.result(502, {'error': 'Approved model upstream failed'})
                finally:
                    self.close_connection = True
                    if timer:
                        timer.cancel()
                    if connection:
                        connection.close()
                    gateway.current_socket = None
                    gateway.inference_lock.release()

            do_CONNECT = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = lambda self: self.deny(405)

        self.server = UnixServer(str(path), Handler)
        self.path.chmod(0o666)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        if self.current_socket:
            try:
                self.current_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.server.server_close()
        self.thread.join(timeout=2)
        # Do not unlink a socket directory that an existing worker still sees.


class LoopbackAdapter:
    def __init__(self, path, port=4111):
        destination = str(path)

        class Handler(QuietHandler):
            def forward(self):
                connection = UnixHTTPConnection(destination)
                try:
                    raw = self.body() if self.command == 'POST' else None
                    connection.request(self.command, self.path, raw, {'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    self.send_response(response.status)
                    self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    while True:
                        chunk = response.read1(4096)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (OSError, ValueError, OverflowError, http.client.HTTPException):
                    self.close_connection = True
                finally:
                    self.close_connection = True
                    connection.close()
            do_GET = do_POST = do_CONNECT = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = forward

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
