"""
Pruebas de la exclusion del relay STUN de Raspberry Pi Connect
(rpi/inference_engine.py: RPI_CONNECT_STUN_RELAYS).

Se ejecuta con la biblioteca estandar, sin dependencias:

    python3 -m unittest tests/test_stun_exclusion.py -v

Por que existe: el 2026-08-17 se confirmo en produccion (journalctl + `ss -uap`
identificando el socket de rpi-connectd) que el motor reportaba "ataque" cada
~10-15 min contra trafico STUN real (UDP/3478, 185.101.97.8) que genera el
propio servicio Raspberry Pi Connect de la RPi -- no un ataque. Mismo patron
de fondo que el bug historico "UDP-siempre-ataque": un intercambio STUN son
1-2 paquetes UDP de duracion casi nula, y `rate` se dispara.

El fix NO toca rpi-connectd (el usuario pidio explicitamente no tocarlo) ni
el umbral de deteccion: excluye el trafico por IP conocida, con el MISMO
mecanismo ya usado para el host de la API (`EXCLUDED_NETWORKS`, prefijo /24).
Deliberadamente NO se excluye por puerto UDP/3478 solo -- ver el comentario
de `is_multicast_or_broadcast()`: un allowlist de puerto sin importar el
destino abriria un hueco para un ataque de reflexion STUN real contra otra
IP. Estas pruebas fijan ese comportamiento: el relay conocido se excluye, un
atacante real contra la RPi NO.
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.join(_HERE, os.pardir, "rpi", "inference_engine.py")

_spec = importlib.util.spec_from_file_location("ecosentinel_engine", _ENGINE)
ie = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ie)


class StunRelayExclusionTest(unittest.TestCase):
    def setUp(self):
        self._excluded_antes = set(ie.EXCLUDED_NETWORKS)
        ie.EXCLUDED_NETWORKS.clear()
        ie.add_excluded_prefixes(ie.RPI_CONNECT_STUN_RELAYS)

    def tearDown(self):
        ie.EXCLUDED_NETWORKS.clear()
        ie.EXCLUDED_NETWORKS.update(self._excluded_antes)

    def test_relay_conocido_se_excluye_en_ambas_direcciones(self):
        """Patron real visto en produccion el 2026-08-17 (journalctl)."""
        rpi_a_relay = {"src": "192.168.1.71", "dst": "185.101.97.8"}
        relay_a_rpi = {"src": "185.101.97.8", "dst": "192.168.1.71"}
        self.assertTrue(ie.should_exclude(rpi_a_relay, set()))
        self.assertTrue(ie.should_exclude(relay_a_rpi, set()))

    def test_otra_ip_del_mismo_prefijo_24_tambien_se_excluye(self):
        """Mismo tradeoff aceptado que el host de la API: por prefijo, no por IP suelta."""
        vecino = {"src": "185.101.97.200", "dst": "192.168.1.71"}
        self.assertTrue(ie.should_exclude(vecino, set()))

    def test_un_ataque_real_contra_la_rpi_no_se_excluye(self):
        """La exclusion es especifica del relay conocido, no un agujero general."""
        atacante = {"src": "203.0.113.50", "dst": "192.168.1.71"}
        self.assertFalse(ie.should_exclude(atacante, set()))

    def test_no_es_un_allowlist_de_puerto(self):
        """
        RPI_CONNECT_STUN_RELAYS es un set de IPs, no de puertos: confirma que
        el mecanismo es por IP (in_excluded_network), no por escanear el
        payload buscando el puerto 3478 -- eso si seria un allowlist de
        puerto peligroso (ver docstring de is_multicast_or_broadcast()).
        """
        self.assertNotIn(3478, ie.RPI_CONNECT_STUN_RELAYS)
        for ip in ie.RPI_CONNECT_STUN_RELAYS:
            self.assertTrue(ie.in_excluded_network(ip))


if __name__ == "__main__":
    unittest.main()
