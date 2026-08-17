# Motor de inferencia (Raspberry Pi)

Código que corre **en el dispositivo**, no en Vercel. Se versiona aquí porque
antes vivía solo en la RPi y no había copia en ningún repositorio.

## ⚠️ Un `scp` normal a la RPi se pierde al reiniciar

El arranque lleva `overlayroot=tmpfs` en el cmdline del kernel:

```
/media/root-ro   /dev/mmcblk0p2   ext4 (ro)   <- la tarjeta SD, capa PERSISTENTE
/media/root-rw   tmpfs                        <- capa de escritura EN RAM
/                overlay
```

Todo lo que se escriba en `/` vive en RAM y **desaparece en cada reinicio**,
volviendo a la imagen de la SD. Esto ya causó que un fix de privacidad (el
hashing de IP) se perdiera dos veces sin que nadie lo tocara.

**`overlayroot` se mantiene a propósito** — protege la SD contra corrupción por
corte de luz, que es la razón legítima de tenerlo en un appliance. Lo que se
resolvió (2026-07-30) es cómo escribir *a través* de él: hay que copiar el
archivo a la capa SD, no al overlay.

```bash
# La IP cambia con el DHCP: usa el nombre mDNS, no una IP fija.
RPI=ecosentinel.local

# 1. subir a /tmp (esto sí vive solo en RAM, y está bien: es un tránsito)
scp rpi/inference_engine.py rpi@$RPI:/tmp/

# 2. grabarlo en la capa persistente (la SD)
ssh rpi@$RPI "sudo sh -c '
  mount -o remount,rw /media/root-ro
  install -o 1000 -g 1000 -m 644 /tmp/inference_engine.py \
      /media/root-ro/home/rpi/ecosentinel/inference_engine.py
  sync'"

# 3. reiniciar la RPi y verificar
```

Tres cautelas que ya costaron caro:

1. **Comparar el md5 en los tres puntos** (laptop → `/tmp` → archivo escrito)
   antes de reiniciar. Sin eso, la RPi corrió durante días un motor distinto al
   del repo sin que nadie lo notara.
2. El `remount,ro` en caliente **no funciona** sobre `/media/root-ro` (`EBUSY`:
   el overlay la tiene como `lowerdir`). La SD queda en `rw` hasta el siguiente
   reinicio — reiniciar cuanto antes.
3. **Dejar el motor corriendo ≥2 minutos** antes de dar el cambio por bueno: un
   `UnboundLocalError` que solo aparecía en el primer heartbeat pasó
   desapercibido por comprobar demasiado pronto.

Para probar algo sin tocar la SD, un `scp` normal a `~/ecosentinel/` sirve: se
revierte solo en el siguiente reinicio.

## Uso

```bash
# Validar contra una captura
python3 inference_engine.py --validate captura.pcap

# Producción (así lo lanza systemd; las IPs de confianza vienen del entorno)
sudo python3 inference_engine.py --live wlan0

# Probar otro umbral sin editar código
sudo python3 inference_engine.py --live wlan0 --threshold 0.90 --debug
```

Configuración por entorno (`/home/rpi/ecosentinel/.env.ecosentinel`, **no se
versiona**):

| Variable | Para qué |
|---|---|
| `ECOSENTINEL_API_URL` | URL base de la API (Vercel) |
| `ECOSENTINEL_API_KEY` | API key de ESTE dispositivo |
| `ECOSENTINEL_TRUSTED_IPS` | IPs de administración a excluir, separadas por coma |

`ECOSENTINEL_TRUSTED_IPS` **no** va en el unit de systemd a propósito: el unit
vive en la capa SD (ver arriba), así que cambiar una IP ahí obliga a remontar la
SD y reiniciar la RPi entera. `.env.ecosentinel` no está en esa capa, y la IP de
la laptop de administración **cambia** al mover la RPi de red — el DHCP del
laboratorio no le dará la misma que en casa. Con esto, adaptarla es editar una
línea y `systemctl restart ecosentinel`.

```bash
# En el laboratorio, antes de la demo: averigua la IP real de la laptop
ip -4 addr show wlan0 | grep inet
ssh rpi@ecosentinel.local "sudo sed -i 's/^ECOSENTINEL_TRUSTED_IPS=.*/ECOSENTINEL_TRUSTED_IPS=<IP>/' \
  ~/ecosentinel/.env.ecosentinel && sudo systemctl restart ecosentinel"
ssh rpi@ecosentinel.local "journalctl -u ecosentinel -n 30 | grep -i confianza"
```

`--trusted-ips` sigue existiendo y **se suma** a la variable, para una corrida
puntual sin tocar el entorno. Si no hay ninguna configurada, el motor lo avisa
en el arranque: sin ella, el propio tráfico SSH de administración alimenta al
clasificador y genera falsos positivos.

## Qué se excluye del análisis y por qué

| Exclusión | Motivo |
|---|---|
| `--trusted-ips` (laptop de admin) | El canal de gestión del propio sensor no debe alimentar al clasificador. No excluye el puerto 22 en general: fuerza bruta SSH contra otros hosts sigue viéndose. |
| Resolvers DNS de `/etc/resolv.conf` | Cada resolución genera un flujo UDP de 1-2 paquetes con duración ~0, justo el patrón que el modelo confunde con ataque. Sin esto, cada detección enviada generaba otra en bucle. |
| **Prefijo /24 de la API** | El edge de Vercel rota de IP (se observaron `.3`, `.131`, `.67`, `.195`). Excluir una sola IP dejaba una ventana donde el sensor detectaba su propio tráfico hacia la API y entraba en bucle de amplificación: ~30.000 falsos positivos, uno cada ~0.4 s. |
| Multicast (`224.0.0.0/4`) y broadcast | Descubrimiento normal (mDNS, SSDP). Es seguro: un ataque de reflexión real apunta a la IP unicast de la víctima, nunca al grupo multicast. |
| Broadcast de subred (`192.168.1.255`) | Tráfico normal de LAN (NetBIOS, SMB, DHCP). Antes solo se excluía `255.255.255.255`. |

## Detección de barridos ARP (reconocimiento de red)

Este sensor es un cliente WiFi en modo *managed*: solo ve el tráfico dirigido a
él mismo más el broadcast. Un escaneo de puertos contra **otro** equipo de la red
le pasa desapercibido. Pero la fase de **reconocimiento** — el `nmap -sn` con el
que un atacante empieza para descubrir qué hay en la red — usa **ARP**, y ARP es
broadcast: le llega a todos. Contando cuántas direcciones **distintas** pregunta
cada origen se detecta el barrido aunque no vaya dirigido a nosotros.

> Medido el 2026-07-30: un `nmap -sn 192.168.1.0/24` desde otro equipo generó
> ~198 ARP requests perfectamente visibles desde la RPi.

Esto **no pasa por el modelo**: el RandomForest se entrenó con flujos IP de
CIC-IoT2023 y no tiene features para ARP. Es una **heurística determinista**.

Tres funciones nuevas en `inference_engine.py`:

| Función | Qué hace |
|---|---|
| `check_arp_scan(pkt, trusted_ips)` | Se llama por cada paquete **antes** de `parse_packet()` (que descarta lo que no lleva capa IP, justo por donde viaja el barrido). Si es un ARP *request* (`op==1`, who-has) con `psrc`/`pdst` válidos, lo contabiliza. Ignora `psrc=0.0.0.0` (ARP probes de DHCP, no un barrido). |
| `track_arp_request(src, target, now, trusted_ips)` | Núcleo, **puro salvo por un diccionario de estado** (por eso es testeable sin red). Mantiene por origen los objetivos distintos en una **ventana deslizante de 60 s** (`ARP_SCAN_WINDOW`). Devuelve el nº de objetivos si acaba de cruzar el umbral de **20** (`ARP_SCAN_THRESHOLD`); `None` en cualquier otro caso. |
| `send_arp_scan_detection(src, n)` | Encola la detección a `/api/ingest/detections` con la **IP hasheada** (`hash_ip`, nunca en claro), `attack_type="Port Scanning"`, `protocol="OTHER"` (ARP no es TCP/UDP/ICMP) y `attack_prob=0.99` (certeza heurística, no salida del modelo: preguntar por ≥20 direcciones distintas en 60 s no tiene lectura benigna en una red de PyME). |

Salvaguardas:

- **Cooldown de 5 min** (`ARP_ALERT_COOLDOWN`): un mismo origen no realerta hasta
  pasada la ventana, aunque siga barriendo.
- **Tope de 500 orígenes vigilados** (`ARP_MAX_SOURCES`): al alcanzarlo se purgan
  los inactivos y, en el peor caso, se limpia el diccionario — evita que una red
  ruidosa haga crecer la memoria sin límite.
- **Exclusión coherente con `should_exclude()`**: no basta el match exacto de
  `--trusted-ips`. El **gateway/router** hace ARP legítimo hacia muchos hosts
  (mantiene su tabla ARP) y dispararía un falso barrido, así que se excluye tanto
  la IP de admin (match exacto) como cualquier origen dentro de un prefijo ya
  excluido, vía `in_excluded_network()`. **No** se excluye la /24 local completa:
  eso dejaría fuera al propio atacante y anularía la detección.

Prueba: `tests/test_arp_detection.py` (7 casos, biblioteca estándar). Corre con
`python3 -m unittest tests/test_arp_detection.py`. **No** entra en `npm test`
(ese runner solo toma `tests/*.test.ts`); es código Python que corre en la RPi.

## Fixes aplicados (2026-07-28/29)

1. `hash_ip()` — HMAC-SHA256 de la IP con `.device_salt` local. Un `sha256(ip)`
   sin secreto es reversible por fuerza bruta (el espacio IPv4 son ~4.300
   millones de valores). El salt vive en la capa SD desde el 2026-07-30, así que
   el hash de una misma IP es **estable entre reinicios** y ya se puede
   correlacionar a un mismo atacante. Nunca se transmite y nunca se versiona
   (está en `.gitignore`: este repo es público).
2. Puertos 22/21/3389 → "Brute Force". Antes la regla exigía `syn>0 and ack==0`,
   así que una sesión SSH ya establecida no matcheaba nada y caía al default
   genérico "DDoS".
3. `EXCLUDED_NETWORKS` — exclusión por prefijo (ver tabla arriba).
4. `LOCAL_BROADCASTS` — broadcast de subred.
5. `DETECTION_THRESHOLD_FLOOR = 0.95` — ver el README raíz.
6. `_trusted_ips_ref.update()` en vez de `|=`. La asignación aumentada hacía que
   Python tratara la variable como **local** a una función que solo declaraba
   `global _last_ip_check_ts`, y el hilo emisor moría con `UnboundLocalError` en
   el primer heartbeat — el dashboard mostraba "appliance desconectado".
