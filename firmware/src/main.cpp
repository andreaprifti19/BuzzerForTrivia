#include <Arduino.h>
#include <FastLED.h>

#define BUTTON_PIN 19
#define BUZZER_PIN 18
#define LED_PIN    4
#define NUM_LEDS   1

CRGB leds[NUM_LEDS];

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(64);
  leds[0] = CRGB::Black;
  FastLED.show();
}

void loop() {
  bool pressed = digitalRead(BUTTON_PIN) == LOW;

  if (pressed) {
    leds[0] = CRGB::Green;
    FastLED.show();
    digitalWrite(BUZZER_PIN, HIGH);
    delay(500);
    digitalWrite(BUZZER_PIN, LOW);
    // Wait for release before allowing another trigger
    while (digitalRead(BUTTON_PIN) == LOW) {}
  } else {
    leds[0] = CRGB::Black;
    FastLED.show();
    digitalWrite(BUZZER_PIN, LOW);
  }
}
