# Globe Router B9680 — Internal API Reference

Based on reverse-engineering the [`scripts/globe`](./scripts/globe) CLI script.

---

## Authentication

The router uses **cookie-based session auth**. Credentials are Base64-encoded and
sent once. A session cookie is returned and reused for subsequent requests.

### Login endpoint

```
POST http://192.168.254.254/goform/goform_set_cmd_process
Content-Type: application/x-www-form-urlencoded

isTest=false&goformId=LOGIN&username=<b64_user>&password=<b64_pass>
```

| Field | Value |
|-------|-------|
| `isTest` | `false` |
| `goformId` | `LOGIN` |
| `username` | Base64-encoded username |
| `password` | Base64-encoded password |

**Success response** contains `"result":"0"`.

Cookies are persisted to `/tmp/globe_router_cookies.txt` (LWPCookieJar format)
and sent automatically on subsequent requests.

### Session check

```
POST /goform/goform_get_cmd_process
isTest=false&cmd=loginfo&multi_data=1
```

A response containing `"loginfo":"ok"` means the session is still valid.

### Credential resolution order

1. CLI flags `--user` / `--pass`
2. Env vars `GLOBE_ROUTER_USER` / `GLOBE_ROUTER_PASS`
3. macOS Keychain (services: `globe-router-user`, `globe-router-pass`)
4. Local file `~/.config/local/globe-router.env`
5. Interactive TTY prompt (optionally saved to Keychain or file)

---

## Do all commands require auth?

| Command | Requires auth? | Notes |
|---------|---------------|-------|
| `status` | **Yes** | Calls `ensure_login()` |
| `traffic` | **Yes** | |
| `device` | **Yes** | |
| `wan` | **Yes** | |
| `wifi` | **Yes** | |
| `signal` | **Yes** | |
| `sms` | **Yes** | |
| `reboot` | **Yes** | |
| `connect` / `disconnect` | **Yes** | |
| `band show` | **Yes** | |
| `band set` / `band off` | **Yes** | |
| `raw` | **Yes** | |
| `setup` | **No** | Only manages credentials, no API calls |

**Short answer:** Every command that touches the router API requires auth.
The only unauth'd command is `setup` (credential management only).

---

## GET (query) endpoint

```
POST /goform/goform_get_cmd_process
Content-Type: application/x-www-form-urlencoded

isTest=false&cmd=<cmd_name>&multi_data=1
```

| Parameter | Description |
|-----------|-------------|
| `isTest` | Always `false` |
| `cmd` | Single command name, or comma-separated list (e.g. `"lte_rsrq,lte_rssi1,lte_sinr"`) |
| `multi_data` | Always `1` |

Returns a JSON object like: `{"lte_rsrq":"-12","lte_rssi1":"-81",...}`

### Supported GET commands

| Command | Description |
|---------|-------------|
| `loginfo` | Session validity check |
| `modem_main_state` | Modem state |
| `network_type` | Network type (e.g. LTE) |
| `sim_status` | SIM card status |
| `simcard_roam` | Roaming status |
| `lte_plmn` | PLMN (operator) code |
| `lte_rsrq` | Reference Signal Received Quality (dB) |
| `lte_rssi1` | Received Signal Strength Indicator (dBm) |
| `lte_sinr` | Signal-to-Interference-plus-Noise Ratio (dB) |
| `lte_pci` | Physical Cell ID |
| `lte_enodebid` | eNodeB ID |
| `lte_cellid` | Cell ID |
| `wan_ipaddr` | WAN IP address |
| `lan_ipaddr` | LAN IP address (router itself) |
| `ipv6_wan_ipaddr` | IPv6 WAN address |
| `ppp_status` | PPP connection status |
| `rj45_state` | Ethernet port state |
| `sta_count` | Number of connected Wi-Fi clients |
| `m_sta_count` | 5 GHz Wi-Fi client count |
| `SSID1` | 2.4 GHz SSID |
| `m_SSID` | 5 GHz SSID |
| `AuthMode` | 2.4 GHz auth mode |
| `m_AuthMode` | 5 GHz auth mode |
| `WPAPSK1_encode` | 2.4 GHz Wi-Fi password |
| `m_WPAPSK1_encode` | 5 GHz Wi-Fi password |
| `wifi_coverage` | Wi-Fi coverage/mode |
| `wifi_cur_state` | Wi-Fi on/off state |
| `m_ssid_enable` | 5 GHz SSID enabled |
| `MAX_Access_num` | Max 2.4 GHz clients |
| `m_MAX_Access_num` | Max 5 GHz clients |
| `realtime_tx_thrpt` | Real-time TX throughput (bps) |
| `realtime_rx_thrpt` | Real-time RX throughput (bps) |
| `realtime_tx_bytes` | Session TX bytes |
| `realtime_rx_bytes` | Session RX bytes |
| `realtime_time` | Session duration |
| `monthly_tx_bytes` | Monthly TX bytes |
| `monthly_rx_bytes` | Monthly RX bytes |
| `monthly_time` | Monthly connection time |
| `imei` | IMEI number |
| `msisdn` | SIM phone number |
| `cr_version` | Firmware version |
| `hardware_version` | Hardware version |
| `mac_address` | Router MAC address |
| `LocalDomain` | Local domain |
| `pdp_type` | PDP type (IPv4/IPv6) |
| `ethwan_mode` | Ethernet WAN mode |
| `blc_wan_mode` | WAN mode (auto/manual) |
| `blc_wan_auto_mode` | Auto WAN selection mode |
| `dial_mode` | Dial mode |
| `default_wan_name` | Default WAN interface name |
| `roam_setting_option` | Roaming setting |
| `apn_name` | APN name |
| `apn_type` | APN type |
| `static_wan_ipaddr` | Static WAN IP (if set) |
| `static_wan_netmask` | Static WAN netmask |
| `static_wan_gateway` | Static WAN gateway |
| `web_signal` | Signal strength indicator |
| `sms_received_flag` | SMS received flag |
| `sts_received_flag` | SMS status report flag |
| `sms_unread_num` | Unread SMS count |
| `tz_wcdma_bands` | Supported WCDMA bands |
| `tz_tds_bands` | Supported TD-SCDMA bands |
| `tz_lock_wcdma_band` | Currently locked WCDMA bands |
| `tz_lock_tds_band` | Currently locked TD-SCDMA bands |

---

## SET (action) endpoint

```
POST /goform/goform_set_cmd_process
Content-Type: application/x-www-form-urlencoded

isTest=false&goformId=<ACTION>&<extra_params>
```

| Parameter | Description |
|-----------|-------------|
| `isTest` | Always `false` |
| `goformId` | The action to perform (see table below) |
| Extra params | Depend on the action |

### Supported goform IDs

| goformId | Description | Extra params |
|----------|-------------|-------------|
| `LOGIN` | Authenticate | `username` (b64), `password` (b64) |
| `REBOOT_DEVICE` | Reboot the router | None |
| `wan_connect` | Connect WAN | None |
| `wan_disconnect` | Disconnect WAN | None |
| `TZ_GET_LOCK_BAND` | Get current band lock status | Sent as a GET-style POST with **no goformId** (body: `isTest=false&goformId=TZ_GET_LOCK_BAND`) |
| `TZ_SET_LOCK_BAND` | Set LTE band lock | `band_state`, `band_list`, `wcdma_list`, `tds_list`, `zeact` |

---

## Band locking (TZ_GET_LOCK_BAND / TZ_SET_LOCK_BAND)

These are hidden ("zTE") goforms not exposed in the normal web UI.

### Query current band lock

```
POST /goform/goform_set_cmd_process
Content-Type: application/x-www-form-urlencoded

isTest=false&goformId=TZ_GET_LOCK_BAND
```

Returns JSON like:
```json
{
  "band_state": "yes",
  "band1": "0",
  "band3": "1",
  "band5": "0",
  "band7": "0",
  "band8": "0",
  "band28": "1",
  "band40": "0",
  "band41": "0",
  ...
}
```

Each `band<N>` field is `"1"` if enabled, `"0"` if disabled.

### Set band lock

```
POST /goform/goform_set_cmd_process
Content-Type: application/x-www-form-urlencoded

isTest=false&goformId=TZ_SET_LOCK_BAND&band_state=<state>&band_list=<list>&wcdma_list=<list>&tds_list=<list>&zeact=<n>
```

| Parameter | Description |
|-----------|-------------|
| `band_state` | `"yes"` to enable band lock, `"no"` to disable |
| `band_list` | Comma-separated reversed byte values of a bitmask (see below) |
| `wcdma_list` | WCDMA band list, e.g. `"0,0,0"` |
| `tds_list` | TD-SCDMA band list, e.g. `"0,0"` |
| `zeact` | 0 = only low bands, 1 = only high bands, 2 = mixed |

### How `band_list` is constructed

The script builds a **big-endian bitmask** across all supported LTE bands.

1. Determine `bit_length = ceil(max_supported_band / 8) * 8` (rounded up to
   nearest byte boundary).
2. Create a bit array of that length, all zeros.
3. For each selected band `N`, set `bits[bit_length - N] = 1`.
4. Split into groups of 8 bits, convert each byte to an integer string.
5. **Reverse** the list and join with commas.

Example for bands 3 + 28 (common LTE combo in PH):

```
bit_length = ceil(41/8)*8 = 48 bits

bits (MSB first, index 0..47):
Position 48-3 = 45 -> set bit 45 = 1  (band 3)
Position 48-28 = 20 -> set bit 20 = 1 (band 28)
All others 0

Bytes (from MSB to LSB):
byte0 (bits 0-7):  00000000  -> 0
byte1 (bits 8-15): 00000000  -> 0
byte2 (bits 16-23): 00001000 -> 8   (bit 20 set = band 28)
byte3 (bits 24-31): 00000000 -> 0
byte4 (bits 32-39): 00000000 -> 0
byte5 (bits 40-47): 00001000 -> 8   (bit 45 set = band 3)

Reversed: "8,0,0,8,0,0"
```

The `zeact` value is determined by checking if the **lower 25 bits**
(positions `N-25` to `N`) or **upper 11 bits** (positions `N-43` to `N-32`)
contain any set bits.

### CLI usage

```bash
# Show current band lock status
globe band
globe band show
globe band status

# Lock to specific bands
globe band 3
globe band 3 28
globe band 3,28
globe band 3,28,41

# Disable band lock (revert to auto)
globe band off
globe band disable
```

---

## Summary of API flow

```
 ┌────────────┐         ┌──────────────────────┐
 │  Credential │ ──────> │  resolve_credentials  │
 │  sources    │         │  (keychain/env/flags) │
 └────────────┘         └──────────┬───────────┘
                                   │
                                   v
 ┌─────────────────┐    ┌──────────────────────┐
 │ GET /goform/    │ <──│     ensure_login()    │
 │ goform_get_     │    │  (check_session OR    │
 │ cmd_process     │    │   POST LOGIN)         │
 │  ?cmd=loginfo   │    └──────────────────────┘
 └─────────────────┘              │
                                  v
 ┌─────────────────────────────────────────────┐
 │           Main command dispatch             │
 │  status / traffic / signal / band / reboot  │
 │  Each makes POSTs to either:                │
 │   • /goform/goform_get_cmd_process (GET)    │
 │   • /goform/goform_set_cmd_process (SET)    │
 └─────────────────────────────────────────────┘
```

All data flows through two URL endpoints:
- **`/goform/goform_get_cmd_process`** — query/read commands
- **`/goform/goform_set_cmd_process`** — write/action commands (including login!)

The distinction is purely semantic: both are HTTP POST. The difference is
`goformId` (SET) vs `cmd` (GET).

---

## Cookie storage

Cookies are stored in **`/tmp/globe_router_cookies.txt`** using Python's
`LWPCookieJar` format. This is intentionally ephemeral (in `/tmp/`), so
sessions don't persist across reboots.
