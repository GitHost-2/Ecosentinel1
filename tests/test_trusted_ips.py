"""
Pruebas de parse_trusted_ips() (rpi/inference_engine.py).

Se ejecuta con la biblioteca estandar, sin dependencias:

    python3 -m unittest tests/test_trusted_ips.py -v

Por que importa: la lista de IPs de confianza dejo de vivir en el unit de
systemd (capa SD, cambiarla obliga a remontar y reiniciar) y paso a
ECOSENTINEL_TRUSTED_IPS en `.env.ecosentinel`. Ese archivo lo edita un humano
con prisa antes de una demo, asi que el parseo tiene que aguantar espacios,
comas de mas y erratas SIN degradar el filtro en silencio: una IP mal escrita
que se cuele como "de confianza" no matchea nunca y el sintoma es una lluvia de
falsos positivos del propio canal de administracion.
"""
import importlib.util
import logging
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.join(_HERE, os.pardir, "rpi", "inference_engine.py")

_spec = importlib.util.spec_from_file_location("ecosentinel_engine", _ENGINE)
ie = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ie)


class ParseTrustedIpsTest(unittest.TestCase):
    def test_lista_simple(self):
        self.assertEqual(
            ie.parse_trusted_ips("192.168.1.75,192.168.1.10"),
            {"192.168.1.75", "192.168.1.10"},
        )

    def test_tolera_espacios_y_comas_vacias(self):
        """Formato real de un .env editado a mano antes de la demo."""
        self.assertEqual(
            ie.parse_trusted_ips(" 192.168.1.75 , ,192.168.1.10,"),
            {"192.168.1.75", "192.168.1.10"},
        )

    def test_vacio_y_none_dan_conjunto_vacio(self):
        self.assertEqual(ie.parse_trusted_ips(""), set())
        self.assertEqual(ie.parse_trusted_ips("   "), set())
        self.assertEqual(ie.parse_trusted_ips(None), set())

    def test_descarta_lo_que_no_es_ip_y_conserva_lo_valido(self):
        """Una errata no debe tumbar el resto de la lista."""
        with self.assertLogs(ie.log, level=logging.WARNING) as cap:
            resultado = ie.parse_trusted_ips(
                "192.168.1.75,ecosentinel.local,192.168.1.999,192.168.1.10"
            )
        self.assertEqual(resultado, {"192.168.1.75", "192.168.1.10"})
        # Y lo dice: el fallo silencioso es justo lo que se quiere evitar.
        avisos = "\n".join(cap.output)
        self.assertIn("ecosentinel.local", avisos)
        self.assertIn("192.168.1.999", avisos)

    def test_acepta_ipv6(self):
        self.assertEqual(ie.parse_trusted_ips("fe80::1"), {"fe80::1"})

    def test_flag_y_entorno_se_suman(self):
        """--trusted-ips no pisa a ECOSENTINEL_TRUSTED_IPS: se unen.

        Es como lo combina main(): el entorno lleva la config permanente del
        servicio y el flag anade algo para una corrida puntual.
        """
        del_flag = ie.parse_trusted_ips("10.0.0.5")
        del_entorno = ie.parse_trusted_ips("192.168.1.75,192.168.1.10")
        self.assertEqual(
            del_flag | del_entorno,
            {"10.0.0.5", "192.168.1.75", "192.168.1.10"},
        )

    def test_una_ip_de_confianza_excluye_el_flujo(self):
        """Cierra el circuito: lo parseado es lo que should_exclude() usa."""
        trusted = ie.parse_trusted_ips(" 192.168.1.75 ")
        flujo = {"src": "192.168.1.75", "dst": "192.168.1.71"}
        self.assertTrue(ie.should_exclude(flujo, trusted))
        ajeno = {"src": "192.168.1.99", "dst": "192.168.1.71"}
        self.assertFalse(ie.should_exclude(ajeno, trusted))


if __name__ == "__main__":
    unittest.main()
