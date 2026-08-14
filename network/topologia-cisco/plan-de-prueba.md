# Plan de prueba — Topología Cisco EcoSentinel (Packet Tracer)

Este plan monta y verifica la topología de referencia de EcoSentinel en **Cisco
Packet Tracer** (recomendado para la entrega académica). Comprueba dos cosas:

1. Que la **segmentación por VLAN + ACLs** funciona (ping permitido/denegado como
   evidencia de los controles del documento *Arquitectura de red*).
2. Que el **puerto SPAN** entrega el tráfico a la RaspBerry Pi (EcoSentinel) para
   que actúe como *punto de inspección*.

---

## 1. Materiales (dispositivos en Packet Tracer)

| Cant. | Dispositivo Packet Tracer | Rol |
|------|---------------------------|-----|
| 1 | Router **2911** | `R-ECOSENTINEL` — inter-VLAN + ACLs + salida a Internet |
| 1 | Switch **2960** | `SW-ECOSENTINEL` — VLANs, port-security, SPAN |
| 1 | PC | `PC-ADMIN` (VLAN 10) |
| 1 | PC | `PC-USUARIO` (VLAN 20) |
| 1 | PC (o IoT device / SBC) | `IOT-SENSOR` (VLAN 30) |
| 1 | PC | `PC-INVITADO` (VLAN 40) |
| 1 | PC (o SBC "Raspberry Pi") | `RPI-ECOSENTINEL` (captura SPAN + mgmt VLAN 99) |
| 1 | Server (opcional) | `INTERNET` (simula 8.8.8.8 / ISP en 203.0.113.2) |

---

## 2. Cableado

| Extremo A | Puerto A | Extremo B | Puerto B |
|-----------|----------|-----------|----------|
| R-ECOSENTINEL | Gig0/0 | INTERNET (ISP) | — (WAN 203.0.113.0/30) |
| R-ECOSENTINEL | Gig0/1 | SW-ECOSENTINEL | Fa0/1 (**trunk**) |
| SW-ECOSENTINEL | Fa0/2 | PC-ADMIN | Fa0 |
| SW-ECOSENTINEL | Fa0/3 | PC-USUARIO | Fa0 |
| SW-ECOSENTINEL | Fa0/4 | IOT-SENSOR | Fa0 |
| SW-ECOSENTINEL | Fa0/5 | PC-INVITADO | Fa0 |
| SW-ECOSENTINEL | Fa0/10 | RPI-ECOSENTINEL (NIC captura) | Fa0 |
| SW-ECOSENTINEL | Fa0/11 | RPI-ECOSENTINEL (NIC mgmt)   | Fa1 |

> La RPi usa **dos NIC**: Fa0/10 recibe el espejo SPAN (solo escucha) y Fa0/11 la
> conecta a la VLAN 99 para el panel/SSH. Si tu SBC de Packet Tracer tiene una sola
> NIC, usa dos PCs: uno "sniffer" en Fa0/10 y otro "mgmt" en Fa0/11.

---

## 3. Direccionamiento IP de los hosts de prueba

| Host | VLAN | IP | Máscara | Gateway |
|------|------|----|---------|---------|
| PC-ADMIN | 10 | 192.168.10.10 | 255.255.255.0 | 192.168.10.1 |
| PC-USUARIO | 20 | 192.168.20.20 | 255.255.255.0 | 192.168.20.1 |
| IOT-SENSOR | 30 | 192.168.30.30 | 255.255.255.0 | 192.168.30.1 |
| PC-INVITADO | 40 | 192.168.40.40 | 255.255.255.0 | 192.168.40.1 |
| RPI mgmt | 99 | 192.168.99.71 | 255.255.255.0 | 192.168.99.1 |
| SW (SVI mgmt) | 99 | 192.168.99.2 | 255.255.255.0 | 192.168.99.1 |
| INTERNET (ISP) | — | 203.0.113.2 | 255.255.255.252 | — |

> La NIC de **captura** de la RPi (Fa0/10) no necesita IP: opera en modo promiscuo
> escuchando el espejo. En producción la RPi vive en `192.168.1.71` (WiFi managed);
> el `.99.71` de aquí es su equivalente de laboratorio cableado.

---

## 4. Carga de configuración

1. Doble clic en `SW-ECOSENTINEL` → pestaña **CLI** → pega el contenido de
   `config-switch.txt`.
2. Doble clic en `R-ECOSENTINEL` → pestaña **CLI** → pega `config-router.txt`.
3. Configura las IP de los hosts (tabla del punto 3) en *Desktop → IP Configuration*.

> Si Packet Tracer rechaza `encapsulation replicate` en la línea de `monitor
> session`, quítala: `monitor session 1 destination interface FastEthernet0/10`.
> El espejo funciona igual; solo se pierde la etiqueta 802.1Q en el destino.

---

## 5. Verificación de la SEGMENTACIÓN (evidencia principal)

Desde el *Command Prompt* de cada PC ejecuta `ping` al destino y registra el
resultado. **La ACL correcta produce el resultado de la columna "Esperado".**

### 5.1 Tabla de resultados esperados (origen → destino → permitido/denegado)

| # | Origen (VLAN) | Destino (VLAN) | IP destino | Esperado | Control del documento |
|---|---------------|----------------|-----------|----------|-----------------------|
| 1 | PC-ADMIN (10) | PC-USUARIO (20) | 192.168.20.20 | ✅ PERMITIDO | Admin = privilegios elevados |
| 2 | PC-ADMIN (10) | IOT-SENSOR (30) | 192.168.30.30 | ✅ PERMITIDO | Admin puede administrar IoT |
| 3 | PC-ADMIN (10) | PC-INVITADO (40) | 192.168.40.40 | ✅ PERMITIDO | Admin acceso total |
| 4 | PC-ADMIN (10) | INTERNET | 203.0.113.2 | ✅ PERMITIDO | Salida a Internet |
| 5 | PC-USUARIO (20) | PC-ADMIN (10) | 192.168.10.10 | ⛔ DENEGADO | Separar usuarios de admin |
| 6 | PC-USUARIO (20) | SW mgmt (99) | 192.168.99.2 | ⛔ DENEGADO | Gestión aislada |
| 7 | PC-USUARIO (20) | IOT-SENSOR (30) | 192.168.30.30 | ✅ PERMITIDO | Usuarios operan sensores |
| 8 | PC-USUARIO (20) | INTERNET | 203.0.113.2 | ✅ PERMITIDO | Salida a Internet |
| 9 | IOT-SENSOR (30) | PC-ADMIN (10) | 192.168.10.10 | ⛔ DENEGADO | IoT sin acceso a área crítica |
| 10 | IOT-SENSOR (30) | PC-USUARIO (20) | 192.168.20.20 | ⛔ DENEGADO | IoT aislado |
| 11 | IOT-SENSOR (30) | PC-INVITADO (40) | 192.168.40.40 | ⛔ DENEGADO | IoT aislado |
| 12 | IOT-SENSOR (30) | INTERNET | 203.0.113.2 | ✅ PERMITIDO | IoT solo telemetría/Internet |
| 13 | PC-INVITADO (40) | PC-ADMIN (10) | 192.168.10.10 | ⛔ DENEGADO | Invitados sin recursos internos |
| 14 | PC-INVITADO (40) | PC-USUARIO (20) | 192.168.20.20 | ⛔ DENEGADO | Invitados sin recursos internos |
| 15 | PC-INVITADO (40) | IOT-SENSOR (30) | 192.168.30.30 | ⛔ DENEGADO | Invitados sin recursos internos |
| 16 | PC-INVITADO (40) | INTERNET | 203.0.113.2 | ✅ PERMITIDO | Invitados SOLO salida a Internet |

> "DENEGADO" en Packet Tracer se ve como `Reply from 192.168.x.1: Destination host
> unreachable` (lo rechaza la ACL del router) o `Request timed out`. "PERMITIDO" =
> `Reply from <IP destino>: bytes=32 ...`.

### 5.2 Confirmar por qué se deniega (opcional, en el router)

```
R-ECOSENTINEL# show access-lists
```
Los contadores `(N match(es))` en las líneas `deny` crecen con cada ping bloqueado
= evidencia de que la ACL actuó.

### 5.3 Verificar VLANs y port-security en el switch

```
SW-ECOSENTINEL# show vlan brief            ! cada puerto en su VLAN
SW-ECOSENTINEL# show interfaces trunk      ! Fa0/1 trunk, VLANs permitidas
SW-ECOSENTINEL# show port-security         ! max 1, sticky, secure-up
```

---

## 6. Verificación del PUERTO SPAN (punto de inspección)

Objetivo: comprobar que la RPi **ve tráfico de otras VLANs** (lo que no puede en
modo managed real; ver README §7), habilitando la detección de escaneos entre
terceros.

1. Verifica la sesión de monitoreo en el switch:
   ```
   SW-ECOSENTINEL# show monitor session 1
   ```
   Debe mostrar: `Source VLANs (Both): 10,20,30,40` y
   `Destination Ports: Fa0/10`.

2. Pon Packet Tracer en modo **Simulation** (esquina inferior derecha) y filtra
   por **ICMP**.

3. Genera tráfico **entre dos hosts que NO son la RPi**: por ejemplo
   `PC-USUARIO (20)` hace `ping 192.168.30.30` (IOT-SENSOR).

4. Observa el flujo de paquetes: cada paquete que cruza el switch se **duplica**
   hacia `Fa0/10` (RPi). En modo Simulation verás una copia del ICMP viajando al
   puerto de la RPi aunque ni el origen ni el destino sean la RPi.
   → **Evidencia**: la RPi recibe tráfico de terceros = el SPAN funciona.

5. (IOS/Linux real) En la RPi: `sudo tcpdump -i eth-captura -n` muestra el tráfico
   espejeado de las 4 VLANs. Ese es exactamente el flujo que EcoSentinel
   preprocesa y clasifica con Random Forest / LightGBM (doc, sección 3.1).

---

## 7. Criterios de aceptación

- [ ] Las 16 pruebas de la tabla 5.1 coinciden con la columna **Esperado**.
- [ ] `show access-lists` muestra `match` creciente en las líneas `deny`.
- [ ] `show port-security` muestra los 5 accesos en `Secure-up` con 1 MAC sticky.
- [ ] `show monitor session 1` lista Fa0/10 como destino con las 4 VLANs origen.
- [ ] En Simulation, un ping entre dos terceros se duplica hacia el puerto de la RPi.

Si los 5 puntos se cumplen, la topología reproduce fielmente los controles del
documento *Arquitectura de red* de EcoSentinel.
