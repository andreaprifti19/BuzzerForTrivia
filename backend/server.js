const { WebSocketServer } = require("ws");

const PORT               = 8080;
const ROUND_RESET_MS     = 5000;
const VOTE_DEBOUNCE_MS   = 1500; // ms of silence after last press → finalise vote

const wss = new WebSocketServer({ port: PORT });

const browsers = new Set(); // index.html + host.html clients
const buzzers  = new Set();

let roundWinner  = null;
let resetTimer   = null;

// Vote state
let voteMode     = false;
let voteCategories = [];
let voteCounts   = {};          // { A: n, B: n, C: n, D: n }
let voterDone    = new Set();   // buzzer_ids that have already cast a vote
let pressBuffers = {};          // { buzzer_id: { count, timer } }

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function broadcast(clients, obj) {
  const payload = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(payload);
  }
}

function log(...args) {
  console.log(new Date().toTimeString().slice(0, 8), ...args);
}

// ─────────────────────────────────────────────────────────────
// Round management
// ─────────────────────────────────────────────────────────────
function resetRound(source = "auto") {
  roundWinner = null;
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  log(`Round reset (${source}).`);
  broadcast(browsers, { type: "round_reset" });
}

function scheduleAutoReset() {
  if (resetTimer) return;
  resetTimer = setTimeout(() => resetRound("auto"), ROUND_RESET_MS);
}

// ─────────────────────────────────────────────────────────────
// Category vote
// ─────────────────────────────────────────────────────────────
function startVote(cats) {
  voteMode       = true;
  voteCategories = cats;
  voteCounts     = { A: 0, B: 0, C: 0, D: 0 };
  voterDone      = new Set();
  pressBuffers   = {};
  roundWinner    = null; // unlock buzzers for vote presses
  log("Category vote started:", cats);
  broadcast(browsers, { type: "vote_start", categories: cats, counts: voteCounts });
}

function finaliseVote(buzzer_id) {
  const buf = pressBuffers[buzzer_id];
  if (!buf) return;
  const count = buf.count;
  delete pressBuffers[buzzer_id];

  const opts   = ["A", "B", "C", "D"];
  const choice = opts[count - 1]; // 1 press=A, 2=B, 3=C, 4=D
  if (!choice || voterDone.has(buzzer_id)) return;

  voterDone.add(buzzer_id);
  voteCounts[choice]++;
  log(`Buzzer ${buzzer_id} voted ${choice} (${count} press(es))`);
  broadcast(browsers, { type: "vote_update", buzzer_id, choice, counts: { ...voteCounts } });
}

function endVote() {
  voteMode = false;
  // Cancel any pending debounce timers and finalise early
  for (const id of Object.keys(pressBuffers)) {
    if (pressBuffers[id].timer) clearTimeout(pressBuffers[id].timer);
    finaliseVote(Number(id));
  }
  pressBuffers = {};
  log("Vote ended. Results:", voteCounts);
  broadcast(browsers, { type: "vote_end", counts: { ...voteCounts } });
}

// ─────────────────────────────────────────────────────────────
// Host message handler
// ─────────────────────────────────────────────────────────────
function handleHostMessage(msg) {
  switch (msg.type) {
    case "start_round":
      resetRound("host");
      voteMode = false;
      break;

    case "reset_round":
      resetRound("host");
      break;

    case "next_question":
      resetRound("host");
      broadcast(browsers, { type: "next_question" });
      break;

    case "start_vote":
      startVote(msg.categories || ["Category A", "Category B", "Category C", "Category D"]);
      break;

    case "end_vote":
      endVote();
      break;

    case "set_category":
      log("Category selected:", msg.category);
      broadcast(browsers, { type: "category_selected", category: msg.category });
      break;
  }
}

// ─────────────────────────────────────────────────────────────
// Buzzer press handler
// ─────────────────────────────────────────────────────────────
function handleBuzzerPress(buzzer_id, timestamp) {
  if (voteMode) {
    if (voterDone.has(buzzer_id)) return; // already cast vote
    if (!pressBuffers[buzzer_id]) pressBuffers[buzzer_id] = { count: 0, timer: null };
    const buf = pressBuffers[buzzer_id];
    buf.count++;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => finaliseVote(buzzer_id), VOTE_DEBOUNCE_MS);
    log(`Buzzer ${buzzer_id} press #${buf.count} (vote mode)`);
    return;
  }

  if (roundWinner !== null) {
    log(`Buzzer ${buzzer_id} pressed — round already won by ${roundWinner}, ignored.`);
    return;
  }

  roundWinner = buzzer_id;
  log(`*** Winner: Buzzer ${buzzer_id} (t=${timestamp}) ***`);
  broadcast(browsers, { type: "buzz", buzzer_id, timestamp });
  scheduleAutoReset();
}

// ─────────────────────────────────────────────────────────────
// Connection handler
// ─────────────────────────────────────────────────────────────
wss.on("listening", () => {
  log(`Server listening on ws://localhost:${PORT}`);
});

wss.on("connection", (ws) => {
  let clientType = null; // "browser" | "buzzer"
  let buzzerId   = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // ── Identify on first message ─────────────────────────────
    if (clientType === null) {
      const BROWSER_TYPES = ["browser", "host_join", "host"];
      if (BROWSER_TYPES.includes(msg.type)) {
        clientType = "browser";
        browsers.add(ws);
        log(`Browser/host connected. (${browsers.size} browser(s), ${buzzers.size} buzzer(s))`);
        // Send current state so late-joining hosts are in sync
        ws.send(JSON.stringify({ type: "state_sync", roundWinner, voteMode, voteCounts, voteCategories }));
        return;
      }
      if (msg.buzzer_id !== undefined) {
        clientType = "buzzer";
        buzzerId   = msg.buzzer_id;
        buzzers.add(ws);
        log(`Buzzer ${buzzerId} connected. (${browsers.size} browser(s), ${buzzers.size} buzzer(s))`);
        broadcast(browsers, { type: "player_joined", buzzer_id: buzzerId });
        // First message may also be a press — fall through.
      } else {
        log("Unrecognised first message, ignoring:", msg);
        return;
      }
    }

    // ── Dispatch ──────────────────────────────────────────────
    if (clientType === "browser") {
      handleHostMessage(msg);
    } else if (clientType === "buzzer") {
      if (msg.buzzer_id !== undefined && msg.timestamp !== undefined) {
        handleBuzzerPress(msg.buzzer_id, msg.timestamp);
      }
    }
  });

  ws.on("close", () => {
    if (clientType === "browser") {
      browsers.delete(ws);
      log(`Browser/host disconnected. (${browsers.size} browser(s))`);
    } else if (clientType === "buzzer") {
      buzzers.delete(ws);
      log(`Buzzer ${buzzerId} disconnected. (${buzzers.size} buzzer(s))`);
      if (buzzerId !== null) {
        broadcast(browsers, { type: "player_left", buzzer_id: buzzerId });
      }
    }
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
});
