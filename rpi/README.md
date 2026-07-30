# Motor de inferencia (Raspberry Pi)

Código que corre **en el dispositivo**, no en Vercel. Se versiona aquí porque
antes vivía solo en la RPi y no había copia en ningún repositorio.

## ⚠️ La RPi borra sus cambios al reiniciar

El arranque lleva `overlayroot=tmpfs` en el cmdline del kernel:

```
/media/root-ro   /dev/mmcblk0p2   ext4 (ro)   <- la tarjeta SD, SOLO LECTURA
/media/root-rw   tmpfs                        <- capa de escritura EN RAM
/                overlay
```

Todo lo que se escriba en el sistema de archivos vive en RAM y **desaparece en
cada reinicio**, volviendo a la imagen de la SD. Esto ya causó que un fix de
privacidad (el hashing de IP) se perdiera dos veces sin que nadie lo tocara.

Mientras siga así, después de cada reinicio hay que volver a subir estos
archivos (hay un script listo en `~/Desktop/backup/RESTAURAR.sh`):

```bash
scp rpi/inference_engine.py rpi@192.168.1.71:~/ecosentinel/
scp rpi/ecosentinel.service rpi@192.168.1.71:/tmp/
ssh rpi@192.168.1.71 "sudo cp /tmp/ecosentinel.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && sudo systemctl restart ecosentinel"
```

Para hacerlo permanente hay que quitar `overlayroot=tmpfs` del cmdline o escribir
en la capa de solo-lectura. **Ninguna de las dos se ha hecho**: un error ahí puede
dejar el dispositivo sin arrancar, así que requiere decisión del dueño.

## Uso

```bash
# Validar contra una captura
python3 inference_engine.py --validate captura.pcap

# Producción (así lo lanza systemd)
sudo python3 inference_engine.py --live wlan0 --trusted-ips 192.168.1.75

# Probar otro umbral sin editar código
sudo python3 inference_engine.py --live wlan0 --threshold 0.90 --debug
```

Configuración por entorno (`/home/rpi/ecosentinel/.env.ecosentinel`, **no se
versiona**): `ECOSENTINEL_API_URL`, `ECOSENTINEL_API_KEY`.

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
   millones de valores). **El salt también se borra al reiniciar**, así que el
   hash de una misma IP cambia entre reinicios.
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
