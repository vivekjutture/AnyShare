# ⚡ AnyShare ⚡

Share passwords, text snippets, and files between any two devices — **no installs, no accounts, no servers, no cost.**

Built with **WebRTC (PeerJS)** for direct peer-to-peer transfer. Deployable for free on **GitHub Pages**.

---

## ✨ Features

- **Send text, passwords, and files** between any two devices over a direct
  encrypted P2P link.
- **Both sides see a live list** — the sender sees its **Sent Items**, the
  receiver sees its **Received Items**.
- **Scrollable text view with line numbers** — large pastes (1000+ lines) stay
  inside a fixed-height, scrollable block, so the page never balloons. You
  scroll within the block, not the whole page.
- **One-tap copy** — a large, touch-friendly **Copy** button below each item
  with a clear "✓ Copied!" confirmation. Passwords are masked with a
  **Reveal/Hide** toggle; files get a **Download** button.
- **Connect by code or QR** — scan the QR (or open the `?join=CODE` link) to
  auto-connect.

---

## ⚙️ Behaviour notes

- **Items expire after 2 minutes** on **both** the sender and receiver. When
  the countdown ends the item is **silently removed** from the list — no
  leftover "expired" placeholder.
- **Connections auto-disconnect after 5 minutes idle.** Clicking **Start New
  Session** on the timeout popup does a **full page reload** so the app starts
  cleanly with a fresh code + QR.
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
