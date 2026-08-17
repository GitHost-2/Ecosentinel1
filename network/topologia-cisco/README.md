# Topología de red Cisco — EcoSentinel

Diseño de referencia de la red segmentada de EcoSentinel en equipo Cisco (IOS CLI),
alineado con el documento rector **`Arquitectura de red.pdf`** (Carpeta 2 —
Planificación Técnica y de Calidad). Listo para montarse en **Cisco Packet Tracer**
o IOS real 15.x.

## Contenido del directorio

| Archivo | Descripción |
|---------|-------------|
| `config-switch.txt` | Config IOS del switch 2960: VLANs, accesos, port-security, **SPAN** y hardening. |
| `config-router.txt` | Config IOS del router 2911: router-on-a-stick inter-VLAN + **ACLs** de segmentación. |
| `plan-de-prueba.md` | Montaje en Packet Tracer, verificación de segmentación (tabla ping) y del SPAN. |
| `README.md` | Este archivo: diagrama, mapeo doc→config y decisión de diseño del SPAN. |

---

## 1. Diagrama de la topología

```mermaid
flowchart TB
    NET(("Internet"))
    MODEM["Modem / Router ISP<br/>203.0.113.2"]

    subgraph ROUTER["R-ECOSENTINEL (Cisco 2911) - Inter-VLAN + ACLs"]
        direction TB
        G00["Gig0/0 WAN<br/>203.0.113.1"]
        TRUNK["Gig0/1 (trunk 802.1Q)<br/>subif .10 .20 .30 .40 .99"]
    end

    subgraph SWITCH["SW-ECOSENTINEL (Cisco 2960) - VLANs + port-security + SPAN"]
        direction TB
        SWT["Fa0/1 TRUNK"]
        P2["Fa0/2 acc VLAN10"]
        P3["Fa0/3 acc VLAN20"]
        P4["Fa0/4 acc VLAN30"]
        P5["Fa0/5 acc VLAN40"]
        SPAN["Fa0/10 SPAN-DST (mirror)"]
        MGMT["Fa0/11 acc VLAN99"]
    end

    PCA["PC-ADMIN<br/>VLAN10 192.168.10.10"]
    PCU["PC-USUARIO<br/>VLAN20 192.168.20.20"]
    IOT["IOT-SENSOR<br/>VLAN30 192.168.30.30"]
    PCG["PC-INVITADO<br/>VLAN40 192.168.40.40"]
    RPI["RPI-ECOSENTINEL (punto de inspeccion)<br/>captura=Fa0/10 &nbsp; mgmt=192.168.99.71"]

    NET --- MODEM --- G00
    TRUNK === SWT
    SWT --- P2 --- PCA
    SWT --- P3 --- PCU
    SWT --- P4 --- IOT
    SWT --- P5 --- PCG
    MGMT --- RPI
    SPAN -. "trafico espejeado de VLAN 10/20/30/40" .-> RPI
```

**Flujo (doc, sección 2.1):** Internet → módem/router → *EcoSentinel (punto de
inspección)* → switch → VLANs. En el laboratorio, el router 2911 es el gateway
inter-VLAN y frontera a Internet, y la inspección la realiza la RPi recibiendo el
**espejo SPAN** de todo el tráfico interno.

### Plan de direccionamiento (una subred /24 por VLAN)

| VLAN | Nombre | Subred | Gateway | Dispositivo de prueba |
|------|--------|--------|---------|-----------------------|
| 10 | ADMINISTRATIVA | 192.168.10.0/24 | .1 | PC-ADMIN (.10) |
| 20 | USUARIOS | 192.168.20.0/24 | .1 | PC-USUARIO (.20) |
| 30 | IOT | 192.168.30.0/24 | .1 | IOT-SENSOR (.30) |
| 40 | INVITADOS | 192.168.40.0/24 | .1 | PC-INVITADO (.40) |
| 99 | GESTION | 192.168.99.0/24 | .1 | SW SVI (.2), RPi mgmt (.71) |
| 999 | BLACKHOLE | — (sin gateway) | — | puertos no usados (apagados) |

---

## 2. Mapeo del documento "Arquitectura de red" → configuración

| Elemento del PDF (sección 2.2 / 3.2) | Control indicado | Dónde se implementa |
|--------------------------------------|------------------|---------------------|
| **Módem / Router** | Config segura, desactivar servicios | `config-router.txt`: SSH v2 (transporte cifrado, sin credenciales — dispositivo compartido), `no ip http server`, `no cdp run` |
| **Switch administrable** | VLANs, control de puertos, aislamiento | `config-switch.txt`: `vlan 10-40`, `port-security`, puertos no usados a VLAN 999 apagados |
| **Raspberry Pi / EcoSentinel** | Punto de inspección, IDS, registro | Puerto **SPAN** `monitor session 1` → Fa0/10 (RPi) |
| **Red administrativa** | Acceso restringido, privilegios elevados | VLAN 10 + `ACL-ADMIN` (acceso completo) |
| **Red de usuarios** | Políticas de navegación | VLAN 20 + `ACL-USUARIOS` (sin admin/gestión) |
| **Red IoT** | Aislamiento, bloqueo a áreas críticas | VLAN 30 + `ACL-IOT` (aislado de todo lo interno, solo Internet) |
| **Red de invitados** | Solo salida a Internet, sin recursos internos | VLAN 40 + `ACL-INVITADOS` (deny a 10/20/30/99, permit Internet) |
| **Segmentación de red** (principio) | Separar admin/usuarios/IoT/invitados | 4 VLANs + subredes /24 independientes |
| **Mínimo privilegio** (principio) | Solo lo necesario | ACLs deny-first, puertos no usados apagados, `port-security max 1` |
| **Monitoreo continuo** (principio) | Registro de conexiones y anomalías | SPAN hacia RPi (IDS + modelos IA, doc 3.1) |
| **Trazabilidad** (principio) | Todo evento documentado | `banner motd` en router y switch |
| **"Separar IoT e invitados de la red administrativa"** (regla 3.2) | — | `ACL-IOT` y `ACL-INVITADOS` niegan VLAN 10 |
| **"Bloquear por defecto conexiones no solicitadas"** (regla 3.2) | — | `deny` explícitos + `deny ip any any` implícito de cada ACL |

---

## 3. Decisión de diseño: ¿por qué un puerto SPAN?

El documento coloca a EcoSentinel como **"punto central de inspección"** entre el
módem y la red. Sin embargo, la RaspBerry Pi real es un **cliente WiFi en modo
*managed*** y, según `README_ECOSENTINEL.md` §7:

> *"La RPi no ve el tráfico entre otros dos dispositivos de la red… solo ve tráfico
> hacia/desde sí misma y broadcast."*

En una topología con switch, un host normal **no** ve el tráfico conmutado entre
otros puertos (el switch solo lo envía al puerto destino). Para que EcoSentinel
cumpla su rol de inspección y **detecte escaneos entre terceros**, la solución
correcta y estándar es un **puerto SPAN / mirror**:

```
monitor session 1 source vlan 10,20,30,40 both
monitor session 1 destination interface FastEthernet0/10   ! puerto de la RPi
```

El switch **replica** todo el tráfico de las 4 VLANs hacia el puerto de la RPi, que
lo escucha en modo promiscuo. Así el diseño Cisco entrega a EcoSentinel exactamente
lo que su modo managed le niega, sin poner a la RPi en línea (sigue sin cortar
tráfico por sí sola; el bloqueo se confirma en el router — coherente con §7).

---

## 4. Tabla de verificación de segmentación (resumen)

| Origen → Destino | Resultado | Origen → Destino | Resultado |
|------------------|-----------|------------------|-----------|
| Admin → Usuarios | ✅ PERMIT | IoT → Admin | ⛔ DENY |
| Admin → IoT | ✅ PERMIT | IoT → Usuarios | ⛔ DENY |
| Admin → Invitados | ✅ PERMIT | IoT → Invitados | ⛔ DENY |
| Admin → Internet | ✅ PERMIT | IoT → Internet | ✅ PERMIT |
| Usuarios → Admin | ⛔ DENY | Invitados → Admin | ⛔ DENY |
| Usuarios → Gestión | ⛔ DENY | Invitados → Usuarios | ⛔ DENY |
| Usuarios → IoT | ✅ PERMIT | Invitados → IoT | ⛔ DENY |
| Usuarios → Internet | ✅ PERMIT | Invitados → Internet | ✅ PERMIT |

Procedimiento y comandos de comprobación (`ping`, `show access-lists`,
`show monitor session 1`) en **`plan-de-prueba.md`**.

---

## 5. Alcance / presupuesto y relación con la demo real

El **Plan de Adquisiciones** fija un presupuesto de **$3,000 MXN** (RPi 3A+ +
microSD, proyecto de bajo costo). Un switch administrable Cisco y un router 2911
**exceden ese presupuesto**, por lo que esta topología Cisco es el **diseño de
referencia / entorno de laboratorio (Packet Tracer)**, no el despliegue casero.

**Demo real (bajo presupuesto):** en el laboratorio físico EcoSentinel corre en la
RPi 3A+ como cliente WiFi (modo managed, `192.168.1.71`) detrás de un repetidor/AP
WiFi doméstico; ve su propio tráfico + broadcast y los ataques de prueba se dirigen
**a la RPi**. La topología Cisco de este directorio demuestra cómo se vería el mismo
diseño con segmentación real por VLAN y un SPAN entregando todo el tráfico a
EcoSentinel — es la evolución "empresarial" del mismo modelo de defensa en
profundidad, minimo privilegio, segmentación, monitoreo y trazabilidad del documento.

## 6. Topología real del laboratorio (hardware disponible, 2026-08-17)

Con el equipo Cisco físico disponible pero **sin switch administrable con
Ethernet libre para la RPi**, el montaje real del laboratorio es más simple que
el diseño de referencia de arriba:

```mermaid
flowchart LR
    NET(("Internet"))
    REP["Repetidor WiFi<br/>(hace de ISP)"]
    R["Router Cisco<br/>R-ECOSENTINEL"]
    SW["Switch Cisco<br/>SW-ECOSENTINEL"]
    C1["Cliente 1"]
    C2["Cliente 2"]
    RPI["RPi EcoSentinel<br/>cliente WiFi del repetidor"]
    LAP["Laptop<br/>servidor DHCP (Fa0/6, VLAN99)"]

    NET --- REP
    REP -.WiFi.-> RPI
    REP --- R
    R --- SW
    SW --- C1
    SW --- C2
    SW --- LAP
```

### ¿Dónde conecto la RPi si no tiene puerto Ethernet?

**Al repetidor WiFi, tal como lo planteaste — es la única opción real.** La
RPi 3A+ no tiene Ethernet integrado, así que no puede ir a un puerto del
switch (ni al SPAN Fa0/10 del diseño de referencia).

**Pero esto tiene una consecuencia que hay que decir con honestidad:** el
repetidor WiFi y el switch Cisco son dos medios físicos separados. La RPi,
colgada del WiFi del repetidor, **no verá el tráfico entre los 2 clientes del
switch** — ni aunque configures el SPAN de `config-switch.txt`, porque un
puerto SPAN solo puede replicar tráfico hacia un puerto **Ethernet**
conectado directamente, y la RPi no tiene ninguno. El SPAN de este directorio
sigue siendo válido como diseño de referencia (Packet Tracer), pero **no
aplica a este montaje físico** tal cual.

Con este montaje, la RPi detecta exactamente lo mismo que ya está validado y
documentado en `01-Contexto/Alcance real de detección.md` de la bóveda:
ataques dirigidos a ella misma, y reconocimiento de red (barridos ARP) en
todo el segmento WiFi del repetidor — **no** ataques entre los 2 clientes
del switch, porque esos nunca llegan al aire del repetidor.

**Si de verdad necesitas que la RPi vea el tráfico del switch:** la única
forma real es un adaptador USB-Ethernet barato (~$100-150 MXN, un puerto
USB libre en la 3A+) conectado directamente al puerto SPAN (Fa0/10). Con eso
sí aplica el diseño de referencia completo. Sin él, hoy, el alcance es el de
arriba — decílo así en la defensa en vez de prometer algo que el hardware no
puede cumplir.

### Servidor DHCP para los 2 clientes del switch

Ya existe y está listo: `dhcp-server-ecosentinel.sh` (este mismo directorio).
Conecta la laptop al puerto **Fa0/6** del switch (VLAN 99, recién dedicado a
esto — antes estaba apagado como "no usado", corregido hoy) y corre:

```bash
sudo ./dhcp-server-ecosentinel.sh start eth0
```

Reparte las 4 subredes VLAN por `ip helper-address 192.168.99.10`, que
**faltaba** en `config-router.txt` (agregado hoy en las 4 subinterfaces —
sin eso, las peticiones DHCP de los clientes nunca llegaban a la laptop). Con
solo 2 clientes conectados (a los puertos Fa0/2 y Fa0/3, VLAN10/VLAN20), basta
con levantar el servidor una vez; las otras 2 subredes (IoT/invitados) quedan
sirviendo aunque no haya dispositivo conectado ahí.

### Bloqueador de anuncios en la RPi — no se agregó

Se evaluó (Pi-hole u similar) y **se decidió no instalarlo**, por lo que tú
mismo condicionaste: la RPi 3A+ tiene muy poco margen libre hoy —
[[Límites de memoria y cgroups]] documenta que el motor ya usa 165-240 MB de
los ~415 MB útiles, y el 2026-08-16 se confirmó que la fuente de alimentación
está al límite (undervoltage real, dos reinicios no planeados). Sumar otro
servicio persistente (dnsmasq + su propio consumo) el mismo día de la entrega
es un riesgo que no vale la pena — un bloqueador de anuncios no es parte de
lo que se evalúa, y un brownout a media demo sí sería grave.
