#!/usr/bin/env bash
# Endurecimento da VPS (Ubuntu 24.04 LTS) — roda UMA vez como root, depois de subir a VPS e ANTES do Coolify. Idempotente.
#
#   sudo ./harden-vps.sh --ssh-user deploy                    # firewall 80/443 + SSH por chave com limite de tentativas
#   sudo ./harden-vps.sh --ssh-user deploy --tailscale-ssh    # + SSH (22) e painel do Coolify (8000) SÓ pela Tailscale
#   sudo ./harden-vps.sh --ssh-user deploy --dry-run          # só mostra o que faria
#
# Segurança primeiro: o script NUNCA desliga a senha do SSH se o usuário não tiver chave em authorized_keys, e só fecha a porta 22
# para a internet com --tailscale-ssh DEPOIS de confirmar que a Tailscale está conectada (senão você perderia o acesso).
set -euo pipefail

SSH_USER=""; TAILSCALE_SSH=0; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-user) SSH_USER="${2:?informe o usuário}"; shift 2 ;;
    --tailscale-ssh) TAILSCALE_SSH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

run() { if [[ $DRY -eq 1 ]]; then echo "[dry-run] $*"; else eval "$*"; fi; }
[[ $EUID -eq 0 ]] || { echo "rode como root (sudo)" >&2; exit 1; }
[[ -n "$SSH_USER" ]] || { echo "informe --ssh-user <usuário com sudo e chave SSH>" >&2; exit 2; }
id "$SSH_USER" >/dev/null 2>&1 || { echo "usuário $SSH_USER não existe (crie: adduser $SSH_USER && usermod -aG sudo $SSH_USER)" >&2; exit 1; }

echo "==> Pacotes e atualizações automáticas de segurança"
run "apt-get update -y"
run "DEBIAN_FRONTEND=noninteractive apt-get install -y ufw fail2ban unattended-upgrades apt-listchanges curl ca-certificates"
run "cat > /etc/apt/apt.conf.d/52centralops-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot \"true\";
Unattended-Upgrade::Automatic-Reboot-Time \"06:30\";
Unattended-Upgrade::Remove-Unused-Dependencies \"true\";
EOF"
run "systemctl enable --now unattended-upgrades"

echo "==> SSH: só chave, sem root"
AUTH_KEYS="/home/${SSH_USER}/.ssh/authorized_keys"
if [[ -s "$AUTH_KEYS" ]]; then
  run "cat > /etc/ssh/sshd_config.d/99-centralops-hardening.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ${SSH_USER}
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
EOF"
  run "sshd -t && systemctl reload ssh"
else
  echo "AVISO: $AUTH_KEYS vazio/inexistente — SSH por senha mantido (instale sua chave e rode de novo)." >&2
fi

echo "==> fail2ban (SSH)"
run "cat > /etc/fail2ban/jail.d/centralops-sshd.conf <<'EOF'
[sshd]
enabled = true
maxretry = 4
findtime = 10m
bantime = 1h
EOF"
run "systemctl enable --now fail2ban && systemctl restart fail2ban"

echo "==> Firewall (ufw): só 80/443 públicas"
run "ufw --force reset"
run "ufw default deny incoming && ufw default allow outgoing"
run "ufw allow 80/tcp && ufw allow 443/tcp"
if [[ $TAILSCALE_SSH -eq 1 ]]; then
  if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
    # 22 (SSH) e 8000 (painel do Coolify) só pela interface da Tailscale
    run "ufw allow in on tailscale0 to any port 22 proto tcp"
    run "ufw allow in on tailscale0 to any port 8000 proto tcp"
  else
    echo "ERRO: --tailscale-ssh pedido, mas a Tailscale não está conectada. Rode 'curl -fsSL https://tailscale.com/install.sh | sh && tailscale up' e repita." >&2
    exit 1
  fi
else
  run "ufw limit 22/tcp"          # 22 aberta, mas com limite de tentativas; use --tailscale-ssh quando a Tailscale estiver no ar
fi
run "ufw --force enable"

echo "==> Kernel: endurecimento básico de rede"
run "cat > /etc/sysctl.d/99-centralops-hardening.conf <<'EOF'
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.tcp_syncookies = 1
kernel.kptr_restrict = 2
EOF"
run "sysctl --system >/dev/null"

cat <<'EOF'

Pronto. Próximos passos (infra/README.md):
  1. Instalar a Tailscale (se ainda não) e conferir o acesso por ela.
  2. Instalar o Coolify:  curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
  3. IMPORTANTE: o Docker publica portas por fora do ufw. Nunca use "ports:" nos serviços internos (worker, mcp, hermes) —
     o compose de produção já não publica nenhuma; só o Traefik do Coolify escuta 80/443.
  4. Conferir de fora (outra máquina):  nmap -Pn -p- <ip-da-vps>   → só 80 e 443 abertas.
EOF
