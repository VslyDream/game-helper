"""Loopback preview, with optional real controller input. Game API is separate."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit


class PreviewHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.svg': 'image/svg+xml', '.css': 'text/css'}

    def do_GET(self):
        expected = f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host') != expected or self.headers.get('Origin', f'http://{expected}') != f'http://{expected}':
            return self.send_error(403, 'Local origin only')
        if urlsplit(self.path).path == '/api/controller/state':
            if not self.server.controller:
                return self.send_error(404, 'Controller module not selected')
            data = json.dumps(self.server.controller.snapshot(), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def make_server(directory, port=18767):
    directory = Path(directory).resolve()
    profile_path = directory / 'config.json'
    profile = json.loads(profile_path.read_text(encoding='utf-8-sig')) if profile_path.exists() else {}
    handler = partial(PreviewHandler, directory=str(directory))
    server = ThreadingHTTPServer(('127.0.0.1', port), handler)
    server.daemon_threads = True
    server.controller = None
    try:
        if 'controller' in profile.get('modules', []):
            sys.path.insert(0, str(directory))
            from controller_input import ControllerService
            server.controller = ControllerService().start()
        return server
    except Exception:
        server.server_close()
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18767)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    server = make_server(args.directory, args.port)
    print(f'http://127.0.0.1:{server.server_port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server.controller:
            server.controller.stop()
        server.server_close()
