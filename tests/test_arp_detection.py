"""
Pruebas de la deteccion de barridos ARP (rpi/inference_engine.py).

Se ejecuta con la biblioteca estandar, sin dependencias:

    python3 -m unittest tests/test_arp_detection.py -v

No forma parte de `npm test` (ese runner solo toma tests/*.test.ts): esta
funcion es Python y corre en la RPi, no en Vercel. track_arp_request() se diseno
"puro salvo por el diccionario de estado" precisamente para poder probarla sin
red ni scapy.
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.join(_HERE, os.pardir, "rpi", "inference_engine.py")

_spec = importlib.util.spec_from_file_location("ecosentinel_engine", _ENGINE)
ie = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ie)


class TrackArpRequestTest(unittest.TestCase):
    def setUp(self):
        # Estado global limpio antes de cada prueba: el diccionario de actividad
        # y el conjunto de prefijos excluidos.
        ie._arp_activity.clear()
        self._saved_excluded = set(ie.EXCLUDED_NETWORKS)
        ie.EXCLUDED_NETWORKS.clear()

    def tearDown(self):
        ie._arp_activity.clear()
        ie.EXCLUDED_NETWORKS.clear()
        ie.EXCLUDED_NETWORKS.update(self._saved_excluded)

    def test_por_debajo_del_umbral_no_alerta(self):
        """Menos de ARP_SCAN_THRESHOLD objetivos distintos -> None."""
        src = "192.168.1.50"
        t = 1000.0
        for i in range(ie.ARP_SCAN_THRESHOLD - 1):
            resultado = ie.track_arp_request(src, f"192.168.1.{i}", t)
            self.assertIsNone(resultado)

    def test_cruzar_el_umbral_devuelve_el_conteo(self):
        """Al llegar al objetivo distinto numero ARP_SCAN_THRESHOLD -> devuelve n."""
        src = "192.168.1.50"
        t = 1000.0
        resultado = None
        for i in range(ie.ARP_SCAN_THRESHOLD):
            resultado = ie.track_arp_request(src, f"10.0.0.{i}", t)
        self.assertEqual(resultado, ie.ARP_SCAN_THRESHOLD)

    def test_ips_repetidas_no_inflan_el_conteo(self):
        """Preguntar 100 veces por la MISMA IP no es un barrido."""
        src = "192.168.1.50"
        t = 1000.0
        resultado = None
        for _ in range(100):
            resultado = ie.track_arp_request(src, "192.168.1.1", t)
        self.assertIsNone(resultado)

    def test_trusted_ips_match_exacto_se_excluye(self):
        """La laptop de admin en --trusted-ips nunca dispara barrido."""
        src = "192.168.1.75"
        trusted = {"192.168.1.75"}
        t = 1000.0
        resultado = None
        for i in range(ie.ARP_SCAN_THRESHOLD + 5):
            resultado = ie.track_arp_request(src, f"10.0.0.{i}", t, trusted)
        self.assertIsNone(resultado)

    def test_in_excluded_network_excluye_mas_alla_del_match_exacto(self):
        """
        Un origen dentro de un prefijo excluido (p.ej. el gateway/infra de
        confianza) NO debe generar barrido, aunque NO este en --trusted-ips por
        match exacto. Mirror de should_exclude(): la regresion que este test
        protege es que la exclusion vuelva a ser solo `src_ip in trusted_ips`.
        """
        import ipaddress
        ie.EXCLUDED_NETWORKS.add(ipaddress.ip_network("192.168.1.0/24"))
        src = "192.168.1.1"  # gateway: NO esta en trusted_ips
        t = 1000.0
        resultado = None
        for i in range(ie.ARP_SCAN_THRESHOLD + 5):
            resultado = ie.track_arp_request(src, f"10.0.0.{i}", t, trusted_ips=set())
        self.assertIsNone(resultado)

    def test_cooldown_evita_realertar(self):
        """Tras alertar, no se vuelve a alertar dentro de ARP_ALERT_COOLDOWN."""
        src = "192.168.1.50"
        t = 1000.0
        primera = None
        for i in range(ie.ARP_SCAN_THRESHOLD):
            primera = ie.track_arp_request(src, f"10.0.0.{i}", t)
        self.assertEqual(primera, ie.ARP_SCAN_THRESHOLD)
        # Un objetivo distinto mas en el MISMO instante: el umbral sigue cubierto
        # (21 >= 20) pero el cooldown esta activo -> no realerta.
        repetida = ie.track_arp_request(src, "10.0.9.9", t)
        self.assertIsNone(repetida)
        # Pasado el cooldown, una rafaga fresca de objetivos distintos (la ventana
        # de 60s ya expiro los originales) vuelve a alertar.
        t2 = t + ie.ARP_ALERT_COOLDOWN + 1
        tras_cooldown = None
        for i in range(ie.ARP_SCAN_THRESHOLD):
            tras_cooldown = ie.track_arp_request(src, f"172.16.0.{i}", t2)
        self.assertEqual(tras_cooldown, ie.ARP_SCAN_THRESHOLD)

    def test_ventana_deslizante_expira_objetivos_viejos(self):
        """Objetivos mas viejos que ARP_SCAN_WINDOW no cuentan para el umbral."""
        src = "192.168.1.50"
        t0 = 1000.0
        # Casi umbral (uno menos) en t0.
        for i in range(ie.ARP_SCAN_THRESHOLD - 1):
            self.assertIsNone(ie.track_arp_request(src, f"10.0.0.{i}", t0))
        # Muy despues: los viejos ya expiraron, este objetivo unico no alerta.
        tarde = t0 + ie.ARP_SCAN_WINDOW + 10
        resultado = ie.track_arp_request(src, "10.0.9.9", tarde)
        self.assertIsNone(resultado)


if __name__ == "__main__":
    unittest.main()
