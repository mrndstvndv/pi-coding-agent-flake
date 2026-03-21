---
name: globe-router
description: CLI for Globe At Home B9680 router (192.168.254.254). Use when user wants to inspect or control their Globe router, fetch status/traffic, or manage login credentials locally at runtime.
---

# Globe Router Skill

**Run via:** `./scripts/globe`

## Credential storage

This skill does **not** store credentials in nix.

Credential lookup order:

1. CLI flags: `--user`, `--pass`
2. Environment variables: `GLOBE_ROUTER_USER`, `GLOBE_ROUTER_PASS`
3. macOS Keychain
4. Local runtime file: `~/.config/local/globe-router.env`
5. Interactive prompt

If prompted, the script can save credentials to:
- **macOS Keychain** (recommended on Darwin)
- local file `~/.config/local/globe-router.env`
- nowhere (`use once`)

## Setup

Interactive setup:

```bash
globe setup
```

Explicit credentials:

```bash
globe --user admin --pass 'your_password' status
```

Environment variables:

```bash
export GLOBE_ROUTER_USER=admin
export GLOBE_ROUTER_PASS='your_password'
globe status
```

Local file fallback:

```bash
mkdir -p ~/.config/local
chmod 700 ~/.config/local
cat > ~/.config/local/globe-router.env <<'EOF'
GLOBE_ROUTER_USER=admin
GLOBE_ROUTER_PASS=your_password
GLOBE_ROUTER_IP=192.168.254.254
EOF
chmod 600 ~/.config/local/globe-router.env
```

## Usage

```bash
globe <command>
```

## Commands

| Command | Description |
|---------|-------------|
| `setup` | Prompt for credentials and optionally save them |
| `status` | Network status, IP, connection info |
| `traffic` | Real-time & monthly traffic data |
| `device` | Device info, IMEI, version, SIM |
| `wan` | WAN settings |
| `wifi` | WiFi settings |
| `signal` | Signal strength info (RSRQ, RSSI, SINR) |
| `sms` | SMS info |
| `reboot` | Reboot router |
| `connect` | Connect WAN |
| `disconnect` | Disconnect WAN |
| `raw <cmd>` | Custom API command |

## Router details

- **IP:** `192.168.254.254`
- **Model:** Globe At Home B9680
- **Login API:** Base64-encoded credentials to `/goform/goform_set_cmd_process`
- **GET API:** `/goform/goform_get_cmd_process`

## Example raw commands

```bash
globe raw "modem_main_state,network_type,lte_plmn,lte_rsrq,lte_rssi1,lte_sinr"
globe raw "imei,cr_version,hardware_version,msisdn,wan_ipaddr"
globe raw "realtime_tx_thrpt,realtime_rx_thrpt,realtime_tx_bytes,realtime_rx_bytes"
```

## Useful GET commands

| Command | Description |
|---------|-------------|
| `modem_main_state` | Modem state |
| `network_type` | Network type |
| `lte_plmn` | PLMN code |
| `lte_rsrq`, `lte_rssi1`, `lte_sinr` | Signal values |
| `lte_pci`, `lte_enodebid`, `lte_cellid` | Cell info |
| `wan_ipaddr`, `lan_ipaddr` | IP addresses |
| `ppp_status` | Connection status |
| `sta_count` | Connected Wi-Fi devices |
| `SSID1` | Wi-Fi SSID |
| `realtime_tx/rx_thrpt` | Current speed |
| `realtime_tx/rx_bytes` | Session traffic |
| `monthly_tx/rx_bytes` | Monthly traffic |
| `imei`, `msisdn` | Device identifiers |
| `cr_version`, `hardware_version` | Firmware info |

## Useful SET commands

| goformId | Description |
|----------|-------------|
| `LOGIN` | Login |
| `REBOOT_DEVICE` | Reboot |
| `wan_connect` | Connect WAN |
| `wan_disconnect` | Disconnect WAN |
