const { WebSocketServer } = require("ws");

const PORT = 8080;
const ROUND_RESET_DELAY_MS = 5000;

const wss = new WebSocketServer({ port: PORT });

// Tracked client sets
const browsers = new Set();
const buzzers  = new Set();

let roundWinner = null;
let resetTimer  = null;

function broadcast(browsers, obj) {
  const payload = JSON.stringify(obj);
  for (const client of browsers) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function resetRound() {
  roundWinner = null;
  resetTimer  = null;
  console.log("--- Round reset. Ready for next press. ---");
  broadcast(browsers, { type: "round_reset" });
}

function scheduleReset() {
  if (resetTimer) return;
  resetTimer = setTimeout(resetRound, ROUND_RESET_DELAY_MS);
}

wss.on("listening", () => {
  console.log(`Buzzer server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws) => {
  // Client type is determined by the first message received.
  // Browsers send { "type": "browser" } (or { "type": "host_join", ... }).
  // ESP32 buzzers send { "buzzer_id": N, "timestamp": N }.
  let clientType = null; // "browser" | "buzzer"

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn("Received non-JSON message, ignoring.");
      return;
    }

    // ── Identify client on first message ──────────────────────
    if (clientType === null) {
      if (msg.type === "browser" || msg.type === "host_join") {
        clientType = "browser";
        browsers.add(ws);
        console.log(`Browser client connected. (${browsers.size} browser(s), ${buzzers.size} buzzer(s))`);
        return;
      } else if (msg.buzzer_id !== undefined) {
        clientType = "buzzer";
        buzzers.add(ws);
        const id = msg.buzzer_id;
        console.log(`Buzzer ${id} connected. (${browsers.size} browser(s), ${buzzers.size} buzzer(s))`);
        broadcast(browsers, { type: "player_joined", buzzer_id: id });
        // Fall through to handle the press if timestamp is present.
      } else {
        console.warn("Unrecognised first message, ignoring:", msg);
        return;
      }
    }

    // ── Handle buzzer press ───────────────────────────────────
    if (clientType === "buzzer") {
      const { buzzer_id, timestamp } = msg;
      if (buzzer_id === undefined || timestamp === undefined) return;

      if (roundWinner !== null) {
        console.log(`Buzzer ${buzzer_id} pressed, but round already won by buzzer ${roundWinner}.`);
        return;
      }

      roundWinner = buzzer_id;
      console.log(`*** Winner: Buzzer ${buzzer_id} (timestamp: ${timestamp}) ***`);
      broadcast(browsers, { type: "buzz", buzzer_id, timestamp });
      scheduleReset();
    }
  });

  ws.on("close", () => {
    if (clientType === "browser") {
      browsers.delete(ws);
      console.log(`Browser client disconnected. (${browsers.size} browser(s))`);
    } else if (clientType === "buzzer") {
      buzzers.delete(ws);
      // Recover buzzer_id from the Set isn't possible after close, so we
      // broadcast with what we know — the frontend handles unknown IDs gracefully.
      console.log(`A buzzer disconnected. (${buzzers.size} buzzer(s))`);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});
