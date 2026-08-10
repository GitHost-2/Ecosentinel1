"""
EcoSentinel — Aislar IP (corte real por ARP spoofing)

Por que ARP y no otra cosa: la RPi es un cliente WiFi en modo *managed*, no
esta "en linea" en la red (ni router ni switch gestionado) y no puede
enrutar ni dropear el trafico unicast de otros dos dispositivos. El UNICO
mecanismo real desde su posicion para cortar a un objetivo en el mismo
segmento L2 es enviarle respuestas ARP falsas -- "is-at" con la MAC de la
RPi para la IP del gateway -- de forma que el trafico del atacante hacia el
resto de la red termine en la RPi (que no reenvia nada) y se pierda ahi.
Es uso de laboratorio autorizado sobre equipos y red propios.

Privacidad (ver Zero cloud / local privacy en la boveda del proyecto): la IP
real de un atacante SOLO existe aqui, en memoria del proceso de la RPi, y
solo durante una ventana corta (IpMemory). El backend nunca la recibe -- solo
el hash que ya calcula hash_ip() en inference_engine.py.

Este modulo separa a proposito la logica PURA (mapa acotado, adivinar
fabricante/hostname, construccion de paquetes) de la parte que de verdad
manda trafico (sendp/srp, que exige root y una interfaz real) para poder
probar la primera sin red ni privilegios.
"""
import re
import socket
import subprocess
import threading
import time
from pathlib import Path


# ──────────────────────────────────────────────────────────────
# Mapa local efimero: hash -> IP real
# ──────────────────────────────────────────────────────────────
class IpMemory:
    """Recuerda, por un tiempo corto y acotado, que IP real corresponde a
    cada hash que este mismo proceso ya calculo (ver hash_ip() en
    inference_engine.py). Es la UNICA forma en que "Aislar IP" puede
    resolver el hash que manda el backend a una IP real -- si ya no esta
    aqui (paso el TTL, o el servicio se reinicio), la orden no se puede
    cumplir y se reporta 'failed', nunca se inventa la IP.

    Acotado en tamano Y en tiempo a proposito: esto es memoria de trabajo
    para "Aislar IP", no un log ni una base de datos de trafico.
    """

    def __init__(self, ttl_seconds=900, max_size=500):
        self.ttl_seconds = ttl_seconds
        self.max_size = max_size
        self._store = {}  # hash -> (ip, ts)
        self._lock = threading.Lock()

    def remember(self, ip_hash, real_ip, now=None):
        now = now if now is not None else time.time()
        with self._lock:
            self._store[ip_hash] = (real_ip, now)
            if len(self._store) > self.max_size:
                self._evict_oldest_locked()

    def resolve(self, ip_hash, now=None):
        now = now if now is not None else time.time()
        with self._lock:
            entry = self._store.get(ip_hash)
            if entry is None:
                return None
            ip, ts = entry
            if now - ts > self.ttl_seconds:
                del self._store[ip_hash]
                return None
            return ip

    def purge_expired(self, now=None):
        now = now if now is not None else time.time()
        with self._lock:
            vencidos = [h for h, (_, ts) in self._store.items() if now - ts > self.ttl_seconds]
            for h in vencidos:
                del self._store[h]
            return len(vencidos)

    def _evict_oldest_locked(self):
        # Ya se llama con el lock tomado (remember()). Se tira el mas viejo
        # de uno en uno porque solo se pasa del tope de a un elemento a la vez.
        oldest_hash = min(self._store, key=lambda h: self._store[h][1])
        del self._store[oldest_hash]

    def __len__(self):
        with self._lock:
            return len(self._store)


# ──────────────────────────────────────────────────────────────
# Identificar el dispositivo (mejor esfuerzo, para la confirmacion humana)
# ──────────────────────────────────────────────────────────────

# Prefijos OUI (los 3 primeros octetos de la MAC) de fabricantes comunes en
# una red domestica/PyME. Lista corta a proposito -- no pretende ser
# exhaustiva, solo dar una pista razonable en la pantalla de confirmacion.
# Si el prefijo no esta aqui, se muestra "fabricante desconocido": nunca se
# inventa un nombre.
OUI_VENDORS = {
    "DC:A6:32": "Raspberry Pi Foundation", "B8:27:EB": "Raspberry Pi Foundation",
    "E4:5F:01": "Raspberry Pi Foundation", "28:CD:C1": "Raspberry Pi Foundation",
    "00:1A:11": "Google", "F4:F5:D8": "Google", "3C:5A:B4": "Google",
    "A4:77:33": "Apple", "F0:18:98": "Apple", "3C:15:C2": "Apple",
    "AC:DE:48": "Apple", "70:56:81": "Apple", "D0:81:7A": "Apple",
    "5C:F9:38": "Samsung", "8C:79:F5": "Samsung", "E8:50:8B": "Samsung",
    "18:FE:34": "Espressif (ESP8266/ESP32, IoT)", "24:6F:28": "Espressif (ESP8266/ESP32, IoT)",
    "AC:67:B2": "Espressif (ESP8266/ESP32, IoT)", "84:F3:EB": "Espressif (ESP8266/ESP32, IoT)",
    "50:C7:BF": "TP-Link", "F4:F2:6D": "TP-Link", "AC:84:C6": "TP-Link",
    "FC:A6:67": "Xiaomi", "78:11:DC": "Xiaomi", "34:CE:00": "Xiaomi",
    "FC:FC:48": "Huawei", "00:E0:FC": "Huawei",
    "44:65:0D": "Amazon (Echo/Fire/IoT)", "68:37:E9": "Amazon (Echo/Fire/IoT)",
    "00:1B:63": "Microsoft", "00:50:F2": "Microsoft",
    "B0:BE:76": "Intel", "00:1B:21": "Intel",
}


def guess_vendor(mac):
    """Fabricante probable por el prefijo OUI de la MAC, o None si no esta
    en la tabla."""
    if not mac:
        return None
    prefix = mac.upper().replace("-", ":")[:8]
    return OUI_VENDORS.get(prefix)


def guess_hostname(ip, resolver=None):
    """Nombre de host por PTR inverso, o None si no resuelve. `resolver` es
    inyectable para pruebas (por defecto socket.gethostbyaddr, que hace red)."""
    resolver = resolver or (lambda addr: socket.gethostbyaddr(addr)[0])
    try:
        return resolver(ip)
    except Exception:
        return None


def device_label(ip, mac, hostname=None):
    """Descripcion humana para la pantalla de confirmacion: '<host o
    generico> (<fabricante>) - MAC <mac>'. Nunca inventa datos: lo que no
    se pudo averiguar simplemente no aparece."""
    vendor = guess_vendor(mac)
    partes = []
    if hostname:
        partes.append(hostname)
    if vendor:
        partes.append(f"({vendor})")
    if not partes:
        partes.append("dispositivo no identificado")
    etiqueta = " ".join(partes)
    if mac:
        etiqueta += f" — MAC {mac}"
    return etiqueta


# ──────────────────────────────────────────────────────────────
# ARP: resolver MACs y construir los paquetes de spoofing
# ──────────────────────────────────────────────────────────────

def own_mac(iface):
    """MAC de la propia interfaz, leida del sistema (sin scapy, sin red)."""
    path = Path(f"/sys/class/net/{iface}/address")
    return path.read_text().strip()


_MAC_RE = re.compile(r"([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})")


def mac_from_neighbor_table(ip, iface=None):
    """MAC de `ip` segun la tabla ARP del kernel (`ip neigh`), sin mandar
    trafico. Devuelve None si no hay entrada (aun no se resolvio, o el host
    no esta en la red)."""
    try:
        cmd = ["ip", "neigh", "show"] + (["dev", iface] if iface else [])
        salida = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return None
    for linea in salida.splitlines():
        if linea.startswith(ip + " ") or linea.startswith(ip + "\t"):
            m = _MAC_RE.search(linea)
            if m:
                return m.group(1)
    return None


def get_default_gateway(iface=None, runner=None):
    """IP del gateway por defecto, leida de `ip route show default` (sin
    mandar trafico). `runner` es inyectable para pruebas."""
    runner = runner or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout)
    cmd = ["ip", "route", "show", "default"] + (["dev", iface] if iface else [])
    try:
        salida = runner(cmd)
    except Exception:
        return None
    m = re.search(r"default via (\d+\.\d+\.\d+\.\d+)", salida)
    return m.group(1) if m else None


def resolve_mac_active(ip, iface, timeout=2):
    """Igual que mac_from_neighbor_table pero SI manda un ARP request (para
    cuando el kernel todavia no tiene la entrada en cache). Requiere
    privilegios de socket crudo -- se usa solo como respaldo."""
    try:
        from scapy.all import srp, Ether, ARP
        respuestas, _ = srp(
            Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=ip),
            timeout=timeout, iface=iface, verbose=False,
        )
        if respuestas:
            return respuestas[0][1].hwsrc
    except Exception:
        pass
    return None


def resolve_mac(ip, iface):
    """MAC de `ip`: primero la cache del kernel (gratis), si no un ARP
    request activo (respaldo, manda trafico)."""
    return mac_from_neighbor_table(ip, iface) or resolve_mac_active(ip, iface)


def build_arp_reply(src_mac, src_ip, dst_mac, dst_ip):
    """Construye (sin enviar) un ARP reply 'is-at src_mac for src_ip',
    dirigido a dst_mac/dst_ip. Separado de sendp() para poder probarlo sin
    root ni interfaz real."""
    from scapy.all import Ether, ARP

    return (
        Ether(src=src_mac, dst=dst_mac)
        / ARP(op=2, hwsrc=src_mac, psrc=src_ip, hwdst=dst_mac, pdst=dst_ip)
    )


class ArpIsolator:
    """Ejecuta y revierte el corte de UN atacante contra el gateway.

    Envenena en las DOS direcciones para bloquear trafico en ambos sentidos:
      - al atacante le dice "el gateway esta en mi MAC"
      - al gateway le dice "el atacante esta en mi MAC"
    La RPi no reenvia nada (no hace IP forwarding), asi que lo que le llega
    ahi se pierde -- es el "agujero negro" que corta la conectividad.

    `iface` y las MACs/IPs reales de atacante y gateway se resuelven ANTES
    de arrancar (fuera de esta clase), porque resolverlas es lo unico que
    requiere tocar la red de verdad.
    """

    REENVIO_SEGUNDOS = 2.0

    def __init__(self, iface, own_mac_addr, sender=None):
        self.iface = iface
        self.own_mac = own_mac_addr
        # Inyectable para pruebas: por defecto scapy.sendp (manda de verdad).
        self._sender = sender
        self._threads = {}  # target_ip -> (stop_event, thread)

    def _real_sender(self, pkt):
        from scapy.all import sendp
        sendp(pkt, iface=self.iface, verbose=False)

    def _enviar(self, pkt):
        (self._sender or self._real_sender)(pkt)

    def start(self, target_ip, target_mac, gateway_ip, gateway_mac):
        if target_ip in self._threads:
            return  # ya aislado; idempotente
        stop_event = threading.Event()

        def _loop():
            while not stop_event.is_set():
                self._enviar(build_arp_reply(self.own_mac, gateway_ip, target_mac, target_ip))
                self._enviar(build_arp_reply(self.own_mac, target_ip, gateway_mac, gateway_ip))
                stop_event.wait(self.REENVIO_SEGUNDOS)

        t = threading.Thread(target=_loop, daemon=True)
        self._threads[target_ip] = (stop_event, t, target_mac, gateway_ip, gateway_mac)
        t.start()

    def stop(self, target_ip, restauros=3):
        entrada = self._threads.pop(target_ip, None)
        if not entrada:
            return False
        stop_event, _thread, target_mac, gateway_ip, gateway_mac = entrada
        stop_event.set()
        # Corrige el cache ARP real de ambos lados varias veces: una sola
        # respuesta se puede perder, y hasta que expire sola (segundos a
        # minutos segun el sistema operativo) el objetivo seguiria cortado.
        for _ in range(restauros):
            self._enviar(build_arp_reply(gateway_mac, gateway_ip, target_mac, target_ip))
            time.sleep(0.2)
        return True

    def is_active(self, target_ip):
        return target_ip in self._threads

    def active_targets(self):
        return list(self._threads.keys())
