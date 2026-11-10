"""Supervisor-only fixed Ollama gateway, extracted from the reviewed A2 profile."""

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
                connection = http.client.HTTPConnection('127.0.0.1', gateway.port, timeout=3)
                timer = None
                try:
                    connection.connect()
                    upstream_socket = connection.sock
                    def expire_readiness():
                        try:
                            upstream_socket.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    timer = threading.Timer(3, expire_readiness)
                    timer.daemon = True
                    timer.start()
                    connection.request('GET', '/v1/models')
                    response = connection.getresponse()
                    raw = response.read(MAX_RESPONSE + 1)
                    if response.status != 200 or len(raw) > MAX_RESPONSE:
                        raise ValueError('Model upstream unavailable')
                    available = json.loads(raw)
                    if gateway.model not in [item['id'] for item in available['data']]:
                        raise ValueError('Approved model unavailable')
                except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException):
                    return self.result(503, {'error': 'Approved model unavailable'})
                finally:
                    if timer:
                        timer.cancel()
                    connection.close()
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


if __name__ == '__main__':
    import argparse
    import hashlib
    import os
    import signal
    import time
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('model')
    parser.add_argument('--requests', type=int, default=16)
    parser.add_argument('--seconds', type=int, default=120)
    args = parser.parse_args()
    if os.getuid() == 0 or not args.directory.is_absolute() or any(args.directory.iterdir()):
        raise RuntimeError('Use a non-root supervisor and an empty dedicated absolute socket directory')
    if not 1 <= args.requests <= 1000 or not 1 <= args.seconds <= 600:
        raise RuntimeError('Gateway budgets out of bounds')
    gateway = ModelGateway(args.directory / 'ollama.sock', args.model,
                           request_budget=args.requests, seconds=args.seconds)
    manifest = args.directory.parent / (args.directory.name + '.gateway.json')
    stat = gateway.path.stat()
    identity = {'pid': os.getpid(), 'start': Path('/proc/self/stat').read_text().split()[21],
                'device': stat.st_dev, 'inode': stat.st_ino, 'uid': os.getuid(), 'model': args.model,
                'requests': args.requests, 'seconds': args.seconds,
                'scriptHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    pending = manifest.with_suffix('.pending')
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        json.dump(identity, file)
        file.flush()
        os.fsync(file.fileno())
    os.link(pending, manifest)
    pending.unlink()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        while True:
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        gateway.close()
