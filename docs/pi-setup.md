# Raspberry Pi Setup Guide

A Pi 3B+ or newer runs this app comfortably alongside other services. These steps take about 15 minutes on a fresh Pi OS install.

## What you'll need

- Raspberry Pi 3B+ or newer (1 GB+ RAM)
- Pi OS Lite (64-bit) — [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
- SSH access or a keyboard/monitor connected to the Pi
- Your Fox ESS API key and inverter serial number

---

## Step 1 — Flash Pi OS and enable SSH

Using Raspberry Pi Imager:
1. Choose **Raspberry Pi OS Lite (64-bit)**
2. Click the ⚙ gear icon and set your hostname, enable SSH, and pre-fill your Wi-Fi credentials
3. Write the card, insert it into the Pi, and power on

SSH in once it boots:
```bash
ssh pi@raspberrypi.local   # or whatever hostname you set
```

---

## Step 2 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Verify:
```bash
docker run --rm hello-world
```

---

## Step 3 — Clone and run setup

```bash
git clone https://github.com/VectorXYZing/fox-ess-management.git
cd fox-ess-management
bash setup.sh
```

`setup.sh` will prompt for your API key, serial number, location, and a password, then start the container automatically.

The dashboard will be available at **http://raspberrypi.local:8080** (or whatever hostname you chose).

> **Port conflict?** If something else is already using port 8080 (PiAware's lighttpd commonly does), edit the `PORT` line in `.env` before starting:
> ```
> PORT=8081
> ```

---

## Step 4 — Verify it's running

```bash
docker ps                          # should show fox-ess with status (healthy)
docker logs fox-ess                # check for errors
curl -s http://localhost:8080/healthz  # should return {"ok":true,"uptime":...}
```

Open a browser on any device on your LAN:
```
http://raspberrypi.local:8080
```

> The container takes up to 10 seconds to report `(healthy)` — this is normal. It polls `/healthz` every 30 seconds thereafter.

---

## Step 5 (optional) — Expose it publicly with Tailscale Funnel

Tailscale Funnel gives you a public HTTPS URL with no port-forwarding and no firewall changes. It works behind CGNAT (NBN etc.) and is free.

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh

# In the Tailscale admin console:
#   DNS → Enable HTTPS Certificates
#   Then enable Funnel for this machine

# Expose port 8080 publicly
sudo tailscale funnel --bg 8080
```

Tailscale will print a public URL like `https://your-pi.tail12345.ts.net`. Share that link to access your dashboard from anywhere.

---

## Step 6 (optional) — Cloudflare Tunnel as an alternative

If you prefer Cloudflare:

1. [Create a free Cloudflare account](https://dash.cloudflare.com) and add your domain (or use a free pages.dev subdomain)
2. Go to **Zero Trust → Networks → Tunnels** → Create a tunnel
3. Install `cloudflared` on the Pi:
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
   chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
   ```
4. Run the connector command shown in the Cloudflare dashboard
5. Add a Public Hostname routing to `http://localhost:8080`

For extra protection, enable **Cloudflare Access** in front and require email OTP.

---

## Managing the container

| Task | Command |
|------|---------|
| View logs | `docker logs -f fox-ess` |
| Check health | `docker ps` (look for `(healthy)` in the STATUS column) |
| Stop | `docker compose down` |
| Change password | Edit `.env`, then `docker compose up -d` |

The container is set to `restart: unless-stopped` so it comes back automatically after a reboot or crash.

> **`docker compose restart` does NOT update the running code.** For the pre-built image, use `docker compose pull && docker compose up -d`. For a local build, use `docker compose up -d --build`. A plain `restart` just cycles the container with the same image.

---

## Keeping it up to date

### Using the pre-built image (default)

If `docker-compose.yml` has `image: ghcr.io/vectorxyzing/fox-ess-management:latest` (the default), update by pulling the latest image:

```bash
cd ~/fox-ess-management
git pull                          # get the latest docker-compose.yml / .env.example
docker compose pull               # download the latest image
docker compose up -d              # recreate the container
```

Your `config.json`, `data/`, and `state/` are bind-mounted and survive the update unchanged.

### Using a local build

If you have switched to `build: .` in `docker-compose.yml` (e.g. you are running custom local changes), you must rebuild the image after any source change — a plain `up -d` or `restart` will silently keep running the old code because `index.html`, `proxy.js`, and `lib/` are baked into the image at build time:

```bash
cd ~/fox-ess-management
git pull                          # or edit your local files
docker compose up -d --build      # rebuild image, then recreate container
```

To verify the new code is actually running:
```bash
docker logs fox-ess | head -5     # check the startup timestamp
curl -s http://localhost:8080/healthz   # should return {"ok":true,...}
```
