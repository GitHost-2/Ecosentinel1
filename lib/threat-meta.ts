// Metadatos de presentación por familia de ataque (color, recomendaciones).
// El porcentaje (`pct`) NO vive aquí: se calcula en tiempo real a partir
// de las detecciones reales en /api/threats.
export const THREAT_META = {
  Ransomware: {
    key: "ransomware",
    color: "#C4694A",
    tips: [
      "Aísla los respaldos fuera de línea para que un cifrado malicioso no los alcance.",
      "Verifica que los backups se puedan restaurar correctamente al menos una vez al mes.",
    ],
  },
  "Brute Force": {
    key: "bruteforce",
    color: "#6FBDB0",
    tips: [
      "Limita los intentos de inicio de sesión y bloquea la IP tras varios fallos consecutivos.",
      "Exige contraseñas largas y activa un segundo factor en los accesos remotos.",
    ],
  },
  "Port Scanning": {
    key: "portscan",
    color: "#D9B44A",
    tips: [
      "Cierra en tu firewall perimetral los puertos que no uses activamente.",
      "Configura alertas ante barridos de puertos repetidos desde una misma IP.",
    ],
  },
  DDoS: {
    key: "ddos",
    color: "#4A90C4",
    tips: [
      "Activa límites de tasa (rate limiting) en los servicios expuestos a internet.",
      "Evalúa un proveedor de mitigación DDoS si dependes de disponibilidad 24/7.",
    ],
  },
  "Botnet Mirai": {
    key: "botnet",
    color: "#8C6FBD",
    tips: [
      "Cambia las contraseñas de fábrica de cámaras y demás dispositivos IoT.",
      "Aísla los dispositivos IoT en una VLAN separada del resto de tu infraestructura.",
    ],
  },
  Spoofing: {
    key: "spoofing",
    color: "#8b99a6",
    tips: [
      "Habilita protección anti-spoofing (DHCP snooping / ARP inspection) en tus switches.",
      "Verifica la identidad de dispositivos nuevos antes de otorgarles acceso a la red.",
    ],
  },
} as const;

export type AttackTypeLabel = keyof typeof THREAT_META;
