#!/usr/bin/env bash
#
# dhcp-server-ecosentinel.sh
#
# Convierte esta laptop en el servidor DHCP de la topologia EcoSentinel.
# Se conecta por cable al puerto Fa0/6 del switch (VLAN 99) y reparte IPs a las
# cuatro VLANs. El router hace de relay (ip helper-address 192.168.99.10), asi
# que la laptop necesita UNA sola IP aunque sirva cuatro subredes.
#
#   sudo ./dhcp-server-ecosentinel.sh start [interfaz]    # levantar (por defecto eth0)
#   sudo ./dhcp-server-ecosentinel.sh status              # ver estado y leases
#   sudo ./dhcp-server-ecosentinel.sh stop                # parar el servicio
#   sudo ./dhcp-server-ecosentinel.sh restore             # dejar todo como estaba
#
# Los archivos originales se respaldan antes de tocarlos; 'restore' los repone.

set -euo pipefail

SRV_IP="192.168.99.10"
SRV_CIDR="24"
SRV_GW="192.168.99.1"
DNS="8.8.8.8, 8.8.4.4"
NM_CON="ecosentinel-dhcp"
CONF="/etc/dhcp/dhcpd.conf"
DEFAULTS="/etc/default/isc-dhcp-server"
BACKUP_DIR="/var/backups/ecosentinel-dhcp"
LEASES="/var/lib/dhcp/dhcpd.leases"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { rojo "Ejecuta con sudo."; exit 1; }

# La accion es OBLIGATORIA y explicita. Sin argumentos NO se hace nada: 'start'
# reconfigura la red de esta maquina, y no debe dispararse por un descuido.
if [[ $# -eq 0 ]]; then
    cat <<'AYUDA'
Uso: sudo ./dhcp-server-ecosentinel.sh {start|status|stop|restore} [interfaz]

  start [iface]   Levanta el servidor DHCP (por defecto eth0).
                  MODIFICA LA RED de esta maquina: fija 192.168.99.10 en la
                  interfaz indicada e instala/configura isc-dhcp-server.
  status          Muestra el estado del servicio y las IPs entregadas.
  stop            Detiene el servicio (no deshace la configuracion).
  restore         Repone la configuracion original respaldada.

Antes de 'start': conecta el cable de esta laptop al puerto Fa0/6 del switch
(VLAN 99) y comprueba que el router tenga 'ip helper-address 192.168.99.10'.
AYUDA
    exit 1
fi

ACCION="$1"
IFACE="${2:-eth0}"

# --------------------------------------------------------------------------
# Genera la declaracion de una subred. Los pools coinciden con la topologia:
# gateway .1, rango .100-.149 (50 hosts, como el 'Maximum Users 50' del server
# de Packet Tracer).
# --------------------------------------------------------------------------
subred() {
    local red="$1" nombre="$2"
    cat <<EOF

# VLAN ${red##*.} - $nombre
subnet 192.168.$red.0 netmask 255.255.255.0 {
    range 192.168.$red.100 192.168.$red.149;
    option routers 192.168.$red.1;
    option subnet-mask 255.255.255.0;
    option domain-name-servers $DNS;
    option broadcast-address 192.168.$red.255;
}
EOF
}

escribir_conf() {
    mkdir -p "$BACKUP_DIR"
    for f in "$CONF" "$DEFAULTS"; do
        if [[ -f "$f" && ! -f "$BACKUP_DIR/$(basename "$f").orig" ]]; then
            cp -a "$f" "$BACKUP_DIR/$(basename "$f").orig"
            info "Respaldo: $BACKUP_DIR/$(basename "$f").orig"
        fi
    done

    {
        echo "# Generado por dhcp-server-ecosentinel.sh - topologia EcoSentinel"
        echo "# NO editar a mano: 'restore' repone la configuracion original."
        echo
        echo "default-lease-time 600;"
        echo "max-lease-time 7200;"
        echo "authoritative;"
        echo
        echo "# Subred a la que la laptop esta conectada fisicamente (VLAN 99)."
        echo "# Va sin 'range': aqui no se reparten IPs, solo declara la red para"
        echo "# que dhcpd acepte arrancar en esta interfaz."
        echo "subnet 192.168.99.0 netmask 255.255.255.0 {"
        echo "    option routers $SRV_GW;"
        echo "    option subnet-mask 255.255.255.0;"
        echo "    option domain-name-servers $DNS;"
        echo "}"
        subred 10 ADMINISTRATIVA
        subred 20 USUARIOS
        subred 30 IOT
        subred 40 INVITADOS
    } > "$CONF"

    echo "INTERFACESv4=\"$IFACE\"" >  "$DEFAULTS"
    echo "INTERFACESv6=\"\""       >> "$DEFAULTS"
    verde "Configuracion escrita ($CONF)"
}

fijar_ip() {
    ip link show "$IFACE" >/dev/null 2>&1 || { rojo "No existe la interfaz $IFACE."; ip -br link show; exit 1; }

    if systemctl is-active --quiet NetworkManager && command -v nmcli >/dev/null; then
        nmcli connection delete "$NM_CON" >/dev/null 2>&1 || true
        nmcli connection add type ethernet con-name "$NM_CON" ifname "$IFACE" \
            ipv4.method manual ipv4.addresses "$SRV_IP/$SRV_CIDR" \
            ipv4.gateway "$SRV_GW" ipv4.dns "8.8.8.8" \
            ipv6.method disabled autoconnect no >/dev/null
        nmcli connection up "$NM_CON" >/dev/null
        info "IP fijada con NetworkManager (perfil '$NM_CON')"
    else
        ip addr flush dev "$IFACE"
        ip addr add "$SRV_IP/$SRV_CIDR" dev "$IFACE"
        ip link set "$IFACE" up
        info "IP fijada con iproute2 (temporal, se pierde al reiniciar)"
    fi
}

case "$ACCION" in
start)
    info "Interfaz: $IFACE   IP del servidor: $SRV_IP/$SRV_CIDR"

    if ! dpkg -s isc-dhcp-server >/dev/null 2>&1; then
        info "Instalando isc-dhcp-server..."
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq isc-dhcp-server
    fi

    # dnsmasq compite por el puerto 67 y hace fallar el arranque.
    if systemctl is-active --quiet dnsmasq; then
        info "Deteniendo dnsmasq (ocupa el puerto 67)"
        systemctl stop dnsmasq
    fi

    fijar_ip
    escribir_conf
    [[ -f "$LEASES" ]] || { mkdir -p "$(dirname "$LEASES")"; : > "$LEASES"; }

    info "Validando la sintaxis antes de arrancar..."
    if ! dhcpd -t -cf "$CONF" >/dev/null 2>&1; then
        rojo "La configuracion tiene errores. Detalle:"
        dhcpd -t -cf "$CONF" || true
        exit 1
    fi
    verde "Sintaxis correcta"

    systemctl restart isc-dhcp-server
    sleep 2
    if systemctl is-active --quiet isc-dhcp-server; then
        verde "Servidor DHCP ACTIVO en $IFACE ($SRV_IP)"
        echo
        echo "  Reparte:  VLAN10 192.168.10.100-149    VLAN20 192.168.20.100-149"
        echo "            VLAN30 192.168.30.100-149    VLAN40 192.168.40.100-149"
        echo
        echo "  El router debe tener 'ip helper-address $SRV_IP' en cada subinterfaz."
        echo "  Ver leases:  sudo $0 status"
    else
        rojo "El servicio no arranco. Diagnostico:"
        journalctl -u isc-dhcp-server -n 25 --no-pager
        exit 1
    fi
    ;;

status)
    echo "--- servicio ---"
    systemctl is-active isc-dhcp-server || true
    echo "--- IP del servidor ---"
    ip -br addr show "$IFACE" 2>/dev/null || echo "interfaz $IFACE no encontrada"
    echo "--- concesiones entregadas ---"
    if [[ -f "$LEASES" ]] && grep -q "^lease" "$LEASES" 2>/dev/null; then
        awk '/^lease/{ip=$2} /binding state active/{print "  " ip}' "$LEASES" | sort -u
    else
        echo "  (ninguna todavia)"
    fi
    ;;

stop)
    systemctl stop isc-dhcp-server 2>/dev/null || true
    verde "Servidor DHCP detenido"
    ;;

restore)
    systemctl stop isc-dhcp-server 2>/dev/null || true
    systemctl disable isc-dhcp-server >/dev/null 2>&1 || true
    for f in dhcpd.conf isc-dhcp-server; do
        if [[ -f "$BACKUP_DIR/$f.orig" ]]; then
            case "$f" in
                dhcpd.conf)       cp -a "$BACKUP_DIR/$f.orig" "$CONF" ;;
                isc-dhcp-server)  cp -a "$BACKUP_DIR/$f.orig" "$DEFAULTS" ;;
            esac
            info "Repuesto $f"
        fi
    done
    if command -v nmcli >/dev/null; then
        nmcli connection delete "$NM_CON" >/dev/null 2>&1 && info "Perfil '$NM_CON' eliminado" || true
    fi
    verde "Estado original restaurado"
    ;;

*)
    echo "Uso: sudo $0 {start|status|stop|restore} [interfaz]"
    exit 1
    ;;
esac
