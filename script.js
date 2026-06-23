/* ============================================================
   AnyShare — script.js
   Sections:
     1.  ICE / STUN Config
     2.  Constants
     3.  State
     4.  Boot & Peer Setup
     5.  Tabs
     6.  Idle Management
     7.  Item Expiry System
     8.  Connect (Receiver Side)
     9.  Send
    10.  Send File (chunked)
    11.  Receive Handler
    12.  Render Received Items
    13.  File Handling (drop zone)
    14.  Type Switcher
    15.  QR Scanner
    16.  Status Helpers
    17.  Utils
   ============================================================ */

/* ── 1. ICE / STUN + TURN CONFIG ──────────────────────────── */
// STUN servers help devices discover their public IP.
// TURN servers RELAY traffic when a direct P2P link is impossible —
// this is REQUIRED for most mobile carriers (4G/5G) which use
// Symmetric NAT / CGNAT that STUN alone cannot punch through.
//
// The TURN entries below use the free public "Open Relay" project.
// The :443?transport=tcp entry is the most important one — it looks
// like normal HTTPS traffic, so it works even on carriers that block UDP.
//
// ⚠️ For production reliability, sign up for your own free TURN key at
//    https://dashboard.metered.ca  (50 GB/month free, no card) and
//    replace the credentials below. See README.md for steps.
const ICE_CONFIG = {
  iceServers: [
    // STUN — lets each peer discover its own public IP:port.
    // Enough for same-LAN / simple home-router (cone) NATs.
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },

    // TURN — RELAYS the traffic when a direct P2P link is impossible.
    // This is what makes 4G/5G phones work: mobile carriers sit behind
    // Carrier-Grade / Symmetric NAT that STUN can NOT punch through.
    // The :443?transport=tcp entry is the most important one — it looks
    // like ordinary HTTPS traffic, so it survives carriers that block UDP.
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  // Pre-gather a few candidates so relay negotiation starts sooner on mobile.
  iceCandidatePoolSize: 4,
};

/* ── 2. CONSTANTS ─────────────────────────────────────────── */
const ITEM_EXPIRY_MS = 2 * 60 * 1000; // received items expire after 2 min
const IDLE_WARN_MS = 4 * 60 * 1000; // show warning banner at 4 min idle
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // disconnect at 5 min idle
const CHUNK_SIZE = 64 * 1024; // 64 KB file chunks

/* ── 3. STATE ─────────────────────────────────────────────── */
let peer = null; // our own PeerJS peer
let sendConn = null; // active sender→receiver DataConnection
let conn = null; // active receiver→sender DataConnection
let selectedFile = null; // file staged for sending
let currentType = "text"; // 'text' | 'password' | 'file'
let sentItems = []; // array of items THIS device has sent
let receivedItems = []; // array of items THIS device has received
let itemSeq = 0; // monotonic id source for items
let fileChunks = {}; // in-flight file chunk buffers keyed by fileId
let qrStream = null; // MediaStream from QR camera scanner

let itemTimerInterval = null; // drives expiry countdowns
let lastActivityAt = Date.now();
let idleCheckInterval = null;

/* ── 4. BOOT & PEER SETUP ─────────────────────────────────── */
function generateShortId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function boot() {
  const shortId = generateShortId();
  peer = new Peer(shortId, { config: ICE_CONFIG });

  setSendStatus("connecting", "Generating your session…");

  peer.on("open", (id) => {
    // Show session code
    document.getElementById("code-display").textContent = id;

    // Generate QR code linking to this page with ?join=CODE
    document.getElementById("qrcode").innerHTML = "";
    const qrUrl = `${location.origin}${location.pathname}?join=${id}`;
    new QRCode(document.getElementById("qrcode"), {
      text: qrUrl,
      width: 160,
      height: 160,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });

    setSendStatus("connecting", "Share this code or QR with the receiver");
    resetIdleTimer();
  });

  peer.on("connection", (c) => {
    sendConn = c;
    sendConn.serialization = "binary";

    sendConn.on("open", () => {
      setSendStatus("connected", "🟢 Connected! Ready to send.");
      document.getElementById("qr-section").style.display = "none";
      document.getElementById("waiting-divider").style.display = "none";
      document.getElementById("send-form").style.display = "block";
      resetIdleTimer();
      startIdleWatcher();
    });

    sendConn.on("close", () => {
      setSendStatus("error", "Receiver disconnected.");
      stopIdleWatcher();
    });

    sendConn.on("error", () => setSendStatus("error", "Connection error."));
  });

  peer.on("error", (e) => {
    // If our short ID is already taken, regenerate
    if (e.type === "unavailable-id") {
      peer.destroy();
      peer = null;
      boot();
    } else {
      setSendStatus("error", "Error: " + e.message);
    }
  });

  // Auto-join if page was opened via QR link (?join=CODE)
  const params = new URLSearchParams(location.search);
  const joinCode = params.get("join");
  if (joinCode) {
    switchTab("receive");
    setTimeout(() => {
      document.getElementById("recv-code-input").value = joinCode;
      connectToPeer();
    }, 600);
  }
}

/* ── 5. TABS ──────────────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((t, i) => {
    t.classList.toggle(
      "active",
      (i === 0 && tab === "send") || (i === 1 && tab === "receive"),
    );
  });
  document.querySelectorAll(".panel").forEach((p, i) => {
    p.classList.toggle(
      "active",
      (i === 0 && tab === "send") || (i === 1 && tab === "receive"),
    );
  });
}

/* ── 6. IDLE MANAGEMENT ───────────────────────────────────── */
function resetIdleTimer() {
  lastActivityAt = Date.now();
  document.getElementById("idle-banner").classList.remove("show");
}

function startIdleWatcher() {
  clearInterval(idleCheckInterval);
  idleCheckInterval = setInterval(() => {
    if (!sendConn && !conn) return; // no live connection to watch
    const idle = Date.now() - lastActivityAt;

    if (idle >= IDLE_TIMEOUT_MS) {
      clearInterval(idleCheckInterval);
      handleIdleDisconnect();
    } else if (idle >= IDLE_WARN_MS) {
      const remaining = Math.ceil((IDLE_TIMEOUT_MS - idle) / 1000);
      document.getElementById("idle-banner").classList.add("show");
      document.getElementById("idle-countdown").textContent = remaining;
    }
  }, 1000);
}

function stopIdleWatcher() {
  clearInterval(idleCheckInterval);
  document.getElementById("idle-banner").classList.remove("show");
}

function handleIdleDisconnect() {
  try {
    if (sendConn) sendConn.close();
  } catch (e) {}
  try {
    if (conn) conn.close();
  } catch (e) {}
  try {
    if (peer) peer.destroy();
  } catch (e) {}
  sendConn = null;
  conn = null;
  peer = null;

  stopIdleWatcher();
  document.getElementById("idle-overlay").classList.add("show");
}

function dismissIdleOverlay() {
  // Full page reload so the app starts cleanly with a brand-new session
  // instead of trying to regenerate state in the existing page.
  location.reload();
}

/* ── 7. ITEM EXPIRY SYSTEM ────────────────────────────────── */
function startItemTimer() {
  if (itemTimerInterval) return; // already running
  itemTimerInterval = setInterval(tickItemTimers, 1000);
}

function tickItemTimers() {
  const now = Date.now();

  // Silently drop expired items from BOTH lists (no "expired" placeholder).
  const sentChanged = expireList(sentItems, now);
  const recvChanged = expireList(receivedItems, now);

  // Update the live countdowns of the survivors WITHOUT rebuilding the DOM —
  // this keeps the page fast even when an item holds 1000+ lines of text.
  updateCountdowns(sentItems, now);
  updateCountdowns(receivedItems, now);

  if (sentChanged) renderSent();
  if (recvChanged) renderReceived();

  // Nothing left to track — stop the interval until the next item arrives.
  if (sentItems.length === 0 && receivedItems.length === 0) {
    clearInterval(itemTimerInterval);
    itemTimerInterval = null;
  }
}

// Remove (and free) any items past their expiry. Returns true if list changed.
function expireList(items, now) {
  let changed = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (now >= items[i].expiresAt) {
      if (items[i].fileUrl) URL.revokeObjectURL(items[i].fileUrl);
      items.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}

// Update each surviving card's countdown + expiry bar in place.
function updateCountdowns(items, now) {
  items.forEach((item) => {
    const card = document.querySelector(`[data-id="${item.id}"]`);
    if (!card) return;

    const remainMs = Math.max(0, item.expiresAt - now);
    const remainSec = Math.ceil(remainMs / 1000);
    const pct = (remainMs / ITEM_EXPIRY_MS) * 100;
    const isWarn = remainSec <= 30;
    const isDanger = remainSec <= 10;

    const bar = card.querySelector(".expiry-bar");
    if (bar) {
      bar.style.width = pct + "%";
      bar.style.background = isDanger
        ? "var(--danger)"
        : isWarn
          ? "var(--warning)"
          : "var(--success)";
    }

    const cd = card.querySelector(".expiry-countdown");
    if (cd) {
      cd.textContent = formatTime(remainSec);
      cd.className =
        "expiry-countdown" + (isDanger ? " danger" : isWarn ? " warning" : "");
    }

    card.classList.toggle("expiring", isWarn);
  });
}

/* ── 8. CONNECT (RECEIVER SIDE) ───────────────────────────── */
function connectToPeer() {
  const code = document
    .getElementById("recv-code-input")
    .value.trim()
    .toUpperCase();
  if (code.length < 4) return showToast("Enter the session code first.");

  setRecvStatus("connecting", "Connecting…");

  // 15-second timeout — TURN relay negotiation can take a few extra
  // seconds on mobile, so we give it a bit longer before failing.
  const timeoutId = setTimeout(() => {
    if (conn && conn.open) return; // already succeeded
    setRecvStatus("error", "Taking too long. Check the code and try again.");
    showRetryButton();
  }, 15000);

  const recvPeer = new Peer({ config: ICE_CONFIG });

  recvPeer.on("open", () => {
    conn = recvPeer.connect(code, { reliable: true, serialization: "binary" });

    conn.on("open", () => {
      clearTimeout(timeoutId);
      hideRetryButton();
      setRecvStatus("connected", "🟢 Connected to sender");
      document.getElementById("recv-connect-form").style.display = "none";
      stopQRScan();
      resetIdleTimer();
      startIdleWatcher();
      startItemTimer();
    });

    conn.on("data", (data) => {
      resetIdleTimer(); // any incoming data counts as activity
      handleReceived(data);
    });

    conn.on("error", () => {
      clearTimeout(timeoutId);
      setRecvStatus("error", "Failed to connect. Check the code.");
      showRetryButton();
    });

    conn.on("close", () => {
      setRecvStatus("error", "Sender disconnected.");
      stopIdleWatcher();
    });
  });

  recvPeer.on("error", (e) => {
    clearTimeout(timeoutId);
    setRecvStatus("error", "Error: " + e.message);
    showRetryButton();
  });
}

function showRetryButton() {
  if (document.getElementById("retry-btn")) return;
  const btn = document.createElement("button");
  btn.id = "retry-btn";
  btn.className = "btn btn-secondary";
  btn.style.marginTop = "12px";
  btn.textContent = "🔄 Try Again";
  btn.onclick = () => {
    btn.remove();
    connectToPeer();
  };
  const form = document.getElementById("recv-connect-form");
  form.appendChild(btn);
  form.style.display = "block";
}

function hideRetryButton() {
  const btn = document.getElementById("retry-btn");
  if (btn) btn.remove();
}

/* ── 9. SEND ──────────────────────────────────────────────── */
async function sendData() {
  if (!sendConn) return showToast("Not connected to a receiver!");
  resetIdleTimer();

  if (currentType === "text") {
    const val = document.getElementById("text-input").value.trim();
    if (!val) return showToast("Enter some text first.");
    sendConn.send({ type: "text", content: val });
    addSent({ type: "Text", icon: "📝", content: val });
    showToast("Text sent! ✓");
    document.getElementById("text-input").value = "";
  } else if (currentType === "password") {
    const val = document.getElementById("password-input").value;
    if (!val) return showToast("Enter a password first.");
    sendConn.send({ type: "password", content: val });
    addSent({ type: "Password", icon: "🔑", content: val, isPassword: true });
    showToast("Password sent! ✓");
    document.getElementById("password-input").value = "";
  } else if (currentType === "file") {
    if (!selectedFile) return showToast("Select a file first.");
    await sendFile(selectedFile);
  }
}

/* ── 10. SEND FILE (CHUNKED) ──────────────────────────────── */
async function sendFile(file) {
  const btn = document.getElementById("send-btn");
  const progressWrap = document.getElementById("progress-wrap");
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");

  btn.disabled = true;
  progressWrap.classList.add("show");

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const fileId = Date.now().toString();

  // Send metadata first so receiver can prepare
  sendConn.send({
    type: "file-start",
    fileId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    totalChunks,
  });

  let chunkIndex = 0;

  function sendNextChunk() {
    if (chunkIndex >= totalChunks) {
      // All chunks sent — signal completion
      sendConn.send({ type: "file-end", fileId });
      progressWrap.classList.remove("show");
      btn.disabled = false;
      // Show it in the sender's own list too (local URL — re-downloadable).
      addSent({
        type: "File",
        icon: "📎",
        content: file.name,
        fileUrl: URL.createObjectURL(file),
        fileName: file.name,
        fileSize: file.size,
      });
      showToast("File sent! ✓");
      clearFile();
      resetIdleTimer();
      return;
    }

    const start = chunkIndex * CHUNK_SIZE;
    const slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
    const fr = new FileReader();

    fr.onload = (e) => {
      sendConn.send({
        type: "file-chunk",
        fileId,
        index: chunkIndex,
        data: e.target.result,
      });
      chunkIndex++;

      const pct = Math.round((chunkIndex / totalChunks) * 100);
      fill.style.width = pct + "%";
      label.textContent = `Sending… ${pct}% (${formatSize(chunkIndex * CHUNK_SIZE)} / ${formatSize(file.size)})`;

      // Brief pause every 16 chunks to avoid overwhelming the data channel
      if (chunkIndex % 16 === 0) setTimeout(sendNextChunk, 10);
      else sendNextChunk();
    };

    fr.readAsArrayBuffer(slice);
  }

  sendNextChunk();
}

/* ── 11. RECEIVE HANDLER ──────────────────────────────────── */
function handleReceived(data) {
  if (data.type === "text") {
    addReceived({ type: "Text", icon: "📝", content: data.content });
  } else if (data.type === "password") {
    addReceived({
      type: "Password",
      icon: "🔑",
      content: data.content,
      isPassword: true,
    });
  } else if (data.type === "file-start") {
    fileChunks[data.fileId] = {
      name: data.name,
      size: data.size,
      mimeType: data.mimeType,
      totalChunks: data.totalChunks,
      chunks: [],
      received: 0,
    };
  } else if (data.type === "file-chunk") {
    const f = fileChunks[data.fileId];
    if (f) {
      f.chunks[data.index] = data.data;
      f.received++;
    }
  } else if (data.type === "file-end") {
    const f = fileChunks[data.fileId];
    if (!f) return;
    const blob = new Blob(f.chunks, { type: f.mimeType });
    const url = URL.createObjectURL(blob);
    addReceived({
      type: "File",
      icon: "📎",
      content: f.name,
      fileUrl: url,
      fileName: f.name,
      fileSize: f.size,
    });
    delete fileChunks[data.fileId];
  }
}

// Shared: stamp an item with id/time/expiry and prepend to a list.
function addItem(items, item) {
  item.id = ++itemSeq;
  item.time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  item.expiresAt = Date.now() + ITEM_EXPIRY_MS;
  item.revealed = false;
  items.unshift(item);
  startItemTimer();
}

function addReceived(item) {
  addItem(receivedItems, item);
  renderReceived();
  showToast(`${item.icon} New ${item.type} received!`);
}

function addSent(item) {
  addItem(sentItems, item);
  renderSent();
}

// Look up an item by id across both lists (handlers pass ids, not indexes).
function findItem(id) {
  return (
    sentItems.find((x) => x.id == id) ||
    receivedItems.find((x) => x.id == id) ||
    null
  );
}

/* ── 12. RENDER ITEMS ─────────────────────────────────────── */
function renderSent() {
  renderList(sentItems, "sent-list", null, "sent-section");
}

function renderReceived() {
  renderList(receivedItems, "received-list", "recv-empty", "received-section");
}

// Generic list renderer used by BOTH the sender and receiver panels.
// Full rebuild only happens on add/remove/reveal — never on the 1s tick.
function renderList(items, listId, emptyId, sectionId) {
  const list = document.getElementById(listId);
  const empty = emptyId ? document.getElementById(emptyId) : null;
  const section = sectionId ? document.getElementById(sectionId) : null;

  if (items.length === 0) {
    if (section) section.style.display = "none";
    if (empty) empty.style.display = "block";
    list.innerHTML = "";
    return;
  }

  if (section) section.style.display = "block";
  if (empty) empty.style.display = "none";

  list.innerHTML = items.map(cardHtml).join("");
}

function cardHtml(item) {
  const remainMs = Math.max(0, item.expiresAt - Date.now());
  const remainSec = Math.ceil(remainMs / 1000);
  const pct = (remainMs / ITEM_EXPIRY_MS) * 100;
  const isWarn = remainSec <= 30;
  const isDanger = remainSec <= 10;
  const barColor = isDanger
    ? "var(--danger)"
    : isWarn
      ? "var(--warning)"
      : "var(--success)";
  const countClass = isDanger ? "danger" : isWarn ? "warning" : "";

  return `
      <div class="received-item${isWarn ? " expiring" : ""}" data-id="${item.id}">
        <div class="expiry-bar-wrap">
          <div class="expiry-bar" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <div class="received-item-header">
          <span class="received-type">${item.icon} ${item.type}</span>
          <div class="received-meta">
            <span class="received-time">${item.time}</span>
            <span class="expiry-countdown ${countClass}">${formatTime(remainSec)}</span>
          </div>
        </div>
        <div class="item-content">${contentHtml(item)}</div>
        <div class="item-actions">${actionsHtml(item)}</div>
      </div>`;
}

function contentHtml(item) {
  if (item.fileUrl) {
    return `<div class="received-content">${escHtml(item.content)} <span style="color:var(--muted);font-size:11px">(${formatSize(item.fileSize)})</span></div>`;
  }
  // Text & password both render inside a fixed-height, scrollable code block.
  return codeBlockHtml(item);
}

// Scrollable block with a sticky line-number gutter. Two <pre> nodes total,
// regardless of how many lines — so 1000+ lines stay cheap to render.
function codeBlockHtml(item) {
  let text = item.content;
  if (item.isPassword && !item.revealed) {
    text = text.replace(/[^\n]/g, "•"); // mask everything but line breaks
  }
  const lines = text.split("\n");
  const gutter = lines.map((_, i) => i + 1).join("\n");
  const code = lines.map(escCode).join("\n");
  return `<div class="content-block">
        <pre class="line-gutter" aria-hidden="true">${gutter}</pre>
        <pre class="content-code${item.isPassword ? " password" : ""}">${code || " "}</pre>
      </div>`;
}

function actionsHtml(item) {
  if (item.fileUrl) {
    return `<a class="action-btn download" href="${item.fileUrl}" download="${escAttr(item.fileName)}">⬇ Download</a>`;
  }
  let html = "";
  if (item.isPassword) {
    html += `<button class="action-btn reveal-btn" onclick="toggleReveal(${item.id})">👁 Reveal</button>`;
  }
  html += `<button class="action-btn copy" onclick="copyItem(${item.id}, this)">📋 Copy</button>`;
  return html;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function toggleReveal(id) {
  const item = findItem(id);
  if (!item) return;
  item.revealed = !item.revealed;

  const card = document.querySelector(`[data-id="${item.id}"]`);
  if (!card) return;

  const holder = card.querySelector(".item-content");
  if (holder) holder.innerHTML = contentHtml(item);

  const revealBtn = card.querySelector(".reveal-btn");
  if (revealBtn) revealBtn.textContent = item.revealed ? "🙈 Hide" : "👁 Reveal";
}

function copyItem(id, btn) {
  const item = findItem(id);
  if (!item) return;
  navigator.clipboard.writeText(item.content).then(() => {
    btn.classList.add("copied");
    btn.textContent = "✓ Copied!";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.textContent = "📋 Copy";
    }, 1600);
  });
}

function clearReceived() {
  receivedItems.forEach((item) => {
    if (item.fileUrl) URL.revokeObjectURL(item.fileUrl);
  });
  receivedItems = [];
  renderReceived();
}

function clearSent() {
  sentItems.forEach((item) => {
    if (item.fileUrl) URL.revokeObjectURL(item.fileUrl);
  });
  sentItems = [];
  renderSent();
}

/* ── 13. FILE HANDLING (DROP ZONE) ───────────────────────── */
function fileSelected(input) {
  if (input.files[0]) showFile(input.files[0]);
}

function showFile(file) {
  selectedFile = file;
  document.getElementById("file-drop").style.display = "none";
  document.getElementById("file-selected-info").style.display = "flex";
  document.getElementById("file-name-display").textContent = file.name;
  document.getElementById("file-size-display").textContent = formatSize(
    file.size,
  );
}

function clearFile() {
  selectedFile = null;
  document.getElementById("file-input").value = "";
  document.getElementById("file-drop").style.display = "block";
  document.getElementById("file-selected-info").style.display = "none";
}

function fileDragOver(e) {
  e.preventDefault();
  document.getElementById("file-drop").classList.add("dragover");
}

function fileDragLeave() {
  document.getElementById("file-drop").classList.remove("dragover");
}

function fileDrop(e) {
  e.preventDefault();
  fileDragLeave();
  if (e.dataTransfer.files[0]) showFile(e.dataTransfer.files[0]);
}

/* ── 14. TYPE SWITCHER ────────────────────────────────────── */
function setType(type, btn) {
  currentType = type;
  document
    .querySelectorAll(".type-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("input-text").style.display =
    type === "text" ? "block" : "none";
  document.getElementById("input-password").style.display =
    type === "password" ? "block" : "none";
  document.getElementById("input-file").style.display =
    type === "file" ? "block" : "none";
}

function togglePasswordVisibility() {
  const inp = document.getElementById("password-input");
  inp.type = inp.type === "password" ? "text" : "password";
}

/* ── 15. QR SCANNER ───────────────────────────────────────── */
async function startQRScan() {
  if (!("BarcodeDetector" in window)) {
    showToast(
      "QR scan not supported in this browser. Enter the code manually.",
    );
    return;
  }

  document.getElementById("qr-scanner-wrap").style.display = "block";

  try {
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    const video = document.getElementById("qr-video");
    video.srcObject = qrStream;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });

    async function scan() {
      if (!qrStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length > 0) {
          const match = codes[0].rawValue.match(/[?&]join=([A-Z0-9]+)/i);
          if (match) {
            document.getElementById("recv-code-input").value =
              match[1].toUpperCase();
            stopQRScan();
            connectToPeer();
            return;
          }
        }
      } catch (_) {}
      requestAnimationFrame(scan);
    }

    video.onloadedmetadata = () => scan();
  } catch (_) {
    showToast("Camera access denied.");
    document.getElementById("qr-scanner-wrap").style.display = "none";
  }
}

function stopQRScan() {
  if (qrStream) {
    qrStream.getTracks().forEach((t) => t.stop());
    qrStream = null;
  }
  document.getElementById("qr-scanner-wrap").style.display = "none";
}

/* ── 16. STATUS HELPERS ───────────────────────────────────── */
function setSendStatus(state, msg) {
  const cls =
    state === "connected"
      ? "connected"
      : state === "error"
        ? "error"
        : "connecting";
  document.getElementById("send-dot").className = "dot " + cls;
  document.getElementById("send-status").textContent = msg;
}

function setRecvStatus(state, msg) {
  const cls =
    state === "connected"
      ? "connected"
      : state === "error"
        ? "error"
        : state === ""
          ? ""
          : "connecting";
  document.getElementById("recv-dot").className = "dot " + cls;
  document.getElementById("recv-status").textContent = msg;
}

/* ── 17. UTILS ────────────────────────────────────────────── */
function copyCode() {
  const code = document.getElementById("code-display").textContent;
  navigator.clipboard.writeText(code).then(() => showToast("Code copied!"));
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

function formatSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function escHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// Escape for use inside a <pre> — keeps real newlines (no <br>) so line
// numbers in the gutter stay aligned with the code rows.
function escCode(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escape for use inside a double-quoted HTML attribute.
function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/* ── INIT ─────────────────────────────────────────────────── */
window.addEventListener("load", boot);
