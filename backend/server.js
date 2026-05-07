const { WebSocketServer } = require("ws");

const PORT               = 8080;
const ROUND_RESET_MS     = 5000;
const VOTE_DEBOUNCE_MS   = 1500; // ms of silence after last press → finalise vote
const ANSWER_DEBOUNCE_MS = 7000; // ms of silence after last press → finalise answer selection

const wss = new WebSocketServer({ port: PORT });

const browsers   = new Set(); // index.html + host.html clients
const buzzers    = new Set();
const buzzerMap  = new Map(); // buzzer_id → ws

let roundWinner  = null;
let resetTimer   = null;
let judged       = false; // whether the current buzz winner has been judged by host
let scores       = {};    // { buzzer_id: points } — server-authoritative scores

// Vote state
let voteActive     = false;  // guard: true while a vote is in progress
let voteMode       = false;
let voteCategories = [];
let voteCounts     = {};          // { A: n, B: n, C: n, D: n }
let voterDone      = new Set();   // buzzer_ids that have already cast a vote
let pressBuffers   = {};          // { buzzer_id: { count, timer } }

// Answer window state (active while the declared winner presses to pick A/B/C/D)
let answerActive   = false;
let answerBuzzerId = null;
let answerPresses  = 0;
let answerTimer    = null;

// Question state
let questionBank   = [];          // processed question objects
let currentQIndex  = -1;

// Stored category (set via set_category before start_game)
let storedCategoryId   = null;
let storedCategoryName = null;

const CATEGORY_ID_MAP = {
  "General Knowledge": 9,
  "Entertainment":     11,
  "Film":              11,
  "Music":             12,
  "Television":        14,
  "Video Games":       15,
  "Science":           17,
  "Science & Nature":  17,
  "Technology":        18,
  "Computers":         18,
  "Mathematics":       19,
  "Mythology":         20,
  "Sports":            21,
  "Geography":         22,
  "History":           23,
  "Politics":          24,
  "Art":               25,
  "Art & Literature":  25,
  "Animals":           27,
};

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
  closeAnswerWindow();
  roundWinner = null;
  judged      = false;
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  log(`Round reset (${source}).`);
  broadcast(browsers, { type: "round_reset" });
}

function scheduleAutoReset() {
  if (resetTimer) return;
  resetTimer = setTimeout(() => resetRound("auto"), ROUND_RESET_MS);
}

// ─────────────────────────────────────────────────────────────
// Answer window
// ─────────────────────────────────────────────────────────────
function closeAnswerWindow() {
  if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
  answerActive   = false;
  answerBuzzerId = null;
  answerPresses  = 0;
}

function finaliseAnswer(reason = "timeout") {
  if (!answerActive) return;
  const presses = answerPresses;
  const id      = answerBuzzerId;
  const choice  = presses >= 1 && presses <= 4 ? ["A", "B", "C", "D"][presses - 1] : null;
  closeAnswerWindow();
  log(`Answer window closed (${reason}). Buzzer ${id}: ${presses} press(es) → ${choice ?? "none"}`);
  if (choice) {
    broadcast(browsers, { type: "answer_selected", buzzer_id: id, choice });
  }
  // Safety net: auto-reset if host doesn't judge promptly
  scheduleAutoReset();
}

function openAnswerWindow(buzzer_id) {
  // Cancel any pending auto-reset — the answer window owns the timeout from here
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  answerActive   = true;
  answerBuzzerId = buzzer_id;
  answerPresses  = 0;
  answerTimer    = setTimeout(() => finaliseAnswer("timeout"), ANSWER_DEBOUNCE_MS);
  log(`Answer window opened for Buzzer ${buzzer_id} (${ANSWER_DEBOUNCE_MS / 1000}s debounce).`);
}

// ─────────────────────────────────────────────────────────────
// Category vote
// ─────────────────────────────────────────────────────────────
function startVote(cats) {
  voteActive     = true;
  voteMode       = true;
  voteCategories = cats;
  voteCounts     = { A: 0, B: 0, C: 0, D: 0 };
  voterDone      = new Set();
  pressBuffers   = {};
  roundWinner    = null; // unlock buzzers for vote presses
  log("Category vote started:", cats);
  broadcast(browsers, { type: "category_vote", categories: cats, counts: voteCounts });
  broadcast(buzzers,  { type: "vote_start" }); // tell ESP32s to enter VOTE_MODE
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
  const choiceName = voteCategories[["A","B","C","D"].indexOf(choice)] ?? choice;
  log(`Buzzer ${buzzer_id} voted ${choice} — ${choiceName} (${count} press(es))`);
  broadcast(browsers, { type: "vote_update", buzzer_id, choice, choiceName, counts: { ...voteCounts } });
}

function endVote() {
  voteActive = false;
  voteMode   = false;
  // Cancel any pending debounce timers and finalise early
  for (const id of Object.keys(pressBuffers)) {
    if (pressBuffers[id].timer) clearTimeout(pressBuffers[id].timer);
    finaliseVote(Number(id));
  }
  pressBuffers = {};

  // Determine winning option (highest vote count; ties go to first alphabetically)
  const opts = ["A","B","C","D"];
  const [winnerOpt] = Object.entries(voteCounts).reduce((best, curr) => curr[1] > best[1] ? curr : best, ["", -1]);
  const winnerName  = winnerOpt ? (voteCategories[opts.indexOf(winnerOpt)] ?? winnerOpt) : null;

  log(`Vote ended. Winner: ${winnerOpt} (${winnerName}). Results:`, voteCounts);
  broadcast(browsers, { type: "vote_end", counts: { ...voteCounts }, winner: winnerOpt, winnerName });
  broadcast(buzzers,  { type: "vote_end" }); // tell ESP32s to return to BUZZ_MODE
}

// ─────────────────────────────────────────────────────────────
// Question fetching & processing
// ─────────────────────────────────────────────────────────────

// Named entity map for characters OpenTDB commonly encodes
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  hellip: "…", ndash: "–", mdash: "—",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  agrave: "à", aacute: "á", acirc: "â", auml: "ä",
  iacute: "í", icirc: "î", igrave: "ì", iuml: "ï",
  oacute: "ó", ocirc: "ô", ograve: "ò", ouml: "ö",
  uacute: "ú", ucirc: "û", ugrave: "ù", uuml: "ü",
  ntilde: "ñ", ccedil: "ç", szlig: "ß",
  deg: "°", frac12: "½", times: "×", divide: "÷",
  prime: "′", Prime: "″", pi: "π", alpha: "α",
};

function decodeHtml(str) {
  return str
    .replace(/&#(\d+);/g,       (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g,  (orig, name) => NAMED_ENTITIES[name] ?? orig);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function processQuestion(raw) {
  const correct      = decodeHtml(raw.correct_answer);
  const incorrects   = raw.incorrect_answers.map(decodeHtml);
  const options      = shuffle([correct, ...incorrects]);
  const correctIndex = options.indexOf(correct);
  return {
    question: decodeHtml(raw.question),
    options,
    correct: correctIndex,
  };
}

async function fetchQuestions(categoryId) {
  const url = `https://opentdb.com/api.php?amount=10&category=${categoryId}&type=multiple`;
  log(`Fetching: ${url}`);
  const res  = await fetch(url);
  log(`OpenTDB response: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  log(`OpenTDB response_code=${data.response_code}, questions=${data.results?.length ?? 0}`);
  if (data.response_code !== 0) throw new Error(`OpenTDB response_code ${data.response_code}`);
  return data.results.map(processQuestion);
}

function sendQuestion(index) {
  const q = questionBank[index];
  if (!q) return;
  log(`Sending Q${index + 1}/${questionBank.length}: ${q.question.slice(0, 60)}…`);
  broadcast(browsers, {
    type:           "question",
    questionNumber: index + 1,
    total:          questionBank.length,
    text:           q.question,
    options:        q.options,
    correct:        q.correct,
  });
}

// ─────────────────────────────────────────────────────────────
// Host message handler
// ─────────────────────────────────────────────────────────────
function handleHostMessage(msg) {
  switch (msg.type) {
    case "start_game": {
      const catId   = msg.category_id ?? storedCategoryId;
      const catName = storedCategoryName ?? `category ${catId}`;
      if (!catId) {
        broadcast(browsers, { type: "error", message: "No category selected. Use Set Category in the host panel first." });
        break;
      }
      broadcast(browsers, { type: "loading", message: `Loading ${catName} questions…` });
      fetchQuestions(catId)
        .then((questions) => {
          questionBank  = questions;
          currentQIndex = 0;
          scores        = {};    // fresh scores for new game
          judged        = false;
          log(`Loaded ${questionBank.length} questions for "${catName}" (ID ${catId}). Broadcasting Q1.`);
          const q = questions[0];
          broadcast(browsers, {
            type:           "question",
            questionNumber: 1,
            total:          questions.length,
            text:           q.question,
            options:        q.options,
            correct:        q.correct,
          });
        })
        .catch((err) => {
          log("Failed to fetch questions:", err.message);
          broadcast(browsers, { type: "error", message: `Could not load questions: ${err.message}` });
        });
      break;
    }

    case "start_round":
      resetRound("host");
      voteMode = false;
      break;

    case "reset_round":
      resetRound("host");
      break;

    case "judge": {
      finaliseAnswer("host_judge"); // lock in the answer selection before scoring
      if (roundWinner === null || judged) {
        log("Judge ignored — no active winner or already judged.");
        break;
      }
      judged = true;
      const winner = roundWinner;
      if (msg.result === "correct") scores[winner] = (scores[winner] || 0) + 1;
      const correctIndex = questionBank[currentQIndex]?.correct ?? null;
      log(`Judge: ${msg.result} for Buzzer ${winner}. Scores: ${JSON.stringify(scores)}`);
      broadcast(browsers, {
        type:         "judge_result",
        result:       msg.result,
        buzzer_id:    winner,
        correctIndex,
        scores:       { ...scores },
      });
      resetRound("judge");
      break;
    }

    case "next_question":
      resetRound("host");
      if (questionBank.length > 0) {
        if (currentQIndex < questionBank.length - 1) {
          currentQIndex++;
          sendQuestion(currentQIndex);
        } else {
          log("All questions exhausted.");
          broadcast(browsers, { type: "game_over", total: questionBank.length, scores: { ...scores } });
        }
      } else {
        broadcast(browsers, { type: "next_question" });
      }
      break;

    case "start_vote":
      if (voteActive) {
        log("Vote already in progress — ignoring start_vote.");
        break;
      }
      startVote(msg.categories || ["Category A", "Category B", "Category C", "Category D"]);
      break;

    case "end_vote":
      endVote();
      break;

    case "set_category":
      storedCategoryName = msg.category;
      storedCategoryId   = msg.category_id ?? CATEGORY_ID_MAP[msg.category] ?? null;
      log(`Category stored: "${storedCategoryName}" → OpenTDB ID ${storedCategoryId}`);
      broadcast(browsers, { type: "category_selected",  category:     storedCategoryName });
      broadcast(browsers, { type: "category_confirmed", categoryName: storedCategoryName });
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

  // Answer window: the declared winner is pressing to select their answer (1=A … 4=D)
  if (answerActive && buzzer_id === answerBuzzerId) {
    answerPresses++;
    // Debounce: reset the 7-second timer on each press
    if (answerTimer) clearTimeout(answerTimer);
    answerTimer = setTimeout(() => finaliseAnswer("timeout"), ANSWER_DEBOUNCE_MS);
    const letter = ["A", "B", "C", "D"][answerPresses - 1] ?? "?";
    log(`Buzzer ${buzzer_id} answer press #${answerPresses} → ${letter}`);
    return;
  }

  if (roundWinner !== null) {
    log(`Buzzer ${buzzer_id} pressed — round already won by ${roundWinner}, ignored.`);
    return;
  }

  roundWinner = buzzer_id;
  judged      = false;
  log(`*** Winner: Buzzer ${buzzer_id} (t=${timestamp}) ***`);
  broadcast(browsers, { type: "buzz", buzzer_id, timestamp });

  // Tell the winning ESP32 to switch to ANSWER_MODE
  const winnerWs = buzzerMap.get(buzzer_id);
  if (winnerWs && winnerWs.readyState === winnerWs.OPEN) {
    winnerWs.send(JSON.stringify({ type: "your_turn", buzzer_id }));
    log(`Sent your_turn to Buzzer ${buzzer_id}.`);
  }

  openAnswerWindow(buzzer_id);
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
        // Send current state so late-joining hosts/players are in sync
        ws.send(JSON.stringify({
          type: "state_sync",
          roundWinner,
          voteActive, voteMode, voteCounts, voteCategories,
          questionNumber:  currentQIndex >= 0 ? currentQIndex + 1 : null,
          questionTotal:   questionBank.length,
          currentQuestion: currentQIndex >= 0 ? {
            text:    questionBank[currentQIndex].question,
            options: questionBank[currentQIndex].options,
            correct: questionBank[currentQIndex].correct,
          } : null,
          storedCategoryName,
          scores: { ...scores },
        }));
        return;
      }
      if (msg.buzzer_id !== undefined) {
        clientType = "buzzer";
        buzzerId   = msg.buzzer_id;
        buzzers.add(ws);
        buzzerMap.set(buzzerId, ws);
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
      if (buzzerId !== null) buzzerMap.delete(buzzerId);
      log(`Buzzer ${buzzerId} disconnected. (${buzzers.size} buzzer(s))`);
      if (buzzerId !== null) {
        broadcast(browsers, { type: "player_left", buzzer_id: buzzerId });
      }
    }
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
});
