#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Regresion: el hilo emisor NUNCA debe morir por una excepcion al enviar.

Un hilo emisor muerto deja de mandar heartbeats Y detecciones en silencio
(appliance "desconectado", ningun escaneo alerta). Es el fallo del 2026-07-28
(UnboundLocalError, reporte §5.4). Este test fija que aunque _post_json lance
una excepcion inesperada, el worker sigue vivo y procesa el siguiente envio.

Corre sin red ni modelo:  python3 -m unittest tests/test_sender_resilience.py
"""
import os, sys, threading, unittest

# El motor vive en rpi/ (fuera del arbol de tests). Lo importamos por ruta.
RPI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rpi")
sys.path.insert(0, RPI_DIR)
import inference_engine as e  # noqa: E402


class SenderResilienceTest(unittest.TestCase):
    def test_worker_survives_exception_from_post(self):
        calls = []
        done = threading.Event()

        def fake_post(path, payload):
            calls.append(path)
            if len(calls) == 1:
                raise RuntimeError("fallo inesperado simulado (p.ej. DNS raro)")
            if len(calls) == 2:
                done.set()

        e._post_json = fake_post  # inyectamos un _post_json que revienta la 1a vez

        t = threading.Thread(target=e._sender_worker, daemon=True)
        t.start()

        # 1er envio -> lanza excepcion; 2o envio -> debe procesarse igual
        e._send_queue.put(("/api/ingest/detections", {"n": 1}))
        e._send_queue.put(("/api/ingest/heartbeat", {"n": 2}))

        self.assertTrue(done.wait(timeout=5),
                        "el 2o envio no se proceso: el hilo emisor murio con el 1o")
        self.assertTrue(t.is_alive(), "el hilo emisor no debe morir por una excepcion")
        self.assertEqual(calls, ["/api/ingest/detections", "/api/ingest/heartbeat"])


if __name__ == "__main__":
    unittest.main()
