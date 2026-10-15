# Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
# https://www.apache.org/licenses/LICENSE-2.0
"""Exercise the actual loopback transport used by documentation browser checks."""

from __future__ import annotations

import socket
import sys
import unittest
from contextlib import contextmanager
from functools import partial
from http.client import HTTPConnection
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from unittest.mock import patch

from scripts import docs_server
from scripts.docs_server import DocumentationServer


class DocumentationServerTests(unittest.TestCase):
    @contextmanager
    def running_cli(self, directory):
        ready = Event()
        servers, errors = [], []

        def observed_server(*args, **kwargs):
            server = DocumentationServer(*args, **kwargs)
            servers.append(server)
            ready.set()
            return server

        def main():
            try:
                docs_server.main()
            except BaseException as error:
                errors.append(error)

        with patch.object(docs_server, "DocumentationServer", observed_server), patch.object(
            sys, "argv", ["docs_server", "--port", "0", "--directory", directory]
        ):
            worker = Thread(target=main, daemon=True)
            worker.start()
            try:
                self.assertTrue(ready.wait(2), "Native documentation CLI did not bind loopback")
                yield servers[0]
            finally:
                if servers:
                    servers[0].shutdown()
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [])

    def test_cli_reuses_one_tcp_socket_with_exact_get_head_redirect_and_304_framing(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            body = b"body { color: #262821; }\n"
            (root / "asset.css").write_bytes(body)
            (root / "nested").mkdir()
            (root / "nested/index.html").write_bytes(b"<h1>Nested guide</h1>")
            with self.running_cli(directory) as server:
                connection = HTTPConnection(*server.server_address, timeout=2)
                try:
                    connection.connect()
                    original_socket = connection.sock
                    connection.request("GET", "/asset.css")
                    response = connection.getresponse()
                    self.assertEqual(response.read(), body)
                    self.assertEqual(response.version, 11, "Asset loads must support persistent HTTP/1.1")
                    self.assertFalse(response.will_close)
                    self.assertEqual(int(response.getheader("Content-Length")), len(body))
                    modified = response.getheader("Last-Modified")
                    requests = [("GET", "/asset.css", {}, 200, body)] * 32 + [
                        ("HEAD", "/asset.css", {}, 200, b""),
                        ("GET", "/nested", {}, 301, b""),
                        ("GET", "/asset.css", {"If-Modified-Since": modified}, 304, b""),
                        ("GET", "/asset.css", {}, 200, body),
                    ]
                    for method, path, headers, status, expected in requests:
                        with self.subTest(method=method, path=path, status=status):
                            connection.request(method, path, headers=headers)
                            response = connection.getresponse()
                            self.assertEqual(response.read(), expected)
                            self.assertEqual(response.status, status)
                            self.assertEqual(response.version, 11)
                            self.assertFalse(response.will_close)
                            self.assertIs(connection.sock, original_socket, "A reconnect must not hide connection churn")
                            if status == 200:
                                self.assertEqual(int(response.getheader("Content-Length")), len(body))
                            elif status == 301:
                                self.assertEqual(response.getheader("Location"), "/nested/")
                                self.assertEqual(response.getheader("Content-Length"), "0")
                    connection.request("GET", "/missing.css")
                    response = connection.getresponse()
                    error_body = response.read()
                    self.assertEqual(response.status, 404)
                    self.assertEqual(int(response.getheader("Content-Length")), len(error_body))
                    self.assertTrue(response.will_close)
                finally:
                    connection.close()

    def test_browser_asset_burst_can_connect_before_accept_resumes(self) -> None:
        clients: list[socket.socket] = []
        failures: list[str] = []
        try:
            with DocumentationServer(("127.0.0.1", 0), SimpleHTTPRequestHandler) as server:
                for _ in range(32):
                    client = socket.socket()
                    clients.append(client)
                    client.settimeout(0.1)
                    try:
                        client.connect(server.server_address)
                    except OSError as error:
                        failures.append(type(error).__name__)
                self.assertEqual(failures, [], "Built pages must admit their asset burst without connection resets")
        finally:
            for client in clients:
                client.close()

    def test_native_handler_serves_exact_assets_and_keeps_missing_assets_missing(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_bytes(b"<h1>Owned documentation</h1>")
            (root / "asset.css").write_bytes(b"body { color: #262821; }")
            with DocumentationServer(
                ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=directory)
            ) as server:
                worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
                worker.start()
                try:
                    for path, status, mime, content in [
                        ("/", 200, "text/html", b"<h1>Owned documentation</h1>"),
                        ("/asset.css", 200, "text/css", b"body { color: #262821; }"),
                        ("/missing.png", 404, "text/html", None),
                    ]:
                        with self.subTest(path=path):
                            connection = HTTPConnection(*server.server_address, timeout=2)
                            try:
                                connection.request("GET", path)
                                response = connection.getresponse()
                                body = response.read()
                                self.assertEqual(response.status, status)
                                self.assertIn(mime, response.getheader("Content-Type"))
                                if content is not None:
                                    self.assertEqual(body, content)
                            finally:
                                connection.close()
                finally:
                    server.shutdown()
                    worker.join(timeout=2)
                    self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
