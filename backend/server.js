const { WebSocketServer } = require("ws");

const PORT = 8080;
const ROUND_RESET_DELAY_MS = 5000;

const wss = new WebSocketServer({ port: PORT });

let roundWinner = null;
let resetTimer = null;

function resetRound() {
  roundWinner = null;
  resetTimer = null;
  console.log("--- Round reset. Ready for next press. ---");
}

function scheduleReset() {
  if (resetTimer) return;
  resetTimer = setTimeout(resetRound, ROUND_RESET_DELAY_MS);
}

wss.on("listening", () => {
  console.log(`Buzzer server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws) => {
  console.log("Buzzer connected.");

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn("Received non-JSON message, ignoring.");
      return;
    }

    const { buzzer_id, timestamp } = msg;
    if (buzzer_id === undefined || timestamp === undefined) {
      console.warn("Message missing buzzer_id or timestamp, ignoring.");
      return;
    }

    if (roundWinner !== null) {
      console.log(`Buzzer ${buzzer_id} pressed, but round already won by buzzer ${roundWinner}.`);
      return;
    }

    roundWinner = buzzer_id;
    console.log(`*** Winner: Buzzer ${buzzer_id} (timestamp: ${timestamp}) ***`);
    scheduleReset();
  });

  ws.on("close", () => {
    console.log("Buzzer disconnected.");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});
