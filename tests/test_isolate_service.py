#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IsolateService: la coordinacion entre el sondeo al backend, el mapa local
de IPs y ArpIsolator -- sin red real (se falsea `_get_pending_orders` y el
`sender` de ArpIsolator) y sin tocar el backend real de EcoSentinel.

Tambien cubre el panel HTTP local: que el token proteja el acceso (LAN-only
no es "sin autenticacion" -- cualquiera en la misma red podria pedir el
panel si no llevara token).

Corre sin red, sin root y sin Postgres:
  python3 -m unittest tests/test_isolate_service.py
"""
import http.client
import os
import sys
import time
import unittest
import urllib.request

RPI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rpi")
sys.path.insert(0, RPI_DIR)
import arp_isolate as ai  # noqa: E402
import isolate_server as iso_mod  # noqa: E402


def setUpModule():
    # `from scapy.all import ...` (dentro de build_arp_reply) tarda ~1s la
    # PRIMERA vez que se importa en el proceso -- en producción ese costo ya
    # se pagó antes de que exista cualquier aislamiento (run_live() importa
    # scapy para el sniff en cuanto arranca). Se precalienta aquí para que
    # las aserciones de tiempo no dependan de ese costo de arranque.
    ai.build_arp_reply("aa:aa:aa:aa:aa:aa", "10.0.0.1", "bb:bb:bb:bb:bb:bb", "10.0.0.2")


def _servicio_de_prueba(pending_por_llamada=None):
    """IsolateService con iface=None (evita tocar /sys y `ip route`) y con
    gateway/MAC propia inyectados a mano para poder probar el camino feliz."""
    ack_calls = []
    svc = iso_mod.IsolateService(
        iface=None, api_url="http://backend-de-prueba.invalido", api_key="k",
        ip_memory=ai.IpMemory(ttl_seconds=900, max_size=10),
        enqueue_ack=lambda path, payload: ack_calls.append((path, payload)),
        token="test-token",
    )
    svc.own_mac = "aa:aa:aa:aa:aa:aa"
    svc.gateway_ip = "192.168.1.1"
    enviados = []
    svc.isolator = ai.ArpIsolator("wlan0-test", svc.own_mac, sender=lambda pkt: enviados.append(pkt))
    svc.isolator.REENVIO_SEGUNDOS = 10  # no reenviar de mas durante el test

    if pending_por_llamada is not None:
        it = iter(pending_por_llamada)
        iso_mod._get_pending_orders = lambda api_url, api_key, timeout=5: next(it, [])

    return svc, ack_calls, enviados


class HandleIsolateRequestTest(unittest.TestCase):
    def setUp(self):
        self._orig_resolve_mac = iso_mod.resolve_mac
        self._orig_guess_hostname = iso_mod.guess_hostname

    def tearDown(self):
        iso_mod.resolve_mac = self._orig_resolve_mac
        iso_mod.guess_hostname = self._orig_guess_hostname

    def test_hash_fuera_del_mapa_local_falla_sin_inventar_ip(self):
        svc, acks, _ = _servicio_de_prueba()
        svc._handle_isolate_request(order_id=1, ip_hash="hash-nunca-visto")
        self.assertEqual(len(acks), 1)
        path, payload = acks[0]
        self.assertEqual(path, "/api/mitigate/ack")
        self.assertEqual(payload["applied"], "failed")
        self.assertIn("mapa local", payload["note"])
        self.assertEqual(svc.pending_snapshot(), {})

    def test_hash_resuelto_pero_sin_mac_falla(self):
        svc, acks, _ = _servicio_de_prueba()
        svc.ip_memory.remember("h1", "192.168.1.50")
        iso_mod.resolve_mac = lambda ip, iface: None
        svc._handle_isolate_request(order_id=2, ip_hash="h1")
        self.assertEqual(acks[-1][1]["applied"], "failed")
        self.assertIn("MAC", acks[-1][1]["note"])

    def test_resolucion_completa_queda_pendiente_de_confirmar(self):
        svc, acks, _ = _servicio_de_prueba()
        svc.ip_memory.remember("h1", "192.168.1.50")
        iso_mod.resolve_mac = lambda ip, iface: "cc:cc:cc:cc:cc:cc"
        iso_mod.guess_hostname = lambda ip: "telefono-de-juan"

        svc._handle_isolate_request(order_id=3, ip_hash="h1")

        self.assertEqual(acks, [], "no debe confirmar NADA todavia -- falta la confirmacion humana")
        pendientes = svc.pending_snapshot()
        self.assertIn(3, pendientes)
        self.assertEqual(pendientes[3]["ip"], "192.168.1.50")
        self.assertIn("telefono-de-juan", pendientes[3]["label"])

    def test_misma_orden_dos_veces_no_se_duplica(self):
        svc, _, _ = _servicio_de_prueba()
        svc.ip_memory.remember("h1", "192.168.1.50")
        iso_mod.resolve_mac = lambda ip, iface: "cc:cc:cc:cc:cc:cc"
        iso_mod.guess_hostname = lambda ip: None

        svc._handle_isolate_request(order_id=5, ip_hash="h1")
        svc._handle_isolate_request(order_id=5, ip_hash="h1")
        self.assertEqual(len(svc.pending_snapshot()), 1)


class ConfirmTest(unittest.TestCase):
    def setUp(self):
        self._orig_resolve_mac = iso_mod.resolve_mac

    def tearDown(self):
        iso_mod.resolve_mac = self._orig_resolve_mac

    def test_confirmar_ejecuta_el_aislamiento_y_confirma_isolated(self):
        svc, acks, enviados = _servicio_de_prueba()
        svc.ip_memory.remember("h1", "192.168.1.50")
        iso_mod.resolve_mac = lambda ip, iface: (
            "cc:cc:cc:cc:cc:cc" if ip == "192.168.1.50" else "dd:dd:dd:dd:dd:dd"
        )
        svc._handle_isolate_request(order_id=9, ip_hash="h1")

        ok, resultado = svc.confirm(9)
        time.sleep(0.1)  # el primer envio ocurre en el hilo de ArpIsolator

        self.assertTrue(ok)
        self.assertTrue(svc.isolator.is_active("192.168.1.50"))
        self.assertGreaterEqual(len(enviados), 2, "debe haber mandado ARP a ambos lados")
        self.assertEqual(acks[-1], ("/api/mitigate/ack", {"orderId": 9, "applied": "isolated"}))
        self.assertIn("h1", svc.active_snapshot())

    def test_confirmar_una_orden_que_ya_no_esta_pendiente_no_hace_nada(self):
        svc, acks, enviados = _servicio_de_prueba()
        ok, motivo = svc.confirm(999)
        self.assertFalse(ok)
        self.assertEqual(acks, [])
        self.assertEqual(enviados, [])

    def test_confirmar_dos_veces_la_misma_orden_la_segunda_no_hace_nada(self):
        svc, acks, _ = _servicio_de_prueba()
        svc.ip_memory.remember("h1", "192.168.1.50")
        iso_mod.resolve_mac = lambda ip, iface: "cc:cc:cc:cc:cc:cc"
        svc._handle_isolate_request(order_id=9, ip_hash="h1")

        ok1, _ = svc.confirm(9)
        n_acks_tras_primera = len(acks)
        ok2, _ = svc.confirm(9)

        self.assertTrue(ok1)
        self.assertFalse(ok2, "la orden ya se saco de pendientes en la primera confirmacion")
        self.assertEqual(len(acks), n_acks_tras_primera, "la segunda llamada no debe volver a confirmar")


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self._orig_resolve_mac = iso_mod.resolve_mac

    def tearDown(self):
        iso_mod.resolve_mac = self._orig_resolve_mac

    def _aislar(self, svc):
        svc.ip_memory.remember("h1", "192.168.1.50")
        iso_mod.resolve_mac = lambda ip, iface: "cc:cc:cc:cc:cc:cc" if ip == "192.168.1.50" else "dd:dd:dd:dd:dd:dd"
        svc._handle_isolate_request(order_id=1, ip_hash="h1")
        svc.confirm(1)

    def test_release_request_sin_aislamiento_activo_reporta_released_igual(self):
        svc, acks, _ = _servicio_de_prueba()
        svc._handle_release_request(order_id=2, ip_hash="hash-que-nunca-se-aislo")
        self.assertEqual(acks[-1][1]["applied"], "released")
        self.assertIsNotNone(acks[-1][1].get("note"))

    def test_release_request_NO_requiere_confirmacion_humana(self):
        # A diferencia de aislar, liberar se ejecuta directo al verlo en el
        # sondeo -- es la unica asimetria a proposito del diseño (ver
        # docstring del modulo).
        svc, acks, _ = _servicio_de_prueba()
        self._aislar(svc)
        acks.clear()

        svc._handle_release_request(order_id=10, ip_hash="h1")

        self.assertFalse(svc.isolator.is_active("192.168.1.50"))
        self.assertEqual(acks[-1], ("/api/mitigate/ack", {"orderId": 10, "applied": "released"}))
        self.assertNotIn("h1", svc.active_snapshot())

    def test_manual_release_desde_el_panel_local(self):
        svc, acks, _ = _servicio_de_prueba()
        self._aislar(svc)
        acks.clear()

        ok = svc.manual_release("192.168.1.50")

        self.assertTrue(ok)
        self.assertFalse(svc.isolator.is_active("192.168.1.50"))
        self.assertEqual(acks[-1][1]["applied"], "released")

    def test_manual_release_de_algo_no_aislado_devuelve_false(self):
        svc, acks, _ = _servicio_de_prueba()
        self.assertFalse(svc.manual_release("10.10.10.10"))
        self.assertEqual(acks, [])


class PollOnceTest(unittest.TestCase):
    def setUp(self):
        self._orig_get_pending = iso_mod._get_pending_orders

    def tearDown(self):
        iso_mod._get_pending_orders = self._orig_get_pending

    def test_backend_inalcanzable_no_revienta(self):
        svc, acks, _ = _servicio_de_prueba(pending_por_llamada=[None])
        svc.poll_once()  # no debe lanzar
        self.assertEqual(acks, [])

    def test_una_orden_isolated_y_otra_released_se_procesan_distinto(self):
        svc, acks, _ = _servicio_de_prueba()
        svc.ip_memory.remember("h-nueva", "192.168.1.60")
        orig_resolve_mac = iso_mod.resolve_mac
        iso_mod.resolve_mac = lambda ip, iface: "cc:cc:cc:cc:cc:cc"
        self.addCleanup(lambda: setattr(iso_mod, "resolve_mac", orig_resolve_mac))
        iso_mod._get_pending_orders = lambda api_url, api_key, timeout=5: [
            {"orderId": 1, "srcIpHash": "h-nueva", "desired": "isolated"},
            {"orderId": 2, "srcIpHash": "hash-que-no-existe", "desired": "released"},
        ]
        svc.poll_once()

        self.assertIn(1, svc.pending_snapshot(), "isolated: queda esperando confirmacion humana")
        self.assertTrue(any(p == "/api/mitigate/ack" and b["orderId"] == 2 for p, b in acks),
                         "released: se resuelve sola, sin esperar al operador")


class TokenAuthHttpTest(unittest.TestCase):
    """El panel local es la unica ventana a la IP real -- debe exigir el
    token aunque solo sea alcanzable desde la LAN."""

    @classmethod
    def setUpClass(cls):
        cls.svc, cls.acks, _ = _servicio_de_prueba()
        cls.httpd = iso_mod.start_isolate_server(cls.svc, port=0)
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_sin_token_responde_401(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request("GET", "/")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 401)

    def test_token_incorrecto_responde_401(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request("GET", "/?token=lo-que-sea")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 401)

    def test_token_correcto_responde_200_con_el_panel(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/?token=test-token", timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            cuerpo = resp.read().decode("utf-8")
            self.assertIn("EcoSentinel", cuerpo)
            self.assertIn("Sin solicitudes pendientes", cuerpo)


if __name__ == "__main__":
    unittest.main()
