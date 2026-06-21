# ⚡ AnyShare

Share passwords, text snippets, and files between any two devices — **no installs, no accounts, no servers, no cost.**

Built with **WebRTC (PeerJS)** for direct peer-to-peer transfer. Deployable for free on **GitHub Pages**.

---

## ⚙️ Behaviour notes

- **Received items expire after 2 minutes** (live countdown + auto-cleanup).
- **Connections auto-disconnect after 5 minutes idle**, then regenerate a
  fresh code + QR.
- **Files are chunked** (64 KB) so there's no size limit.
- All transfers are **end-to-end encrypted** by WebRTC (DTLS) by default.

---

## 📶 Connectivity & mobile (4G/5G) support

WebRTC needs to traverse NAT/firewalls to open a direct peer-to-peer link.
Two kinds of servers help with this, both configured in
[`ICE_CONFIG`](script.js):

- **STUN** — lets each device discover its own public IP. Enough for devices
  on the same LAN or behind simple home-router (cone) NAT. This is why
  laptop↔laptop / desktop↔laptop on the same WiFi already worked.
- **TURN** — _relays_ the traffic through a server when a direct link is
  impossible. **Mobile carriers (4G/5G) sit behind Carrier-Grade / Symmetric
  NAT, which STUN cannot punch through**, so a TURN server is mandatory for
  phones to connect. The `:443?transport=tcp` entry is especially important —
  it looks like normal HTTPS, so it works even on carriers that block UDP.

The app ships with the free public **OpenRelay** TURN credentials so mobile
works out of the box. These are shared/best-effort, so for production
reliability get your own **free** TURN key (50 GB/month, no card) at
<https://dashboard.metered.ca> and replace the `turn:` entries in
[`script.js`](script.js).

---
