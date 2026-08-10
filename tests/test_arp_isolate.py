#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Aislar IP: lo que se puede probar SIN red ni privilegios de root.

Cubre: el mapa efimero hash->IP real (TTL + tope de tamano, la pieza que
hace posible que "Aislar IP" resuelva un hash sin que el backend vea nunca
la IP), la identificacion best-effort del dispositivo, la construccion de
los paquetes ARP de spoofing/restauracion (sin mandarlos), y el ciclo
start/stop de ArpIsolator con un `sender` falso inyectado.

Lo que NO se prueba aqui (a proposito): mandar trafico ARP de verdad
(sendp/srp, exige interfaz real y capacidades de red) y el servidor HTTP
completo end-to-end. Eso es responsabilidad del operador en el laboratorio,
no de una prueba unitaria -- ver 08-Operación/Aislar IP en el laboratorio.md.

Corre sin red ni modelo:  python3 -m unittest tests/test_arp_isolate.py
"""
import os
import sys
import time
import unittest

RPI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rpi")
sys.path.insert(0, RPI_DIR)
import arp_isolate as ai  # noqa: E402


def setUpModule():
    # Ver la nota igual en tests/test_isolate_service.py: el primer import de
    # scapy.all tarda ~1s: se precalienta para que las pruebas con sleeps
    # cortos no dependan del orden en que unittest las ejecute.
    ai.build_arp_reply("aa:aa:aa:aa:aa:aa", "10.0.0.1", "bb:bb:bb:bb:bb:bb", "10.0.0.2")


class IpMemoryTest(unittest.TestCase):
    def test_recuerda_y_resuelve(self):
        m = ai.IpMemory(ttl_seconds=100, max_size=10)
        m.remember("hashA", "192.168.1.50")
        self.assertEqual(m.resolve("hashA"), "192.168.1.50")

    def test_hash_desconocido_devuelve_none(self):
        m = ai.IpMemory(ttl_seconds=100, max_size=10)
        self.assertIsNone(m.resolve("nunca-visto"))

    def test_expira_pasado_el_ttl(self):
        m = ai.IpMemory(ttl_seconds=10, max_size=10)
        t0 = 1_000_000.0
        m.remember("hashA", "192.168.1.50", now=t0)
        # Justo antes del TTL sigue vivo.
        self.assertEqual(m.resolve("hashA", now=t0 + 9), "192.168.1.50")
        # Pasado el TTL, ya no -- y no debe poder "adivinarse" la IP.
        self.assertIsNone(m.resolve("hashA", now=t0 + 11))

    def test_tope_de_tamano_tira_lo_mas_viejo(self):
        m = ai.IpMemory(ttl_seconds=10_000, max_size=3)
        t0 = 1_000_000.0
        m.remember("h1", "10.0.0.1", now=t0)
        m.remember("h2", "10.0.0.2", now=t0 + 1)
        m.remember("h3", "10.0.0.3", now=t0 + 2)
        m.remember("h4", "10.0.0.4", now=t0 + 3)  # deberia tirar h1
        self.assertEqual(len(m), 3)
        self.assertIsNone(m.resolve("h1", now=t0 + 3))
        self.assertEqual(m.resolve("h4", now=t0 + 3), "10.0.0.4")

    def test_purge_expired_cuenta_y_limpia(self):
        m = ai.IpMemory(ttl_seconds=5, max_size=10)
        t0 = 1_000_000.0
        m.remember("viejo", "10.0.0.1", now=t0)
        m.remember("nuevo", "10.0.0.2", now=t0 + 4)
        n = m.purge_expired(now=t0 + 6)
        self.assertEqual(n, 1)
        self.assertEqual(len(m), 1)

    def test_recordar_de_nuevo_refresca_el_ttl(self):
        m = ai.IpMemory(ttl_seconds=10, max_size=10)
        t0 = 1_000_000.0
        m.remember("h1", "10.0.0.1", now=t0)
        m.remember("h1", "10.0.0.1", now=t0 + 8)  # se vuelve a ver el mismo ataque
        # Sin el refresco, a t0+11 ya habria expirado (t0+10). Con el
        # refresco a t0+8, sigue vivo 10s mas.
        self.assertEqual(m.resolve("h1", now=t0 + 11), "10.0.0.1")


class DeviceLabelTest(unittest.TestCase):
    def test_vendor_conocido_por_prefijo_oui(self):
        self.assertEqual(ai.guess_vendor("DC:A6:32:11:22:33"), "Raspberry Pi Foundation")
        self.assertEqual(ai.guess_vendor("dc:a6:32:11:22:33"), "Raspberry Pi Foundation", "no debe importar mayus/minus")

    def test_vendor_desconocido_devuelve_none(self):
        self.assertIsNone(ai.guess_vendor("00:00:00:11:22:33"))

    def test_vendor_sin_mac_devuelve_none(self):
        self.assertIsNone(ai.guess_vendor(None))
        self.assertIsNone(ai.guess_vendor(""))

    def test_label_con_host_y_fabricante(self):
        etiqueta = ai.device_label("192.168.1.50", "DC:A6:32:11:22:33", hostname="atacante-kali")
        self.assertIn("atacante-kali", etiqueta)
        self.assertIn("Raspberry Pi Foundation", etiqueta)
        self.assertIn("DC:A6:32:11:22:33", etiqueta)

    def test_label_sin_nada_no_inventa_datos(self):
        etiqueta = ai.device_label("192.168.1.50", None, hostname=None)
        self.assertIn("no identificado", etiqueta)

    def test_label_solo_fabricante_sin_host(self):
        etiqueta = ai.device_label("192.168.1.50", "DC:A6:32:11:22:33", hostname=None)
        self.assertIn("Raspberry Pi Foundation", etiqueta)
        self.assertNotIn("None", etiqueta, "un hostname ausente no debe colarse como texto")


class GuessHostnameTest(unittest.TestCase):
    def test_usa_el_resolver_inyectado(self):
        self.assertEqual(ai.guess_hostname("192.168.1.50", resolver=lambda ip: "mi-telefono"), "mi-telefono")

    def test_resolver_que_falla_devuelve_none_sin_reventar(self):
        def falla(ip):
            raise OSError("no PTR record")
        self.assertIsNone(ai.guess_hostname("192.168.1.50", resolver=falla))


class DefaultGatewayTest(unittest.TestCase):
    def test_parsea_la_salida_de_ip_route(self):
        salida = "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n"
        gw = ai.get_default_gateway(runner=lambda cmd: salida)
        self.assertEqual(gw, "192.168.1.1")

    def test_sin_ruta_default_devuelve_none(self):
        gw = ai.get_default_gateway(runner=lambda cmd: "")
        self.assertIsNone(gw)

    def test_runner_que_falla_devuelve_none_sin_reventar(self):
        def falla(cmd):
            raise FileNotFoundError("ip: not found")
        self.assertIsNone(ai.get_default_gateway(runner=falla))


class BuildArpReplyTest(unittest.TestCase):
    """Construye el paquete (sin mandarlo) y revisa sus campos -- es la
    parte que se puede verificar sin root ni interfaz real."""

    def test_campos_del_reply(self):
        pkt = ai.build_arp_reply("aa:aa:aa:aa:aa:aa", "192.168.1.1", "bb:bb:bb:bb:bb:bb", "192.168.1.50")
        self.assertEqual(pkt.dst, "bb:bb:bb:bb:bb:bb")
        self.assertEqual(pkt.src, "aa:aa:aa:aa:aa:aa")
        arp = pkt.payload
        self.assertEqual(arp.op, 2, "op=2 es ARP reply, no request")
        self.assertEqual(arp.hwsrc, "aa:aa:aa:aa:aa:aa")
        self.assertEqual(arp.psrc, "192.168.1.1")
        self.assertEqual(arp.hwdst, "bb:bb:bb:bb:bb:bb")
        self.assertEqual(arp.pdst, "192.168.1.50")


class ArpIsolatorTest(unittest.TestCase):
    """Usa un `sender` falso: prueba la MAQUINA DE ESTADOS (que arranca,
    que para, que restaura) sin tocar la red."""

    def test_start_marca_activo_y_manda_paquetes_en_ambas_direcciones(self):
        enviados = []
        iso = ai.ArpIsolator("wlan0", "aa:aa:aa:aa:aa:aa", sender=lambda pkt: enviados.append(pkt))
        iso.REENVIO_SEGUNDOS = 0.05
        iso.start("192.168.1.50", "cc:cc:cc:cc:cc:cc", "192.168.1.1", "dd:dd:dd:dd:dd:dd")
        try:
            time.sleep(0.12)
            self.assertTrue(iso.is_active("192.168.1.50"))
            self.assertGreaterEqual(len(enviados), 2, "debe haber mandado al menos un ciclo (atacante + gateway)")
            destinos = {p.dst for p in enviados}
            self.assertIn("cc:cc:cc:cc:cc:cc", destinos, "debe envenenar al atacante")
            self.assertIn("dd:dd:dd:dd:dd:dd", destinos, "debe envenenar al gateway")
        finally:
            iso.stop("192.168.1.50")

    def test_start_es_idempotente(self):
        enviados = []
        iso = ai.ArpIsolator("wlan0", "aa:aa:aa:aa:aa:aa", sender=lambda pkt: enviados.append(pkt))
        iso.REENVIO_SEGUNDOS = 10
        iso.start("192.168.1.50", "cc:cc:cc:cc:cc:cc", "192.168.1.1", "dd:dd:dd:dd:dd:dd")
        iso.start("192.168.1.50", "cc:cc:cc:cc:cc:cc", "192.168.1.1", "dd:dd:dd:dd:dd:dd")
        self.assertEqual(len(iso.active_targets()), 1, "una segunda llamada no debe abrir un segundo hilo")
        iso.stop("192.168.1.50")

    def test_stop_restaura_el_arp_real_de_ambos_lados(self):
        enviados = []
        iso = ai.ArpIsolator("wlan0", "aa:aa:aa:aa:aa:aa", sender=lambda pkt: enviados.append(pkt))
        iso.REENVIO_SEGUNDOS = 10  # que no mande nada mas durante el test
        iso.start("192.168.1.50", "cc:cc:cc:cc:cc:cc", "192.168.1.1", "dd:dd:dd:dd:dd:dd")
        enviados.clear()

        ok = iso.stop("192.168.1.50", restauros=2)
        self.assertTrue(ok)
        self.assertFalse(iso.is_active("192.168.1.50"))

        # La restauracion debe decirle al atacante la MAC REAL del gateway
        # (dd:...), no la de la RPi -- lo contrario dejaria el corte a medias.
        self.assertTrue(all(p.src == "dd:dd:dd:dd:dd:dd" for p in enviados))
        self.assertTrue(all(p.payload.hwsrc == "dd:dd:dd:dd:dd:dd" for p in enviados))
        self.assertTrue(all(p.dst == "cc:cc:cc:cc:cc:cc" for p in enviados))

    def test_stop_sobre_algo_no_aislado_devuelve_false(self):
        iso = ai.ArpIsolator("wlan0", "aa:aa:aa:aa:aa:aa", sender=lambda pkt: None)
        self.assertFalse(iso.stop("192.168.1.99"))


if __name__ == "__main__":
    unittest.main()
