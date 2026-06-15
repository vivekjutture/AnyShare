# ⚡ AnyShare

Share passwords, text snippets, and files between any two devices — **no installs, no accounts, no servers, no cost.**

Built with **WebRTC (PeerJS)** for direct peer-to-peer transfer. Deployable for free on **GitHub Pages**.

---

## 📁 Files

| File         | Purpose                                  |
|--------------|------------------------------------------|
| `index.html` | Page structure / markup                  |
| `style.css`  | All styling                              |
| `script.js`  | All app logic (WebRTC, QR, timers, etc.) |
| `README.md`  | This file                                |

Keep all four files in the **same folder**.

---

## 🚀 Deploy to GitHub Pages (free)

1. Create a new GitHub repo (e.g. `anyshare`).
2. Upload `index.html`, `style.css`, and `script.js`.
3. Go to **Settings → Pages**.
4. Under **Branch**, pick `main` and click **Save**.
5. Wait ~60 seconds. Your app is live at
   `https://YOUR-USERNAME.github.io/anyshare/`

---

## 📱 Why it now works on mobile (4G / 5G)

Earlier versions used only **STUN** servers. STUN helps a device find its
public IP, but it **cannot** establish a connection across **Symmetric NAT /
CGNAT** — which is what almost every mobile carrier uses. That's why it hung
on "Connecting…" over 4G/5G.

The fix is a **TURN** server, which *relays* the data when a direct link is
impossible. The included config uses the free public **Open Relay** project,
including a `:443?transport=tcp` entry that disguises traffic as HTTPS so it
gets through even on carriers that block UDP entirely.

---

## 🔑 Recommended: use your own free TURN key

The public Open Relay servers are shared and can get congested or go down.
For reliable performance, get your own **free** TURN credentials:

1. Sign up at **https://dashboard.metered.ca** (free tier: 50 GB/month, no card).
2. Open the **TURN Server** section and copy your credentials.
3. In `script.js`, find the `ICE_CONFIG` block near the top and replace the
   three `turn:openrelay.metered.ca` entries with your own, e.g.:

   ```js
   {
     urls: 'turn:YOUR-SUBDOMAIN.metered.live:80',
     username: 'YOUR_USERNAME',
     credential: 'YOUR_CREDENTIAL',
   },
   {
     urls: 'turn:YOUR-SUBDOMAIN.metered.live:443',
     username: 'YOUR_USERNAME',
     credential: 'YOUR_CREDENTIAL',
   },
   {
     urls: 'turn:YOUR-SUBDOMAIN.metered.live:443?transport=tcp',
     username: 'YOUR_USERNAME',
     credential: 'YOUR_CREDENTIAL',
   },
   ```

Keep the two Google `stun:` entries — they're free and help fast direct
connections when both devices are on friendly networks.

---

## ⚙️ Behaviour notes

- **Received items expire after 2 minutes** (live countdown + auto-cleanup).
- **Connections auto-disconnect after 5 minutes idle**, then regenerate a
  fresh code + QR.
- **Files are chunked** (64 KB) so there's no size limit.
- All transfers are **end-to-end encrypted** by WebRTC (DTLS) by default.

---

## 🧪 Testing tip

To confirm TURN is the issue when debugging, open your browser's dev console.
A successful relayed connection will show ICE candidates of type `relay`.
If you only ever see `host` / `srflx` candidates and no `relay`, the TURN
server isn't reachable — switch to your own Metered key.
