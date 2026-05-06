#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#define BUTTON_PIN  19
#define BUZZER_PIN  18
#define BUZZER_ID   1

const char* SSID     = "WAVLINK-N";
const char* PASSWORD = "EETL899003eb";
const char* WS_HOST  = "192.168.10.168";
const uint16_t WS_PORT = 8080;

WebSocketsClient ws;
bool wsConnected = false;

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("WebSocket connected.");
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("WebSocket disconnected. Will retry...");
      break;
    case WStype_ERROR:
      Serial.println("WebSocket error.");
      break;
    default:
      break;
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Connecting to WiFi: %s\n", SSID);
  WiFi.begin(SSID, PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi connected. IP: %s\n", WiFi.localIP().toString().c_str());
}

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

void loop() {
  // Reconnect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  ws.loop();

  if (digitalRead(BUTTON_PIN) == LOW) {
    // Sound buzzer
    digitalWrite(BUZZER_PIN, HIGH);
    delay(500);
    digitalWrite(BUZZER_PIN, LOW);

    // Send JSON message
    if (wsConnected) {
      StaticJsonDocument<64> doc;
      doc["buzzer_id"] = BUZZER_ID;
      doc["timestamp"] = millis();
      char buf[64];
      serializeJson(doc, buf);
      ws.sendTXT(buf);
      Serial.printf("Sent: %s\n", buf);
    } else {
      Serial.println("Button pressed but WebSocket not connected.");
    }

    // Wait for release
    while (digitalRead(BUTTON_PIN) == LOW) {
      ws.loop();
    }
  }
}
