"""Restricted entrypoint. Authority and budgets remain outside this container."""
import base64
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading

settings = json.loads(base64.b64decode(sys.argv[1]))
root = Path(settings['root'])
worktree = root / 'worktree'
environment = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'LC_ALL': 'C',
               'XDG_DATA_HOME': str(root / 'opencode-data'), 'XDG_CONFIG_HOME': str(root / 'opencode-config'),
               'XDG_CACHE_HOME': str(root / 'cache'), 'XDG_STATE_HOME': str(root / 'opencode-state'),
               'GH_CONFIG_DIR': str(root / 'empty-gh'), 'OPENCODE_DISABLE_MODELS_FETCH': 'true',
               'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_EXTERNAL_SKILLS': 'true'}
client = json.loads((root / 'database.json').read_text())
environment.update({'PGHOST': '/gateways/db', 'PGPORT': '6432', 'PGUSER': client['user'],
                    'PGPASSWORD': client['password'], 'PGDATABASE': client['database'], 'PGCONNECT_TIMEOUT': '3'})
if settings['mode'] in ['validation', 'evidence']:
    try:
        result = subprocess.run(settings['command'], cwd=worktree, env=environment)
        sys.exit(result.returncode)
    except OSError:
        sys.exit(125)

class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(130)
        self.sock.connect('/gateways/model/ollama.sock')

class Adapter(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions' or self.headers.get('Transfer-Encoding'):
            self.send_error(403)
            return
        length = int(self.headers.get('Content-Length', '-1'))
        if not 0 <= length <= 131072:
            self.send_error(413)
            return
        connection = UnixConnection('localhost')
        try:
            connection.request('POST', self.path, self.rfile.read(length), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError('Response overflow')
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except (OSError, ValueError, http.client.HTTPException):
            self.send_error(502)
        finally:
            connection.close()

server = http.server.ThreadingHTTPServer(('127.0.0.1', 4111), Adapter)
threading.Thread(target=server.serve_forever, daemon=True).start()
profile = settings['profile']
for instruction in profile.get('instructions', []):
    if not (worktree / instruction).is_file():
        raise RuntimeError('Missing approved instruction file')
for skills in profile.get('skills', []):
    if not (worktree / skills).is_dir():
        raise RuntimeError('Missing approved native skills directory')
config = {'model': 'ollama/local', 'small_model': 'ollama/local', 'share': 'disabled',
          'autoupdate': False, 'snapshot': False, 'enabled_providers': ['ollama'],
          'provider': {'ollama': {'npm': '@ai-sdk/openai-compatible',
                       'options': {'baseURL': 'http://127.0.0.1:4111/v1', 'timeout': 120000},
                       'models': {'local': {'id': profile['model'], 'name': 'Approved local model',
                                  'tool_call': True, 'limit': {'context': 32768, 'output': 4096}}}}},
          'permission': {'*': 'deny', 'read': 'allow', 'glob': 'allow', 'grep': 'allow',
                         'edit': 'allow', 'bash': 'allow', 'skill': 'allow'},
          'instructions': profile.get('instructions', []),
          'skills': {'paths': profile.get('skills', [])}}
environment['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
version = subprocess.run(['opencode', '--version'], env=environment, capture_output=True, text=True, timeout=60)
if version.returncode != 0 or version.stdout.strip() != '1.19.5':
    raise RuntimeError('Unreviewed OpenCode binary')
command = ['opencode', '--pure', 'run', '--dir', str(worktree), '--model', 'ollama/local',
           '--agent', profile['agent'], '--format', 'json', '--title', settings['title']]
if settings.get('session'):
    command += ['--session', settings['session']]
command.append(settings['prompt'])
try:
    sys.exit(subprocess.run(command, cwd=worktree, env=environment).returncode)
finally:
    server.shutdown()
