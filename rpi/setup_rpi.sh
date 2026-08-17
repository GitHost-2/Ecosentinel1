#!/bin/bash
# ============================================================
#  EcoSentinel — Setup del Raspberry Pi 3A+ (ejecutar EN el RPi)
#  Requiere: Raspberry Pi OS Lite (64-bit recomendado, headless)
#  Uso:  chmod +x setup_rpi.sh && ./setup_rpi.sh
#  (NO uses sudo para todo el script; pedira sudo solo donde haga falta)
# ============================================================
set -e

# Usuario real (no root), aunque se invoque con sudo
REAL_USER="${SUDO_USER:-$USER}"
HOME_DIR="$(eval echo ~$REAL_USER)"
APP_DIR="$HOME_DIR/ecosentinel"

echo "======================================================"
echo "  EcoSentinel — Preparando Raspberry Pi 3A+"
echo "  Usuario: $REAL_USER"
echo "  Carpeta: $APP_DIR"
echo "======================================================"

# 1. Sistema base (requiere sudo)
echo "[1/7] Instalando paquetes del sistema..."
sudo apt-get update
sudo apt-get install -y python3 python3-pip python3-venv libopenblas-dev tcpdump

# 2. Estructura (como el usuario real, no root)
echo "[2/7] Creando estructura de carpetas..."
mkdir -p "$APP_DIR/models" "$APP_DIR/logs"
cd "$APP_DIR"

# 3. Entorno virtual
echo "[3/7] Creando entorno virtual..."
python3 -m venv .venv
source .venv/bin/activate

# 4. Dependencias (incluye scapy, sin el cual el motor no corre).
#    --prefer-binary usa wheels ARM de piwheels y evita compilar.
echo "[4/7] Instalando dependencias de Python..."
pip install --upgrade pip
pip install numpy scikit-learn joblib scapy psutil --prefer-binary

echo ""
echo "  >>> IMPORTANTE sobre la version de scikit-learn <<<"
echo "  La version aqui debe ser >= a la usada al entrenar en la laptop."
echo "  Verificala con:  pip show scikit-learn"
echo "  Si validate_artifacts.py falla, ajusta la version:"
echo "     pip install scikit-learn==<version_de_la_laptop>"
echo ""

# 5. Permisos de captura sin root.
#    setcap debe aplicarse al BINARIO REAL de python, no al symlink
#    del venv. Resolvemos la ruta real con readlink -f.
echo "[5/7] Configurando permisos de captura (AF_PACKET)..."
REAL_PY="$(readlink -f .venv/bin/python3)"
sudo setcap 'cap_net_raw,cap_net_admin+eip' "$REAL_PY" || \
    echo "  (setcap fallo — podras usar 'sudo python3' como alternativa)"
echo "  Binario con permisos: $REAL_PY"

# 6. Zram — memoria comprimida para aliviar los 512 MB
echo "[6/7] Activando zram (memoria comprimida)..."
sudo apt-get install -y zram-tools
if [ -f /etc/default/zramswap ]; then
    sudo sed -i 's/^#\?ALGO=.*/ALGO=lz4/' /etc/default/zramswap
    sudo sed -i 's/^#\?PERCENT=.*/PERCENT=50/' /etc/default/zramswap
    sudo systemctl restart zramswap || true
fi

# 7. Archivo de entorno (API URL/key + IPs de confianza). Nunca se pisa uno
#    existente: llevaria la API key de este dispositivo.
echo "[7/7] Preparando .env.ecosentinel..."
ENV_FILE="$APP_DIR/.env.ecosentinel"
if [ -f "$ENV_FILE" ]; then
    echo "  Ya existe, se respeta: $ENV_FILE"
else
    cp "$(dirname "$0")/env.ecosentinel.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  Creado desde la plantilla: $ENV_FILE  (EDITALO antes de arrancar)"
fi

# Ajustar dueño de todo a usuario real (por si algo se creo como root)
sudo chown -R "$REAL_USER":"$REAL_USER" "$APP_DIR"

echo ""
echo "======================================================"
echo "  Setup completo."
echo ""
echo "  SIGUIENTES PASOS:"
echo "  1. Copia los 4 .pkl a: $APP_DIR/models/"
echo "     - ecosentinel_model_rpi.pkl"
echo "     - optimal_threshold_rpi.pkl"
echo "     - scaler.pkl"
echo "     - selected_features.pkl"
echo ""
echo "  2. EDITA $APP_DIR/.env.ecosentinel:"
echo "     - ECOSENTINEL_API_URL / ECOSENTINEL_API_KEY"
echo "     - ECOSENTINEL_TRUSTED_IPS = la IP de ESTA laptop en la red actual"
echo "       (cambia al mover la RPi de red: revisala antes de cada demo)"
echo ""
echo "  3. Activa el entorno:  source $APP_DIR/.venv/bin/activate"
echo "  4. Valida artefactos:  python3 validate_artifacts.py"
echo "  5. Prueba con pcap:    python3 inference_engine.py --validate captura.pcap"
echo "  6. Captura en vivo:    python3 inference_engine.py --live wlan0"
echo "======================================================"
