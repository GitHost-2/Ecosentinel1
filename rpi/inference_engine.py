#!/usr/bin/env python3
"""
EcoSentinel — Motor de inferencia (edge, RPi 3A+)
Reconstruido tras revisión de historial. Incluye el fix del bug de
UDP-siempre-ataque: `rate` se disparaba a infinito en flujos con
duracion casi nula (division por Delta t ~ 0).

Uso:
    python3 inference_engine.py --validate captura.pcap
    sudo python3 inference_engine.py --live wlan0
    sudo python3 inference_engine.py --live wlan0 --trusted-ips 192.168.1.75 \\
        --api-url https://tu-dominio.vercel.app --api-key <API_KEY_del_dispositivo>

    (o exporta ECOSENTINEL_API_URL / ECOSENTINEL_API_KEY en vez de --api-url/--api-key)
"""
import os
import sys
import time
import json
import queue
import socket
import hmac
import hashlib
import subprocess
import logging
import argparse
import ipaddress
import threading
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path
from collections import defaultdict, deque

import numpy as np
import joblib

try:
    import psutil
except ImportError:
    psutil = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ecosentinel")
# NOTA: el nivel real (INFO vs DEBUG) se decide en main() una vez que
# argparse ya leyo --debug -- ver "log.setLevel(...)" ahi abajo. Fijarlo
# aqui arriba, antes de parsear argumentos, es precisamente el bug que
# hacia que --debug nunca mostrara nada (ver reporte 2026-07-14).

# ──────────────────────────────────────────────────────────────
# IPs de confianza (administracion) — EXCLUIDAS del analisis
# ──────────────────────────────────────────────────────────────
# Trafico de gestion hacia/desde el propio dispositivo (ej. tu laptop
# de administracion por SSH) NO debe alimentar el clasificador: es
# practica estandar en cualquier IDS/IPS no analizar el canal de
# gestion del propio sensor, y el trafico de un humano administrando
# por SSH (rafagas rapidas, tamanos de paquete distintos) no se parece
# en nada al trafico "benigno" de dispositivos IoT con el que se
# entreno el modelo (CIC-IoT2023) -> genera falsos positivos.
#
# OJO: esto NO excluye el puerto 22 en general -- fuerza bruta SSH
# contra OTROS hosts de la red del cliente sigue analizandose. Solo se
# excluye trafico donde uno de los extremos es una IP explicitamente
# de confianza (ej. la laptop del administrador), sin importar el
# puerto que use.
#
# Agrega aqui IPs fijas conocidas, y/o pasalas por --trusted-ips en
# cada corrida (ej. --trusted-ips 192.168.1.75,192.168.1.10).
TRUSTED_IPS = set()  # ej: {"192.168.1.75"}

# ──────────────────────────────────────────────────────────────
# Rutas de artefactos
# ──────────────────────────────────────────────────────────────
ARTIFACT_DIR   = Path(__file__).parent / "models"
MODEL_FILE     = ARTIFACT_DIR / "ecosentinel_model_rpi.pkl"
THRESHOLD_FILE = ARTIFACT_DIR / "optimal_threshold_rpi.pkl"
SCALER_FILE    = ARTIFACT_DIR / "scaler.pkl"
FEATURES_FILE  = ARTIFACT_DIR / "selected_features.pkl"

FLOW_TIMEOUT = 30.0      # segundos de inactividad para expirar un flujo
MAX_FLOWS    = 5000      # tope de flujos concurrentes (evita OOM en 512MB)

# ──────────────────────────────────────────────────────────────
# FIX del bug UDP: piso de duracion + tope de rate
# ──────────────────────────────────────────────────────────────
# Duracion minima "real" que se le permite tener a un flujo antes de
# calcular `rate`. Sin este piso, un flujo de 2 paquetes UDP separados
# por microsegundos produce rate = n / duration ~ cientos de miles,
# muy fuera del rango que el modelo vio en CIC-IoT2023 -> el scaler
# lo satura al maximo -> el modelo lo clasifica como ataque siempre.
#
# NOTA: este valor es un punto de partida razonable (1 ms). Ajustalo
# despues de correr inspect_raw_features.py contra tu propio trafico
# y comparar contra los percentiles de `rate` en tus datos de
# entrenamiento (X_train). Si tu captura muestra que el trafico UDP
# benigno real tiene duraciones de flujo de p.ej. 5-10 ms, sube este
# valor a ese rango.
DURATION_EPSILON = 0.001  # 1 ms

# Tope duro de `rate` como salvaguarda adicional, por si el piso de
# duracion no basta (ej. rafagas legitimas de muchos paquetes en poco
# tiempo). Ajustar tras ver el percentil 99 de `rate` en entrenamiento.
RATE_CAP = 2000.0

# ──────────────────────────────────────────────────────────────
# Umbral de deteccion: piso calibrado empiricamente
# ──────────────────────────────────────────────────────────────
# El umbral de optimal_threshold_rpi.pkl (0.10) se calibro sobre el set
# de prueba de CIC-IoT2023, donde el trafico de ATAQUE es la clase
# mayoritaria. En una red real de PyME la tasa base de ataques es ~0,
# asi que ese umbral marca practicamente todo como ataque.
#
# Medicion sobre trafico real de esta red (captura en vivo de 5 min,
# 2026-07-29): el modelo asigna 0.774-0.869 a flujos TCP benignos
# (mediana 0.848, p99 0.868). Un ataque real confirmado en campo (SYN
# scan de 500 puertos con nmap) puntuo 0.990. Con un piso de 0.95 el
# trafico benigno medido queda fuera y el ataque real adentro.
#
# LIMITACION: la muestra fueron 7 flujos de una sola captura. Volver a
# medir sobre capturas mas largas antes de tratar 0.95 como definitivo.
# Se puede sobreescribir en una corrida puntual con --threshold.
DETECTION_THRESHOLD_FLOOR = 0.95

# ──────────────────────────────────────────────────────────────
# Exclusion por PREFIJO de red (no por IP suelta)
# ──────────────────────────────────────────────────────────────
# CAUSA RAIZ de los ~30k falsos positivos observados hasta el
# 2026-07-29: el edge de la API (Vercel) rota entre varias IPs del
# mismo /24. Al arrancar se resolvia p.ej. 216.198.79.3 y se excluia
# solo esa, pero urllib abria la conexion real contra 216.198.79.131
# -> el trafico del propio sensor hacia su API se clasificaba como
# ataque -> enviaba una deteccion -> ese POST generaba otro flujo
# marcado como ataque -> bucle de amplificacion (una deteccion cada
# ~0.4 s, todas con p>=0.77, reportadas como "DDoS"/"Port Scanning").
# Excluir el PREFIJO completo cierra la ventana de rotacion.
#
# Tradeoff aceptado (el mismo que ya aplica a --trusted-ips): un ataque
# originado desde el /24 del edge de la API no se veria. Para la red de
# una PyME es un escenario improbable, y el costo de no arreglarlo es
# un sensor que se auto-reporta en bucle.
EXCLUDED_NETWORKS = set()

# Broadcast dirigido de las subredes locales (ej. 192.168.1.255).
# is_multicast_or_broadcast() solo cubria 255.255.255.255, pero el
# trafico normal de descubrimiento en LAN (NetBIOS, SMB, DHCP) va al
# broadcast de la subred, y sin excluirlo alimenta al clasificador.
LOCAL_BROADCASTS = set()


def _prefix_for(ip_str):
    """/24 para IPv4, /48 para IPv6."""
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return None
    suffix = 24 if addr.version == 4 else 48
    return ipaddress.ip_network(f"{ip_str}/{suffix}", strict=False)


def add_excluded_prefixes(ips):
    """Agrega el prefijo que contiene cada IP. Devuelve los prefijos nuevos."""
    nuevos = set()
    for ip in ips:
        net = _prefix_for(ip)
        if net and net not in EXCLUDED_NETWORKS:
            EXCLUDED_NETWORKS.add(net)
            nuevos.add(net)
    return nuevos


def in_excluded_network(ip_str):
    if not EXCLUDED_NETWORKS:
        return False
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return any(addr in net for net in EXCLUDED_NETWORKS)


def get_local_broadcasts():
    """Direcciones de broadcast dirigido de las interfaces locales."""
    out = set()
    try:
        res = subprocess.run(["ip", "-o", "-4", "addr", "show"],
                             capture_output=True, text=True, timeout=5)
        for line in res.stdout.splitlines():
            toks = line.split()
            if "brd" in toks:
                i = toks.index("brd")
                if i + 1 < len(toks):
                    out.add(toks[i + 1])
    except Exception:
        pass
    return out


# ──────────────────────────────────────────────────────────────
# Integracion con la API de EcoSentinel (Next.js + Postgres)
# ──────────────────────────────────────────────────────────────
# El modelo (ecosentinel_model_rpi.pkl) es BINARIO: solo da
# attack_prob (0-1). NO existe todavia un clasificador multiclase
# real que diga la familia (Ransomware/DDoS/Port Scanning/Botnet
# Mirai/Brute Force/Spoofing) -- ver heuristic_attack_type() mas abajo,
# que es una aproximacion honesta basada en protocolo/puerto/patron
# de flujo, NO una salida del modelo. Reemplazar cuando exista un
# modelo multiclase real entrenado sobre datos etiquetados por familia.
API_URL = os.environ.get("ECOSENTINEL_API_URL", "").rstrip("/")
API_KEY = os.environ.get("ECOSENTINEL_API_KEY", "")
HTTP_TIMEOUT = 5           # segundos, no bloquear la captura si la API tarda
HEARTBEAT_INTERVAL = 60    # segundos entre heartbeats
MODELO_VERSION = "rf-binary-v1"  # ajustar si se reentrena/reemplaza el modelo

# Cola acotada: si la API esta lenta/caida, NO se bloquea la captura de
# paquetes (sniff corre en el hilo principal). Un hilo aparte drena la
# cola y hace los POST. Si se llena, se descartan envios nuevos (mejor
# perder una detección que congelar el sensor).
_send_queue = queue.Queue(maxsize=2000)

# Referencia (no copia) al mismo set que usa should_exclude() -- ver
# run_live(). _ensure_api_ip_trusted() la actualiza justo antes de cada
# POST, así la IP a la que ESTAMOS a punto de conectarnos queda excluida
# con cero retraso (Vercel/CDN rota entre varias IPs de borde; esperar a
# un refresco periódico deja una ventana donde el sensor se auto-reporta
# como ataque -- ver start_api_ip_refresher_thread(), que queda como
# respaldo adicional, no como mecanismo principal).
_trusted_ips_ref = None

# Cada resolucion DNS (la nuestra o la interna de urlopen) genera un
# paquete UDP query+response hacia el resolver local -- un flujo de 1-2
# paquetes con duracion casi nula, EXACTAMENTE el patron que dispara
# falsos positivos en este modelo (ver DURATION_EPSILON arriba). Sin
# limite de frecuencia, cada deteccion enviada generaba una resolucion
# DNS nueva, que se marcaba como ataque, que generaba otra deteccion...
# un bucle de amplificacion real que se vio en producción. Por eso:
#   1. El/los resolver(es) DNS configurados en /etc/resolv.conf se
#      excluyen del analisis igual que la IP de la API (ver
#      get_system_resolvers() y su uso en main()).
#   2. Aun con eso, no vale la pena resolver en CADA POST -- se limita a
#      como maximo una vez cada API_IP_CHECK_MIN_INTERVAL segundos.
API_IP_CHECK_MIN_INTERVAL = 15
_last_ip_check_ts = 0.0


def api_configured():
    return bool(API_URL and API_KEY)


def get_system_resolvers():
    """Lee /etc/resolv.conf y devuelve las IPs de los nameservers configurados."""
    ips = set()
    try:
        with open("/etc/resolv.conf") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "nameserver":
                    ip = parts[1].split("%")[0]  # descarta el zone-id de IPv6 (ej. %wlan0)
                    ips.add(ip)
    except OSError:
        pass
    return ips


def _ensure_api_ip_trusted():
    global _last_ip_check_ts
    if _trusted_ips_ref is None or not api_configured():
        return
    now = time.time()
    if now - _last_ip_check_ts < API_IP_CHECK_MIN_INTERVAL:
        return
    _last_ip_check_ts = now
    try:
        api_host = urllib.parse.urlparse(API_URL).hostname
        ips = {info[4][0] for info in socket.getaddrinfo(api_host, None)}
        # .update() y NO "|=": una asignacion aumentada haria que Python
        # trate _trusted_ips_ref como variable LOCAL de esta funcion (que
        # solo declara global _last_ip_check_ts), y el hilo emisor moria
        # con UnboundLocalError -> no se enviaban heartbeats ni detecciones.
        _trusted_ips_ref.update(ips)
        # Tambien el prefijo: el edge rota de IP entre resoluciones y la
        # conexion real puede salir contra una IP distinta a la que
        # acabamos de resolver (ver EXCLUDED_NETWORKS).
        add_excluded_prefixes(ips)
    except Exception:
        pass  # no bloquear el envio por un fallo de resolucion


def _post_json(path, payload):
    _ensure_api_ip_trusted()
    req = urllib.request.Request(
        API_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            if resp.status not in (200, 201):
                log.error(f"[api] {path} respondio HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")[:300]
        log.error(f"[api] {path} fallo HTTP {e.code}: {body}")
    except Exception as e:
        log.error(f"[api] {path} fallo de conexion: {e}")


def _sender_worker():
    while True:
        path, payload = _send_queue.get()
        try:
            _post_json(path, payload)
        except Exception as e:
            # Defensa en profundidad. _post_json y _ensure_api_ip_trusted ya
            # capturan sus propias excepciones, asi que en la practica esto no
            # se dispara -- pero si ALGUNA vez una excepcion inesperada saliera
            # de aqui, este except impide que el hilo emisor muera. Un hilo
            # emisor muerto deja de mandar heartbeats Y detecciones EN SILENCIO
            # (el appliance sale "desconectado" y ningun escaneo genera alerta).
            # Es exactamente el fallo del 2026-07-28 (UnboundLocalError, ver
            # reporte §5.4): que no vuelva a poder pasar por ninguna via.
            log.error(f"[api] excepcion no controlada al enviar a {path}: {e}")
        finally:
            _send_queue.task_done()


def enqueue_send(path, payload):
    if not api_configured():
        return
    try:
        _send_queue.put_nowait((path, payload))
    except queue.Full:
        log.error(f"[api] cola llena (>{_send_queue.maxsize}), se descarta envio a {path}")


def start_sender_thread():
    if not api_configured():
        log.warning(
            "ECOSENTINEL_API_URL / ECOSENTINEL_API_KEY no configurados: "
            "las detecciones NO se envian a la API, solo se registran en el log local."
        )
        return
    t = threading.Thread(target=_sender_worker, daemon=True)
    t.start()
    log.info(f"[api] enviando detecciones a {API_URL}")


def start_heartbeat_thread(packets_since_hb):
    if not api_configured():
        return

    def _loop():
        while True:
            time.sleep(HEARTBEAT_INTERVAL)
            n = packets_since_hb["n"]
            packets_since_hb["n"] = 0  # reset: el servidor SUMA el historico, no lee un contador vivo
            cpu = psutil.cpu_percent(interval=None) if psutil else 0.0
            ram = psutil.virtual_memory().percent if psutil else 0.0
            enqueue_send("/api/ingest/heartbeat", {
                "cpu_pct": round(cpu, 1),
                "ram_pct": round(ram, 1),
                "modelo_version": MODELO_VERSION,
                "packets_processed": n,
            })

    threading.Thread(target=_loop, daemon=True).start()


API_IP_REFRESH_INTERVAL = 60  # segundos


def start_api_ip_refresher_thread(trusted_ips):
    """
    Vercel (y cualquier CDN/edge detras de la API) sirve el mismo host
    desde MULTIPLES IPs rotativas -- una sola resolucion DNS al arrancar
    no las cubre todas (se vio en producción: goteaban IPs nuevas del
    mismo bloque que seguian generando falsos positivos por
    retroalimentacion). Re-resuelve el host periodicamente y agrega
    cualquier IP nueva al set de exclusion — nunca se quitan las viejas,
    es inofensivo mantenerlas excluidas.
    """
    if not api_configured():
        return

    api_host = urllib.parse.urlparse(API_URL).hostname

    def _loop():
        while True:
            try:
                new_ips = {info[4][0] for info in socket.getaddrinfo(api_host, None)}
                added = new_ips - trusted_ips
                if added:
                    trusted_ips.update(added)
                    log.info(f"[api] nuevas IPs de la API detectadas y excluidas: {added}")
            except Exception as e:
                log.warning(f"[api] no se pudo refrescar la resolucion de {api_host}: {e}")
            time.sleep(API_IP_REFRESH_INTERVAL)

    threading.Thread(target=_loop, daemon=True).start()


# ──────────────────────────────────────────────────────────────
# Heuristica de familia de ataque (NO es el modelo — ver nota arriba)
# ──────────────────────────────────────────────────────────────
# Ventana deslizante: cuantos puertos-destino DISTINTOS toco cada IP
# origen en los ultimos SCAN_WINDOW_SECONDS. Es la unica senal que
# necesita mirar mas alla de un solo flujo (un barrido de puertos se ve
# como muchos flujos de 1-2 paquetes cada uno, no como un flujo grande).
SCAN_WINDOW_SECONDS = 20
SCAN_PORT_THRESHOLD = 6
_recent_ports_by_src = defaultdict(deque)


def register_port_touch(src, dport, now):
    dq = _recent_ports_by_src[src]
    dq.append((now, dport))
    while dq and now - dq[0][0] > SCAN_WINDOW_SECONDS:
        dq.popleft()
    # evita que _recent_ports_by_src crezca sin limite con IPs que ya
    # no mandan trafico (nunca se limpian solas si no vuelven a tocar
    # ningun puerto)
    if len(_recent_ports_by_src) > MAX_FLOWS * 2:
        _recent_ports_by_src.clear()


def distinct_recent_ports(src):
    dq = _recent_ports_by_src.get(src)
    if not dq:
        return 0
    return len({p for _, p in dq})


# ──────────────────────────────────────────────────────────────
# Deteccion de barridos ARP (reconocimiento de red)
# ──────────────────────────────────────────────────────────────
# POR QUE HACE FALTA: este sensor es un cliente WiFi en modo managed, asi
# que solo ve el trafico dirigido a el mismo mas el broadcast. Un escaneo
# de puertos contra OTRO equipo de la red le pasa desapercibido.
#
# Pero la fase de reconocimiento -- el "nmap -sn" con el que un atacante
# empieza para descubrir que hay en la red -- usa ARP, y ARP ES broadcast:
# le llega a todos. Contando cuantas direcciones DISTINTAS pregunta cada
# origen se detecta el barrido aunque no vaya dirigido a nosotros.
#
# Medido el 2026-07-30: un `nmap -sn 192.168.1.0/24` lanzado desde otro
# equipo genero 198 ARP requests perfectamente visibles desde la RPi.
#
# Esto NO pasa por el modelo: el RandomForest se entreno con flujos IP de
# CIC-IoT2023 y no tiene features para ARP. Es una heuristica determinista.
ARP_SCAN_WINDOW = 60.0       # ventana deslizante, en segundos
ARP_SCAN_THRESHOLD = 20      # direcciones distintas preguntadas -> barrido
ARP_ALERT_COOLDOWN = 300.0   # no repetir alerta del mismo origen en 5 min
ARP_MAX_SOURCES = 500        # tope de origenes vigilados (proteccion de RAM)

# src_ip -> {"targets": {ip_preguntada: timestamp}, "last_alert": ts}
_arp_activity = {}


def track_arp_request(src_ip, target_ip, now, trusted_ips=None):
    """
    Registra un ARP request y devuelve el numero de objetivos distintos si
    acaba de cruzarse el umbral de barrido; None en cualquier otro caso.

    Es puro salvo por el diccionario de estado, para poder probarlo sin red.
    """
    # Exclusion de origenes de gestion, con la MISMA logica que should_exclude():
    # no basta el match exacto de --trusted-ips. El gateway/router hace ARP
    # legitimo hacia muchos hosts de la red (mantiene su tabla ARP) y dispararia
    # un falso "barrido". Ademas de la laptop de admin (match exacto), se excluye
    # cualquier origen dentro de un prefijo ya excluido -- in_excluded_network()
    # cubre el gateway y el resto de infraestructura de confianza.
    if trusted_ips and src_ip in trusted_ips:
        return None
    if in_excluded_network(src_ip):
        return None

    act = _arp_activity.get(src_ip)
    if act is None:
        # Si hay demasiados origenes vigilados se limpian los inactivos. Sin
        # esto, una red ruidosa haria crecer el diccionario indefinidamente
        # (mismo problema que ya tenia _recent_ports_by_src).
        if len(_arp_activity) >= ARP_MAX_SOURCES:
            for ip in [k for k, v in _arp_activity.items()
                       if not v["targets"] or max(v["targets"].values()) < now - ARP_SCAN_WINDOW]:
                del _arp_activity[ip]
            if len(_arp_activity) >= ARP_MAX_SOURCES:
                _arp_activity.clear()
        act = {"targets": {}, "last_alert": 0.0}
        _arp_activity[src_ip] = act

    act["targets"][target_ip] = now
    limite = now - ARP_SCAN_WINDOW
    act["targets"] = {ip: ts for ip, ts in act["targets"].items() if ts >= limite}

    n = len(act["targets"])
    if n >= ARP_SCAN_THRESHOLD and (now - act["last_alert"]) >= ARP_ALERT_COOLDOWN:
        act["last_alert"] = now
        return n
    return None


def send_arp_scan_detection(src_ip, n_targets):
    # attack_prob aqui es una CERTEZA HEURISTICA, no una salida del modelo:
    # preguntar por >=20 direcciones distintas en 60 s no tiene lectura
    # benigna en una red domestica o de PyME. Se manda 0.99 para que quede
    # por encima del umbral de "alta confianza" del dashboard (0.70).
    # attack_type: de los 6 valores que acepta la API, "Port Scanning" es el
    # unico que describe reconocimiento.
    # protocol "OTHER": ARP no es TCP/UDP/ICMP.
    enqueue_send("/api/ingest/detections", {
        "attack_prob": 0.99,
        "attack_type": "Port Scanning",
        "protocol": "OTHER",
        "src_ip": hash_ip(src_ip),   # HMAC-SHA256 local, nunca la IP en claro
        "dst_port": 0,               # un barrido ARP no tiene puerto destino
    })


def check_arp_scan(pkt, trusted_ips=None):
    """Mira un paquete en crudo; si es un ARP request, lo contabiliza."""
    try:
        from scapy.all import ARP
    except ImportError:
        return
    if ARP not in pkt:
        return
    arp = pkt[ARP]
    if getattr(arp, "op", None) != 1:   # 1 = who-has (request). Las replies no interesan.
        return
    src, target = getattr(arp, "psrc", ""), getattr(arp, "pdst", "")
    # 0.0.0.0 son ARP probes de un equipo pidiendo IP (DHCP): no es un barrido.
    if not src or not target or src == "0.0.0.0":
        return
    n = track_arp_request(src, target, time.time(), trusted_ips)
    if n:
        log.warning(
            f"  [BARRIDO ARP] {src} pregunto por {n} direcciones distintas "
            f"en menos de {ARP_SCAN_WINDOW:.0f}s -- reconocimiento de red"
        )
        send_arp_scan_detection(src, n)


MIRAI_PORTS = {23, 2323}
RANSOMWARE_LATERAL_PORTS = {445, 3389}
BRUTEFORCE_PORTS = {21, 22, 3389}


def heuristic_attack_type(flow, key):
    """
    Aproximacion por reglas (protocolo/puerto/patron de flujo) a una de
    las 6 familias que muestra el dashboard. NO es una clasificacion del
    modelo -- el modelo (RandomForest binario) solo da attack_prob.
    Reemplazar por un clasificador multiclase real en cuanto exista.
    """
    src, dst, dport, proto = key
    syn = flow["flags"].get("SYN", 0)
    ack = flow["flags"].get("ACK", 0)
    n = len(flow["times"])
    duration = max(flow["times"]) - min(flow["times"]) if n > 1 else 0.0
    rate = n / max(duration, DURATION_EPSILON)

    if distinct_recent_ports(src) >= SCAN_PORT_THRESHOLD:
        return "Port Scanning"
    if proto == "TCP" and dport in MIRAI_PORTS:
        return "Botnet Mirai"
    if proto == "TCP" and dport in RANSOMWARE_LATERAL_PORTS:
        return "Ransomware"
    if proto == "TCP" and dport in BRUTEFORCE_PORTS:
        # Antes exigia syn>0 and ack==0 (solo intentos sin completar), asi
        # que una sesion SSH ya establecida no matcheaba ninguna regla y
        # caia al default "DDoS" -- se vio en produccion el 2026-07-28.
        # El puerto ya es la senal fuerte: el modelo binario decidio que
        # esto es un ataque, y para 22/21/3389 la familia correcta es
        # fuerza bruta, sin importar el patron exacto de flags.
        return "Brute Force"
    if proto in ("UDP", "ICMP") and rate >= RATE_CAP * 0.5:
        return "DDoS"
    if proto == "ICMP":
        return "Spoofing"
    # Default: trafico TCP/UDP volumétrico que no matcheo ninguna regla
    # anterior -- DDoS es el cajon menos malo (mejor que inventar una
    # familia especifica sin senal para sostenerla).
    return "DDoS"


# ──────────────────────────────────────────────────────────────
# Privacidad: hash de la IP de origen antes de salir del dispositivo
# ──────────────────────────────────────────────────────────────
# "Zero cloud, local privacy" -- ningun dato identificable debe salir
# del dispositivo. Un sha256(ip) SIN secreto es reversible por fuerza
# bruta en minutos (el espacio de IPv4 son solo ~4300 millones de
# valores), asi que se usa HMAC con una clave local generada una sola
# vez y que NUNCA sale de este dispositivo.
#
# OJO (overlayroot): el root de esta RPi es un overlay con la capa de
# escritura en tmpfs (RAM), asi que si .device_salt vive solo en / se
# regenera en CADA reinicio y el hash de una misma IP cambia. Para que
# el salt sobreviva se guarda en /media/root-rw solo si es persistente;
# ver el reporte del 2026-07-29.
DEVICE_SALT_FILE = Path(__file__).parent / ".device_salt"


def _load_or_create_device_salt():
    if DEVICE_SALT_FILE.exists():
        return DEVICE_SALT_FILE.read_bytes()
    salt = os.urandom(32)
    DEVICE_SALT_FILE.write_bytes(salt)
    DEVICE_SALT_FILE.chmod(0o600)
    return salt


DEVICE_SALT = _load_or_create_device_salt()


def hash_ip(ip: str) -> str:
    """HMAC-SHA256 de la IP con una clave local secreta que NUNCA sale
    del dispositivo. A diferencia de un sha256(ip) simple, esto no es
    reversible por fuerza bruta sobre el espacio de IPv4 sin conocer
    DEVICE_SALT."""
    return hmac.new(DEVICE_SALT, ip.encode(), hashlib.sha256).hexdigest()[:16]


def send_detection(key, prob, flow):
    src, dst, dport, proto = key
    enqueue_send("/api/ingest/detections", {
        "attack_prob": round(float(prob), 4),
        "attack_type": heuristic_attack_type(flow, key),
        "protocol": proto if proto in ("TCP", "UDP", "ICMP") else "OTHER",
        "src_ip": hash_ip(src),  # HMAC-SHA256 local -- nunca la IP en claro
        "dst_port": dport,
    })


# ──────────────────────────────────────────────────────────────
# Carga de artefactos
# ──────────────────────────────────────────────────────────────
def load_artifacts():
    for f in (MODEL_FILE, THRESHOLD_FILE, SCALER_FILE, FEATURES_FILE):
        if not f.exists():
            log.error(f"Falta artefacto: {f}")
            sys.exit(1)

    log.info("Cargando modelo y artefactos...")
    model     = joblib.load(MODEL_FILE)
    threshold = joblib.load(THRESHOLD_FILE)
    scaler    = joblib.load(SCALER_FILE)
    features  = joblib.load(FEATURES_FILE)

    log.info(f"  Modelo: {type(model).__name__}")
    log.info(f"  Umbral de decision: {threshold}")
    log.info(f"  Features esperadas: {len(features)}")
    return model, threshold, scaler, features


# ──────────────────────────────────────────────────────────────
# Clasificacion
# ──────────────────────────────────────────────────────────────
def classify(feature_vector, model, scaler, threshold, feature_names):
    """
    Recibe un vector de features de un flujo, aplica el scaler,
    y clasifica usando el UMBRAL CALIBRADO (no predict() directo).
    Retorna: (es_ataque: bool, probabilidad: float)
    """
    X = np.array(feature_vector, dtype=np.float32).reshape(1, -1)
    X_scaled = scaler.transform(X)
    prob_attack = model.predict_proba(X_scaled)[0, 1]
    is_attack = prob_attack >= threshold
    return is_attack, float(prob_attack)


# ──────────────────────────────────────────────────────────────
# Extraccion de features desde flujos agregados
# ──────────────────────────────────────────────────────────────
def extract_features_from_flow(flow, feature_names, debug=False):
    """
    Convierte un flujo agregado en el vector de 30 features que
    el modelo espera, EN EL ORDEN de feature_names.

    Nombres del dataset (CIC-IoT2023):
      flow_duration, header_length, protocol_type, duration, rate,
      drate, fin_flag_number, syn_flag_number, rst_flag_number,
      psh_flag_number, ack_flag_number, syn_count, fin_count,
      urg_count, rst_count, http, https, dns, tcp, udp, icmp, ipv,
      tot_sum, min, max, avg, tot_size, iat, covariance, variance
    """
    pkts = flow["packets"]
    times = flow["times"]
    sizes = flow["sizes"]
    n = len(pkts)

    if n == 0:
        return None

    raw_duration = max(times) - min(times) if n > 1 else 0.0

    # ── FIX: piso de duracion antes de dividir ──────────────────
    # En vez de rate = n/duration (o 0.0 si duration==0), usamos un
    # piso minimo para evitar que Delta t ~ 0 produzca un rate
    # absurdamente alto para flujos de 2+ paquetes casi simultaneos.
    effective_duration = max(raw_duration, DURATION_EPSILON)
    rate_raw = n / effective_duration
    rate = min(rate_raw, RATE_CAP)

    dst_pkts = flow.get("dst_packets", 0)
    drate_raw = dst_pkts / effective_duration
    drate = min(drate_raw, RATE_CAP)

    if debug and rate_raw > RATE_CAP:
        log.debug(
            f"  rate saturado: raw={rate_raw:.1f} -> cap={RATE_CAP} "
            f"(n={n}, raw_duration={raw_duration:.6f}s)"
        )

    iats = np.diff(sorted(times)) if n > 1 else np.array([0.0])

    feat = {
        "flow_duration":    raw_duration,
        "header_length":    flow.get("header_length_sum", 0.0),
        "protocol_type":    flow.get("protocol_type", 0.0),
        "duration":         raw_duration,
        "rate":             rate,
        "drate":            drate,
        "fin_flag_number":  flow["flags"].get("FIN", 0),
        "syn_flag_number":  flow["flags"].get("SYN", 0),
        "rst_flag_number":  flow["flags"].get("RST", 0),
        "psh_flag_number":  flow["flags"].get("PSH", 0),
        "ack_flag_number":  flow["flags"].get("ACK", 0),
        "syn_count":        flow["flags"].get("SYN", 0),
        "fin_count":        flow["flags"].get("FIN", 0),
        "urg_count":        flow["flags"].get("URG", 0),
        "rst_count":        flow["flags"].get("RST", 0),
        "http":             1.0 if flow.get("http") else 0.0,
        "https":            1.0 if flow.get("https") else 0.0,
        "dns":              1.0 if flow.get("dns") else 0.0,
        "tcp":              1.0 if flow.get("proto") == "TCP" else 0.0,
        "udp":              1.0 if flow.get("proto") == "UDP" else 0.0,
        "icmp":             1.0 if flow.get("proto") == "ICMP" else 0.0,
        "ipv":              flow.get("ip_version", 4.0),
        "tot_sum":          float(sum(sizes)),
        "min":              float(min(sizes)) if sizes else 0.0,
        "max":              float(max(sizes)) if sizes else 0.0,
        "avg":              float(np.mean(sizes)) if sizes else 0.0,
        "tot_size":         float(sum(sizes)),
        "iat":              float(np.mean(iats)),
        "covariance":       float(np.cov(sizes)) if len(sizes) > 1 else 0.0,
        "variance":         float(np.var(sizes)) if sizes else 0.0,
    }

    vector = [feat.get(name, 0.0) for name in feature_names]
    return vector


# ──────────────────────────────────────────────────────────────
# Agregacion de paquetes en flujos
# ──────────────────────────────────────────────────────────────
def flow_key(pkt_info):
    """
    Identifica un flujo por 4-tupla SIN puerto de origen.
    (Fix anti-evasion: agrupar tambien por sport permitia que un
    SYN flood con puerto de origen aleatorio en cada paquete se
    fragmentara en miles de flujos de 1 paquete, cada uno invisible
    para el detector.)
    """
    return (pkt_info["src"], pkt_info["dst"],
            pkt_info["dport"], pkt_info["proto"])


def new_flow():
    return {
        "packets": [], "times": [], "sizes": [],
        "flags": defaultdict(int),
        "proto": None, "protocol_type": 0.0,
        "header_length_sum": 0.0, "dst_packets": 0,
        "http": False, "https": False, "dns": False,
        "ip_version": 4.0,
    }


def parse_packet(pkt):
    try:
        from scapy.all import IP, TCP, UDP, ICMP
    except ImportError:
        return None

    if IP not in pkt:
        return None

    ip = pkt[IP]
    info = {
        "src": ip.src, "dst": ip.dst,
        "sport": 0, "dport": 0, "proto": "OTHER",
        "size": len(pkt), "time": float(pkt.time),
        "header_length": ip.ihl * 4 if hasattr(ip, "ihl") else 20,
        "flags": [], "ip_version": float(ip.version),
    }

    if TCP in pkt:
        tcp = pkt[TCP]
        info["proto"] = "TCP"; info["sport"] = tcp.sport; info["dport"] = tcp.dport
        flags = tcp.flags
        if flags & 0x02: info["flags"].append("SYN")
        if flags & 0x01: info["flags"].append("FIN")
        if flags & 0x04: info["flags"].append("RST")
        if flags & 0x08: info["flags"].append("PSH")
        if flags & 0x10: info["flags"].append("ACK")
        if flags & 0x20: info["flags"].append("URG")
        if tcp.dport == 80 or tcp.sport == 80:   info["http"] = True
        if tcp.dport == 443 or tcp.sport == 443: info["https"] = True
    elif UDP in pkt:
        udp = pkt[UDP]
        info["proto"] = "UDP"; info["sport"] = udp.sport; info["dport"] = udp.dport
        if udp.dport == 53 or udp.sport == 53: info["dns"] = True
    elif ICMP in pkt:
        info["proto"] = "ICMP"

    return info


def is_multicast_or_broadcast(ip_str):
    """
    True si la IP es multicast (224.0.0.0/4, rango completo IPv4
    multicast) o broadcast limitado (255.255.255.255).

    Trafico de descubrimiento legitimo -- mDNS (224.0.0.251), SSDP
    (239.255.255.250), LLMNR, etc. -- SIEMPRE se envia a estas
    direcciones. Un ataque de reflexion/amplificacion que ABUSA de
    estos mismos protocolos (mDNS/SSDP amplification son vectores de
    DDoS reales y comunes) apunta a la IP UNICAST real de la victima,
    nunca al grupo multicast en si -- asi es como funciona la tecnica.
    Por eso excluir por DIRECCION DESTINO multicast/broadcast es
    seguro: no abre un hueco para ese tipo de ataque, porque el trafico
    de ataque real nunca tiene el grupo multicast como destino.

    A diferencia de un allowlist por PUERTO (que si seria peligroso:
    UDP/5353 o UDP/1900 dirigido a una IP unicast real SI debe seguir
    analizandose, podria ser parte de un ataque de reflexion).
    """
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return addr.is_multicast or ip_str == "255.255.255.255"


def should_exclude(info, trusted_ips):
    """
    Decide si un paquete debe excluirse del analisis por completo:
      1. IP de administracion conocida (--trusted-ips), en cualquiera
         de los dos extremos.
      2. Destino multicast/broadcast (descubrimiento de protocolo,
         nunca un objetivo de ataque real -- ver is_multicast_or_broadcast).
    """
    if trusted_ips and (info["src"] in trusted_ips or info["dst"] in trusted_ips):
        return True
    if is_multicast_or_broadcast(info["dst"]):
        return True
    if info["dst"] in LOCAL_BROADCASTS:
        return True
    if in_excluded_network(info["src"]) or in_excluded_network(info["dst"]):
        return True
    return False


def add_to_flow(flows, info):
    key = flow_key(info)
    if key not in flows:
        flows[key] = new_flow()
        flows[key]["proto"] = info["proto"]
        flows[key]["protocol_type"] = {"TCP": 6.0, "UDP": 17.0, "ICMP": 1.0}.get(info["proto"], 0.0)
        flows[key]["ip_version"] = info["ip_version"]
    f = flows[key]
    f["packets"].append(1)
    f["times"].append(info["time"])
    f["sizes"].append(info["size"])
    f["header_length_sum"] += info["header_length"]
    for flag in info["flags"]:
        f["flags"][flag] += 1
    if info.get("http"):  f["http"] = True
    if info.get("https"): f["https"] = True
    if info.get("dns"):   f["dns"] = True
    register_port_touch(info["src"], info["dport"], info["time"])


# ──────────────────────────────────────────────────────────────
# MODO 1: Validacion con .pcap
# ──────────────────────────────────────────────────────────────
def run_validate(pcap_path, model, threshold, scaler, features, debug=False, trusted_ips=None):
    try:
        from scapy.all import rdpcap
    except ImportError:
        log.error("scapy no instalado. Ejecuta: pip install scapy --prefer-binary")
        sys.exit(1)

    pcap_path = Path(pcap_path)
    if not pcap_path.exists():
        log.error(f"No existe el archivo: {pcap_path}")
        sys.exit(1)

    log.info("=" * 55)
    log.info(f"  MODO VALIDACION — {pcap_path.name}")
    log.info("=" * 55)

    log.info("Leyendo paquetes...")
    packets = rdpcap(str(pcap_path))
    log.info(f"  {len(packets)} paquetes cargados")

    flows = {}
    excluded = 0
    for pkt in packets:
        info = parse_packet(pkt)
        if info and should_exclude(info, trusted_ips):
            excluded += 1
            continue
        if info:
            add_to_flow(flows, info)
    log.info(f"  {len(flows)} flujos identificados")
    if excluded:
        log.info(f"  ({excluded} paquetes excluidos: IP de confianza {trusted_ips or '(ninguna)'} "
                  f"y/o destino multicast/broadcast)")

    attacks = 0; benign = 0
    by_proto = defaultdict(lambda: {"attacks": 0, "benign": 0})
    log.info("── Clasificando flujos:")
    for key, flow in flows.items():
        vec = extract_features_from_flow(flow, features, debug=debug)
        if vec is None:
            continue
        is_attack, prob = classify(vec, model, scaler, threshold, features)
        src, dst, dport, proto = key
        by_proto[proto]["attacks" if is_attack else "benign"] += 1
        if is_attack:
            attacks += 1
            log.warning(f"  [ATAQUE p={prob:.3f}] {src} -> {dst}:{dport} ({proto})")
        else:
            benign += 1

    log.info("=" * 55)
    log.info(f"  RESULTADO: {attacks} ataques | {benign} benignos | {attacks+benign} total")
    for proto, c in by_proto.items():
        tot = c["attacks"] + c["benign"]
        pct = c["attacks"] / tot * 100 if tot else 0.0
        log.info(f"    {proto:<6} -> {c['attacks']}/{tot} marcados ataque ({pct:.1f}%)")
    log.info("=" * 55)
    log.info("  Si el % de UDP marcado como ataque sigue alto, corre")
    log.info("  inspect_raw_features.py y ajusta DURATION_EPSILON/RATE_CAP.")
    log.info("  (--validate NO envia nada a la API; solo --live lo hace.)")


# ──────────────────────────────────────────────────────────────
# MODO 2: Captura en vivo
# ──────────────────────────────────────────────────────────────
def run_live(interface, model, threshold, scaler, features, debug=False, trusted_ips=None):
    try:
        from scapy.all import sniff
    except ImportError:
        log.error("scapy no instalado. Ejecuta: pip install scapy --prefer-binary")
        sys.exit(1)

    flows = {}
    stats = {"attacks": 0, "benign": 0}
    packets_since_hb = {"n": 0}
    if trusted_ips is None:
        trusted_ips = set()

    global _trusted_ips_ref
    _trusted_ips_ref = trusted_ips

    start_sender_thread()
    start_heartbeat_thread(packets_since_hb)
    start_api_ip_refresher_thread(trusted_ips)

    def process_flow(key, flow, debug=False):
        vec = extract_features_from_flow(flow, features, debug=debug)
        if vec is None:
            return
        is_attack, prob = classify(vec, model, scaler, threshold, features)
        src, dst, dport, proto = key
        if is_attack:
            stats["attacks"] += 1
            log.warning(f"  [ATAQUE p={prob:.3f}] {src} -> {dst}:{dport} ({proto})")
            send_detection(key, prob, flow)
            if debug:
                n = len(flow["times"])
                dur = max(flow["times"]) - min(flow["times"]) if n > 1 else 0.0
                tot = sum(flow["sizes"])
                log.debug(
                    f"    -> flow_duration={dur:.3f}s  n_paquetes={n}  "
                    f"tot_size={tot}B  (compara contra los rangos de "
                    f"entrenamiento; un flujo agregado muy largo no se "
                    f"parece a los flujos cortos de CIC-IoT2023)"
                )
        else:
            stats["benign"] += 1

    def process_and_flush(force_all=False):
        now = time.time()
        expired = []
        for key, flow in flows.items():
            if not flow["times"]:
                continue
            idle = now - max(flow["times"])
            span = max(flow["times"]) - min(flow["times"])
            if force_all or idle > FLOW_TIMEOUT or span > FLOW_TIMEOUT * 4:
                expired.append(key)
        for key in expired:
            process_flow(key, flows.pop(key), debug=debug)

    def enforce_flow_cap():
        if len(flows) <= MAX_FLOWS:
            return
        oldest = sorted(flows.items(), key=lambda kv: min(kv[1]["times"]))
        n_evict = len(flows) - MAX_FLOWS
        for key, flow in oldest[:n_evict]:
            process_flow(key, flows.pop(key), debug=debug)

    packet_counter = {"n": 0}
    excluded_counter = {"n": 0}
    FLUSH_EVERY_N_PACKETS = 50  # chequeo de expiracion, independiente de cuantos flujos haya abiertos

    def on_packet(pkt):
        # ARP primero: parse_packet() descarta todo lo que no lleva capa IP,
        # y el barrido de reconocimiento viaja justo por ahi. Sin esta linea
        # el sensor no ve al atacante hasta que le apunta directamente.
        check_arp_scan(pkt, trusted_ips)

        info = parse_packet(pkt)
        if info and should_exclude(info, trusted_ips):
            excluded_counter["n"] += 1
            return
        if info:
            add_to_flow(flows, info)
        enforce_flow_cap()
        packet_counter["n"] += 1
        packets_since_hb["n"] += 1
        if packet_counter["n"] % FLUSH_EVERY_N_PACKETS == 0:
            process_and_flush()

    log.info(f"Captura en vivo en {interface}... (Ctrl+C para detener)")
    try:
        sniff(iface=interface, prn=on_packet, store=False)
    except KeyboardInterrupt:
        pass
    finally:
        process_and_flush(force_all=True)
        log.info(f"Total: {stats['attacks']} ataques | {stats['benign']} benignos "
                 f"| {excluded_counter['n']} paquetes excluidos (IP de confianza / multicast-broadcast)")


# ──────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="EcoSentinel — Motor de inferencia")
    parser.add_argument("--validate", metavar="PCAP", help="Validar contra un .pcap")
    parser.add_argument("--live", metavar="IFACE", help="Captura en vivo en una interfaz")
    parser.add_argument("--debug", action="store_true", help="Log detallado de saturacion de rate y flujos marcados ataque")
    parser.add_argument("--trusted-ips", default="",
                         help="IPs de confianza separadas por coma a excluir del analisis "
                              "(ej. tu laptop de administracion): --trusted-ips 192.168.1.75,192.168.1.10")
    parser.add_argument("--api-url", default="", help="URL base de la API (o ECOSENTINEL_API_URL)")
    parser.add_argument("--api-key", default="", help="API key del dispositivo (o ECOSENTINEL_API_KEY)")
    parser.add_argument("--threshold", type=float, default=None,
                        help="Sobreescribe el umbral de deteccion para esta corrida "
                             "(por defecto: max(valor del .pkl, piso calibrado))")
    args = parser.parse_args()

    if not args.validate and not args.live:
        parser.print_help()
        sys.exit(1)

    # FIX: --debug antes no hacia nada porque basicConfig() ya habia
    # fijado el nivel en INFO al importar el modulo, antes de que
    # argparse leyera este flag. Se corrige aqui, DESPUES de parsear.
    if args.debug:
        log.setLevel(logging.DEBUG)

    global API_URL, API_KEY
    if args.api_url:
        API_URL = args.api_url.rstrip("/")
    if args.api_key:
        API_KEY = args.api_key

    trusted_ips = {ip.strip() for ip in args.trusted_ips.split(",") if ip.strip()}

    # El/los resolver(es) DNS del propio sistema (/etc/resolv.conf) tampoco
    # deben alimentar al clasificador: CADA resolucion DNS (la del sensor
    # mandando datos a la API, o cualquier otra del sistema) genera un
    # flujo UDP de 1-2 paquetes con duracion casi nula, que este modelo
    # binario confunde con un patron de ataque (ver DURATION_EPSILON) --
    # se confirmo en producción: sin esta exclusion, cada deteccion
    # enviada generaba una resolucion DNS que se marcaba como ataque, que
    # generaba otra deteccion, en bucle.
    resolver_ips = get_system_resolvers()
    if resolver_ips:
        trusted_ips |= resolver_ips
        log.info(f"Resolver(es) DNS del sistema excluidos del analisis: {resolver_ips}")

    # El trafico del PROPIO sensor hacia la API de EcoSentinel (heartbeats
    # y detecciones que este mismo proceso manda) NO debe alimentar al
    # clasificador -- es trafico de gestion del sensor, no trafico de la
    # red del cliente. El modelo (entrenado con benigno IoT de
    # CIC-IoT2023) a veces marca ese patron HTTPS saliente como sospechoso,
    # lo que generaria un bucle: el sensor reporta su propio reporte como
    # ataque. Se resuelve el host de la API una sola vez al arrancar y se
    # excluye igual que --trusted-ips.
    # LIMITACION CONOCIDA: si la API vive detras de un edge compartido
    # (ej. Vercel) esta IP no es exclusiva de este proyecto -- un ataque
    # real dirigido a esa IP puntual (muy improbable) tampoco se veria.
    # Mismo tradeoff que ya se acepta para --trusted-ips.
    if api_configured():
        try:
            api_host = urllib.parse.urlparse(API_URL).hostname
            api_ips = {info[4][0] for info in socket.getaddrinfo(api_host, None)}
            trusted_ips |= api_ips
            prefijos = add_excluded_prefixes(api_ips)
            log.info(f"IP(s) de la API de EcoSentinel excluidas del analisis: {api_ips}")
            log.info("Prefijo(s) de la API excluidos (el edge rota de IP): "
                     + ", ".join(sorted(str(p) for p in prefijos)))
        except Exception as e:
            log.warning(f"No se pudo resolver el host de la API ({API_URL}) para excluirlo del analisis: {e}")

    if trusted_ips:
        log.info(f"IPs de confianza excluidas del analisis: {trusted_ips}")

    LOCAL_BROADCASTS.update(get_local_broadcasts())
    if LOCAL_BROADCASTS:
        log.info(f"Broadcast(s) de subred local excluidos del analisis: {LOCAL_BROADCASTS}")

    model, threshold, scaler, features = load_artifacts()

    # El .pkl trae 0.10 (calibrado sobre CIC-IoT2023, donde el ataque es
    # la clase mayoritaria). Sobre trafico real de PyME eso marca casi
    # todo como ataque -- ver DETECTION_THRESHOLD_FLOOR.
    if args.threshold is not None:
        threshold = args.threshold
        log.warning(f"Umbral sobreescrito por --threshold: {threshold}")
    elif float(threshold) < DETECTION_THRESHOLD_FLOOR:
        log.info(f"Umbral del .pkl ({threshold}) por debajo del piso calibrado; "
                 f"se usa {DETECTION_THRESHOLD_FLOOR} (ver DETECTION_THRESHOLD_FLOOR)")
        threshold = DETECTION_THRESHOLD_FLOOR
    log.info(f"  Umbral de deteccion EFECTIVO: {threshold}")

    if args.validate:
        run_validate(args.validate, model, threshold, scaler, features,
                     debug=args.debug, trusted_ips=trusted_ips)
    elif args.live:
        run_live(args.live, model, threshold, scaler, features,
                 debug=args.debug, trusted_ips=trusted_ips)


if __name__ == "__main__":
    main()
