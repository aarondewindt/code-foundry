"""One HTTP request over QEMU guestfwd stdin/stdout, only during bootstrap.

No listening socket, CONNECT, credentials, redirects or arbitrary destinations.
Ubuntu's signed apt indexes authenticate packages; guest traffic stays isolated.
"""
import http.client
import ipaddress
from pathlib import Path
import socket
import sys
from urllib.parse import urlsplit

HOSTS = frozenset({'archive.ubuntu.com', 'security.ubuntu.com'})
MAX_RESPONSE = 256 * 1024 * 1024


def destination(url):
    value = urlsplit(url)
    if (value.scheme != 'http' or value.hostname not in HOSTS
            or value.port not in (None, 80) or value.username or value.password
            or value.fragment or value.query or not value.path.startswith('/ubuntu/')
            or any(c in url for c in '\r\n\\')):
        raise ValueError('Bootstrap destination denied')
    return value.hostname, value.path


def public_address(host):
    addresses = socket.getaddrinfo(host, 80, family=socket.AF_INET, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('Non-public bootstrap destination denied')
    return addresses[0][4][0]


def serve(source, target, enabled):
    try:
        # An unlinked private marker disables future connections before tests.
        if not enabled.is_file():
            raise ValueError('Bootstrap finished')
        request = source.readline(8193)
        if len(request) > 8192:
            raise ValueError('Request too long')
        method, url, version = request.decode('ascii').strip().split(' ')
        if method != 'GET' or version not in ('HTTP/1.0', 'HTTP/1.1'):
            raise ValueError('Only package GET is allowed')
        host, path = destination(url)
        for _ in range(64):
            line = source.readline(8193)
            if line in (b'\r\n', b'\n'):
                break
            if not line or len(line) > 8192 or line.lower().startswith(
                    (b'authorization:', b'proxy-authorization:', b'transfer-encoding:', b'content-length:')):
                raise ValueError('Unsupported headers')
        else:
            raise ValueError('Too many headers')
        # Connect to the checked address, never resolve the hostname a second time.
        connection = http.client.HTTPConnection(public_address(host), 80, timeout=30)
        try:
            connection.request('GET', path, headers={'Host': host, 'Connection': 'close'})
            response = connection.getresponse()
            if response.status not in (200, 404):
                raise ValueError('Unexpected upstream status; redirects denied')
            length = response.getheader('Content-Length')
            if length is None or not length.isdigit() or int(length) > MAX_RESPONSE:
                raise ValueError('Unbounded package response')
            target.write(f'HTTP/1.1 {response.status} Package\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n'.encode())
            remaining = int(length)
            while remaining:
                if not enabled.is_file():
                    raise ValueError('Bootstrap finished')
                chunk = response.read(min(65536, remaining))
                if not chunk:
                    raise ValueError('Truncated package')
                remaining -= len(chunk)
                target.write(chunk)
        finally:
            connection.close()
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        # No raw upstream errors or request contents enter the console.
        target.write(b'HTTP/1.1 403 Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    target.flush()


if __name__ == '__main__':
    # GNU timeout independently bounds every guestfwd helper, even after a crash.
    serve(sys.stdin.buffer, sys.stdout.buffer, Path(sys.argv[1]))
