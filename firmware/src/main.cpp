#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#define BUTTON_PIN  19
#define BUZZER_PIN  18
#define BUZZER_ID   1

const char*    SSID             = "WAVLINK-N";
const char*    PASSWORD         = "EETL899003eb";
const char*    WS_HOST          = "192.168.10.168";
const uint16_t WS_PORT          = 8080;
const unsigned long BUZZER_MS   = 500;
const unsigned long ANSWER_WINDOW_MS = 7000;

// ── Mode ──────────────────────────────────────────────────────
enum Mode { BUZZ_MODE, ANSWER_MODE, VOTE_MODE };
Mode currentMode = BUZZ_MODE;

// ── State ─────────────────────────────────────────────────────
WebSocketsClient ws;
bool wsConnected = false;

bool buzzerActive      = false;
unsigned long buzzerStartMs = 0;

// Hardware debounce
bool          lastRawState    = HIGH;
bool          debouncing      = false;
unsigned long debounceStart   = 0;
unsigned long lastPressMs     = 0;
const unsigned long DEBOUNCE_MS      = 50;
const unsigned long MIN_PRESS_GAP_MS = 300;

int  pressCount        = 0;
unsigned long answerStartMs = 0;

// ── Helpers ───────────────────────────────────────────────────

void sendJson(JsonDocument& doc) {
  char buf[128];
  serializeJson(doc, buf);
  ws.sendTXT(buf);
  Serial.printf("TX: %s\n", buf);
}

void enterAnswerMode() {
  currentMode   = ANSWER_MODE;
  pressCount    = 0;
  answerStartMs = millis();
  Serial.println("→ ANSWER_MODE (7 s window)");
}

void sendAnswer() {
  if (wsConnected) {
    StaticJsonDocument<128> doc;
    doc["buzzer_id"] = BUZZER_ID;
    doc["type"]      = "answer";
    doc["selection"] = pressCount;
    sendJson(doc);
  }
  currentMode = BUZZ_MODE;
  pressCount  = 0;
  Serial.println("→ BUZZ_MODE");
}

// ── WebSocket events ──────────────────────────────────────────

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("WebSocket connected.");
      break;

    case WStype_DISCONNECTED:
      wsConnected = false;
      currentMode = BUZZ_MODE;
      Serial.println("WebSocket disconnected. Will retry…");
      break;

    case WStype_TEXT: {
      StaticJsonDocument<128> doc;
      if (deserializeJson(doc, payload, length)) break;
      const char* msgType = doc["type"] | "";
      if (strcmp(msgType, "your_turn") == 0) {
        enterAnswerMode();
      } else if (strcmp(msgType, "vote_start") == 0) {
        currentMode = VOTE_MODE;
        Serial.println("→ VOTE_MODE (silent presses)");
      } else if (strcmp(msgType, "vote_end") == 0) {
        if (currentMode == VOTE_MODE) {
          currentMode = BUZZ_MODE;
          Serial.println("→ BUZZ_MODE (vote ended)");
        }
      }
      break;
    }

    case WStype_ERROR:
      Serial.println("WebSocket error.");
      break;

    default:
      break;
  }
}

// ── WiFi ──────────────────────────────────────────────────────

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Connecting to %s…\n", SSID);
  WiFi.begin(SSID, PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nConnected. IP: %s\n", WiFi.localIP().toString().c_str());
}

// ── Setup ─────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  connectWiFi();
  ws.begin(WS_HOST, WS_PORT, "/");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
}

// ── Loop ──────────────────────────────────────────────────────

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  ws.loop();

  // Non-blocking buzzer off
  if (buzzerActive && millis() - buzzerStartMs >= BUZZER_MS) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerActive = false;
  }

  // Non-blocking hardware debounce
  bool rawState = digitalRead(BUTTON_PIN);
  if (!debouncing && lastRawState == HIGH && rawState == LOW) {
    // Falling edge detected — start debounce timer
    debouncing    = true;
    debounceStart = millis();
  }
  lastRawState = rawState;

  bool justPressed = false;
  if (debouncing && (millis() - debounceStart >= DEBOUNCE_MS)) {
    debouncing = false;
    if (digitalRead(BUTTON_PIN) == LOW) {          // still LOW after 50 ms → real press
      unsigned long now = millis();
      if (now - lastPressMs >= MIN_PRESS_GAP_MS) { // enforce 300 ms gap
        justPressed = true;
        lastPressMs = now;
      }
    }
  }

  if (currentMode == BUZZ_MODE) {
    if (justPressed) {
      // Sound buzzer
      digitalWrite(BUZZER_PIN, HIGH);
      buzzerActive  = true;
      buzzerStartMs = millis();

      // Send buzz message
      if (wsConnected) {
        StaticJsonDocument<128> doc;
        doc["buzzer_id"] = BUZZER_ID;
        doc["type"]      = "buzz";
        doc["timestamp"] = millis();
        sendJson(doc);
      } else {
        Serial.println("Button pressed but WebSocket not connected.");
      }
    }

  } else if (currentMode == ANSWER_MODE) {
    if (justPressed && pressCount < 4) {
      pressCount++;
      Serial.printf("Press %d/4\n", pressCount);
    }

    if (millis() - answerStartMs >= ANSWER_WINDOW_MS) {
      sendAnswer();
    }

  } else { // VOTE_MODE — silent presses, no buzzer
    if (justPressed && wsConnected) {
      StaticJsonDocument<128> doc;
      doc["buzzer_id"] = BUZZER_ID;
      doc["type"]      = "buzz";
      doc["timestamp"] = millis();
      sendJson(doc);
      Serial.println("Vote press (silent).");
    }
  }
}
