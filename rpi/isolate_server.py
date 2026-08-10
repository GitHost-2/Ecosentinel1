"""
EcoSentinel — Panel local de "Aislar IP" (confirmacion humana + ejecucion)

Por que existe un panel EN la RPi, aparte del dashboard web: el dashboard
(Vercel) nunca tiene la IP real -- solo su hash (ver Zero cloud / local
privacy). La confirmacion "¿REALMENTE quieres aislar esta IP? <ip real>,
<dispositivo>" solo puede pasar donde esa IP existe de verdad: aqui, en la
RPi, contra su propio IpMemory. Es la UNICA accion de EcoSentinel que pide
mas de una confirmacion al operador -- todo lo demas es automatico.

Flujo:
  1. El panel web crea una orden en el backend (POST /api/mitigate/isolate).
  2. Esta RPi la ve al sondear GET /api/mitigate/pending (poll_once).
  3. Si el hash SIGUE en el mapa local, resuelve IP+MAC+fabricante/host y la
     deja pendiente de confirmar aqui (nunca aisla sola).
  4. El operador abre este panel, ve la IP real y el dispositivo, y confirma
     DOS veces (el clic + un dialogo del navegador que repite la IP).
  5. Se ejecuta el corte (ArpIsolator) y se reporta el resultado al backend
     (POST /api/mitigate/ack) -- nunca con la IP, solo el estado.

Liberar (quitar un aislamiento) NO pide esta segunda confirmacion -- el
usuario ya confirmo una vez en el panel web, y revertir un corte es la
accion segura por defecto.
"""
import html
import http.server
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from arp_isolate import (
    ArpIsolator,
    device_label,
    get_default_gateway,
    guess_hostname,
    own_mac,
    resolve_mac,
)

log = logging.getLogger("ecosentinel.isolate")

ISOLATE_TOKEN_FILE = Path(__file__).parent / ".isolate_token"
DEFAULT_PORT = 8843
POLL_INTERVAL_SECONDS = 5
HTTP_TIMEOUT = 5


def _load_or_create_token():
    if ISOLATE_TOKEN_FILE.exists():
        return ISOLATE_TOKEN_FILE.read_text().strip()
    token = secrets.token_hex(16)
    ISOLATE_TOKEN_FILE.write_text(token)
    ISOLATE_TOKEN_FILE.chmod(0o600)
    return token


def _get_pending_orders(api_url, api_key, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(
        api_url + "/api/mitigate/pending",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log.error(f"[isolate] no se pudo consultar ordenes pendientes: {e}")
        return None


class IsolateService:
    """Coordina el mapa local, el estado de aislamiento y las llamadas al
    backend. `enqueue_ack` es inyectable para no acoplar este modulo al
    hilo emisor de inference_engine.py en las pruebas."""

    def __init__(self, iface, api_url, api_key, ip_memory, enqueue_ack, token=None):
        self.iface = iface
        self.api_url = api_url
        self.api_key = api_key
        self.ip_memory = ip_memory
        self.enqueue_ack = enqueue_ack
        self.token = token or _load_or_create_token()
        self.own_mac = own_mac(iface) if iface else None
        self.gateway_ip = get_default_gateway(iface) if iface else None
        self.isolator = ArpIsolator(iface, self.own_mac)
        self._pending = {}        # order_id -> {hash, ip, mac, label}
        self._active_by_hash = {}  # hash -> {order_id, ip, label}
        self._lock = threading.Lock()

    def _ack(self, order_id, applied, note=None):
        payload = {"orderId": order_id, "applied": applied}
        if note:
            payload["note"] = note
        self.enqueue_ack("/api/mitigate/ack", payload)

    def poll_once(self):
        orders = _get_pending_orders(self.api_url, self.api_key)
        if orders is None:
            return
        for o in orders:
            order_id, ip_hash, desired = o.get("orderId"), o.get("srcIpHash"), o.get("desired")
            if desired == "isolated":
                self._handle_isolate_request(order_id, ip_hash)
            elif desired == "released":
                self._handle_release_request(order_id, ip_hash)

    def _handle_isolate_request(self, order_id, ip_hash):
        with self._lock:
            if order_id in self._pending:
                return  # ya esperando confirmacion humana

        real_ip = self.ip_memory.resolve(ip_hash)
        if not real_ip:
            self._ack(order_id, "failed", "hash fuera del mapa local (paso el TTL o el servicio se reinicio)")
            return

        mac = resolve_mac(real_ip, self.iface)
        if not mac:
            self._ack(order_id, "failed", "no se pudo resolver la MAC del atacante en la red local")
            return

        hostname = guess_hostname(real_ip)
        label = device_label(real_ip, mac, hostname)
        with self._lock:
            self._pending[order_id] = {"hash": ip_hash, "ip": real_ip, "mac": mac, "label": label}
        log.warning(f"[isolate] orden #{order_id} pendiente de confirmar en el panel local: {real_ip} ({label})")

    def _handle_release_request(self, order_id, ip_hash):
        entry = self._active_by_hash.get(ip_hash)
        if not entry:
            self._ack(order_id, "released", "no habia aislamiento activo que revertir")
            return
        ok = self.isolator.stop(entry["ip"])
        with self._lock:
            self._active_by_hash.pop(ip_hash, None)
        self._ack(order_id, "released", None if ok else "no se encontro el corte activo en este proceso")

    def pending_snapshot(self):
        with self._lock:
            return dict(self._pending)

    def active_snapshot(self):
        with self._lock:
            return dict(self._active_by_hash)

    def confirm(self, order_id):
        """El operador ya confirmo DOS VECES en el navegador (el clic +
        el dialogo con la IP real). Aqui solo se ejecuta."""
        with self._lock:
            entry = self._pending.pop(order_id, None)
        if not entry:
            return False, "La solicitud ya no esta pendiente (pudo expirar o resolverse desde otra pestaña)."

        gateway_mac = resolve_mac(self.gateway_ip, self.iface) if self.gateway_ip else None
        if not self.gateway_ip or not gateway_mac:
            self._ack(order_id, "failed", "no se pudo resolver la MAC del gateway")
            return False, "No se pudo resolver la MAC del gateway; no se aisló nada."

        self.isolator.start(entry["ip"], entry["mac"], self.gateway_ip, gateway_mac)
        with self._lock:
            self._active_by_hash[entry["hash"]] = {"order_id": order_id, "ip": entry["ip"], "label": entry["label"]}
        self._ack(order_id, "isolated")
        log.warning(f"[isolate] orden #{order_id} EJECUTADA: {entry['ip']} aislado ({entry['label']})")
        return True, entry

    def manual_release(self, target_ip):
        """Liberar desde el propio panel de la RPi (sin pasar por el
        dashboard web), por si este queda inalcanzable."""
        hash_objetivo = None
        with self._lock:
            for h, e in self._active_by_hash.items():
                if e["ip"] == target_ip:
                    hash_objetivo = h
                    order_id = e["order_id"]
                    break
        if hash_objetivo is None:
            return False
        self.isolator.stop(target_ip)
        with self._lock:
            self._active_by_hash.pop(hash_objetivo, None)
        self._ack(order_id, "released")
        return True


# ──────────────────────────────────────────────────────────────
# HTTP: panel local (solo LAN -- la RPi no tiene IP publica)
# ──────────────────────────────────────────────────────────────

def _render_index(service):
    pendientes = service.pending_snapshot()
    activos = service.active_snapshot()
    token = html.escape(service.token, quote=True)

    filas_pendientes = "".join(
        f"""
        <li class="pend">
          <p><strong>IP real:</strong> {html.escape(e['ip'])}</p>
          <p><strong>Dispositivo:</strong> {html.escape(e['label'])}</p>
          <form method="POST" action="/confirmar" onsubmit="return confirm(
            '¿REALMENTE quieres aislar la IP {html.escape(e['ip'], quote=True)}?\\n\\nDispositivo: {html.escape(e['label'], quote=True)}\\n\\nEsto cortará su tráfico de red ahora mismo.'
          );">
            <input type="hidden" name="token" value="{token}">
            <input type="hidden" name="orderId" value="{oid}">
            <button type="submit">Aislar esta IP</button>
          </form>
        </li>"""
        for oid, e in pendientes.items()
    ) or "<li class='vacio'>Sin solicitudes pendientes.</li>"

    filas_activas = "".join(
        f"""
        <li class="activo">
          <p><strong>{html.escape(e['ip'])}</strong> — {html.escape(e['label'])}</p>
          <form method="POST" action="/liberar">
            <input type="hidden" name="token" value="{token}">
            <input type="hidden" name="ip" value="{html.escape(e['ip'], quote=True)}">
            <button type="submit">Quitar aislamiento</button>
          </form>
        </li>"""
        for e in activos.values()
    ) or "<li class='vacio'>Ningún dispositivo aislado ahora mismo.</li>"

    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>EcoSentinel — Aislar IP (panel local)</title>
<style>
body {{ font-family: system-ui, sans-serif; background:#0a0f14; color:#e4eaef; max-width:640px; margin:40px auto; padding:0 20px; }}
h1 {{ font-size:1.3rem; }} h2 {{ font-size:1.05rem; color:#8b99a6; margin-top:32px; }}
ul {{ list-style:none; padding:0; }}
li {{ background:#151f28; border:1px solid #2a3641; border-radius:10px; padding:14px 16px; margin-bottom:10px; }}
li.vacio {{ color:#8b99a6; background:none; border:1px dashed #2a3641; }}
button {{ background:#2f8f86; color:#fff; border:none; padding:8px 14px; border-radius:8px; cursor:pointer; font-weight:600; }}
li.pend button {{ background:#c4694a; }}
p {{ margin:4px 0; }}
</style></head>
<body>
<h1>EcoSentinel — Aislar IP</h1>
<p>Este panel corre EN tu Raspberry Pi porque solo aquí existe la IP real de un
atacante. Confírmala aquí antes de cortarla.</p>
<h2>Pendientes de confirmar</h2>
<ul>{filas_pendientes}</ul>
<h2>Aislados ahora mismo</h2>
<ul>{filas_activas}</ul>
</body></html>"""


class _IsolateHandler(http.server.BaseHTTPRequestHandler):
    service: IsolateService = None  # inyectado por start_isolate_server()

    def log_message(self, fmt, *args):
        log.debug("[isolate-http] " + fmt % args)

    def _check_token(self, params):
        return secrets.compare_digest(params.get("token", [""])[0], self.service.token)

    def _reject(self):
        body = b"Token invalido o ausente."
        self.send_response(401)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect_home(self):
        self.send_response(303)
        self.send_header("Location", f"/?token={urllib.parse.quote(self.service.token)}")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        if not self._check_token(params):
            return self._reject()
        if parsed.path != "/":
            self.send_response(404)
            self.end_headers()
            return
        body = _render_index(self.service).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        params = urllib.parse.parse_qs(raw)
        if not self._check_token(params):
            return self._reject()

        if parsed.path == "/confirmar":
            try:
                order_id = int(params.get("orderId", ["0"])[0])
            except ValueError:
                order_id = 0
            self.service.confirm(order_id)
        elif parsed.path == "/liberar":
            self.service.manual_release(params.get("ip", [""])[0])
        else:
            self.send_response(404)
            self.end_headers()
            return

        self._redirect_home()


def start_isolate_server(service, port=DEFAULT_PORT):
    handler_cls = type("_BoundIsolateHandler", (_IsolateHandler,), {"service": service})
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler_cls)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    log.warning(
        f"[isolate] panel local en el puerto {port} -- entra desde un navegador en la MISMA red: "
        f"http://<ip-de-esta-rpi>:{port}/?token={service.token}"
    )
    return httpd


def start_poll_thread(service, interval=POLL_INTERVAL_SECONDS):
    def _loop():
        while True:
            try:
                service.poll_once()
            except Exception as e:
                log.error(f"[isolate] error en el sondeo de ordenes pendientes: {e}")
            time.sleep(interval)

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    return t
