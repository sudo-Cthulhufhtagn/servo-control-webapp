#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <ESP32Servo.h>

static constexpr uint8_t kServo1Pin = 0;
static constexpr uint8_t kServo2Pin = 1;
static constexpr uint8_t kSignalPin = 2;

static constexpr uint16_t kServoMinPulseUs = 500;
static constexpr uint16_t kServoMaxPulseUs = 2500;

static constexpr const char *kBleName = "ESP32-Servo-Control";
static constexpr const char *kServiceUuid = "6f94b030-1c3a-4c44-8f19-1f8b31d71f40";
static constexpr const char *kCommandUuid = "6f94b031-1c3a-4c44-8f19-1f8b31d71f40";

int servo1Angle = 90;
int servo2Angle = 90;
int servo1Target = 90;
int servo2Target = 90;
int servoStepDelayMs = 0;
bool sweep1Active = false;
bool sweep1Forward = true;
bool sweep2Active = false;
bool sweep2Forward = true;
bool outputHigh = false;
unsigned long lastStatusAt = 0;
unsigned long lastServoStepAt = 0;
Servo servo1;
Servo servo2;
char serialBuffer[64];
size_t serialLength = 0;

void writeServoAngle(Servo &servo, int angle) {
  int bounded = constrain(angle, 0, 180);
  servo.write(bounded);
}

void setServoTargets(int servo1Value, int servo2Value) {
  servo1Target = constrain(servo1Value, 0, 180);
  servo2Target = constrain(servo2Value, 0, 180);
}

void setServo1Sweep(bool enabled) {
  sweep1Active = enabled;
  if (sweep1Active) {
    sweep1Forward = true;
    servo1Target = 180;
    Serial.println("sweep1 started");
  } else {
    Serial.println("sweep1 stopped");
  }
}

void setServo2Sweep(bool enabled) {
  sweep2Active = enabled;
  if (sweep2Active) {
    sweep2Forward = true;
    servo2Target = 180;
    Serial.println("sweep2 started");
  } else {
    Serial.println("sweep2 stopped");
  }
}

void setSpeedMs(int value) {
  servoStepDelayMs = constrain(value, 0, 100);
  Serial.print("speed set to ");
  Serial.print(servoStepDelayMs);
  Serial.println(" ms");
}

void applyOutputState(bool high) {
  outputHigh = high;
  digitalWrite(kSignalPin, outputHigh ? HIGH : LOW);
}

void handleCommand(const String &rawCommand) {
  String command = rawCommand;
  command.trim();
  if (command.length() == 0) {
    return;
  }

  Serial.print("cmd: ");
  Serial.println(command);

  int split = command.indexOf(':');
  if (split <= 0 || split >= command.length() - 1) {
    Serial.println("invalid command format");
    return;
  }

  String key = command.substring(0, split);
  String valuePart = command.substring(split + 1);
  valuePart.trim();
  long value = valuePart.toInt();

  if (key == "servo1") {
    servo1Target = constrain(static_cast<int>(value), 0, 180);
    Serial.print("servo1 target set to ");
    Serial.println(servo1Target);
    return;
  }

  if (key == "servo2") {
    servo2Target = constrain(static_cast<int>(value), 0, 180);
    Serial.print("servo2 target set to ");
    Serial.println(servo2Target);
    return;
  }

  if (key == "servos") {
    int commaIndex = valuePart.indexOf(',');
    if (commaIndex <= 0 || commaIndex >= valuePart.length() - 1) {
      Serial.println("invalid servos format");
      return;
    }

    long v1 = valuePart.substring(0, commaIndex).toInt();
    long v2 = valuePart.substring(commaIndex + 1).toInt();
    servo1Target = constrain(static_cast<int>(v1), 0, 180);
    servo2Target = constrain(static_cast<int>(v2), 0, 180);
    Serial.print("servos target set to ");
    Serial.print(servo1Target);
    Serial.print(",");
    Serial.println(servo2Target);
    return;
  }

  if (key == "speed") {
    setSpeedMs(static_cast<int>(value));
    return;
  }

  if (key == "sweep1") {
    setServo1Sweep(value != 0);
    return;
  }

  if (key == "sweep2") {
    setServo2Sweep(value != 0);
    return;
  }

  if (key == "out") {
    applyOutputState(value != 0);
    Serial.print("out set to ");
    Serial.println(outputHigh ? "HIGH" : "LOW");
    return;
  }

  Serial.println("unknown key");
}

class CommandCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    std::string value = characteristic->getValue();
    if (!value.empty()) {
      handleCommand(String(value.c_str()));
    }
  }
};

void setupServos() {
  servo1.setPeriodHertz(50);
  servo2.setPeriodHertz(50);
  servo1.attach(kServo1Pin, kServoMinPulseUs, kServoMaxPulseUs);
  servo2.attach(kServo2Pin, kServoMinPulseUs, kServoMaxPulseUs);

  writeServoAngle(servo1, servo1Angle);
  writeServoAngle(servo2, servo2Angle);

  Serial.print("servo1 attached: ");
  Serial.println(servo1.attached() ? "yes" : "no");
  Serial.print("servo2 attached: ");
  Serial.println(servo2.attached() ? "yes" : "no");
}

void updateServoMotion() {
  if (millis() - lastServoStepAt < static_cast<unsigned long>(servoStepDelayMs)) {
    return;
  }

  lastServoStepAt = millis();

  if (servo1Angle < servo1Target) {
    ++servo1Angle;
    writeServoAngle(servo1, servo1Angle);
  } else if (servo1Angle > servo1Target) {
    --servo1Angle;
    writeServoAngle(servo1, servo1Angle);
  }

  if (sweep1Active && servo1Angle == servo1Target) {
    sweep1Forward = !sweep1Forward;
    servo1Target = sweep1Forward ? 180 : 0;
  }

  if (servo2Angle < servo2Target) {
    ++servo2Angle;
    writeServoAngle(servo2, servo2Angle);
  } else if (servo2Angle > servo2Target) {
    --servo2Angle;
    writeServoAngle(servo2, servo2Angle);
  }

  if (sweep2Active && servo2Angle == servo2Target) {
    sweep2Forward = !sweep2Forward;
    servo2Target = sweep2Forward ? 180 : 0;
  }
}

void setupBle() {
  BLEDevice::init(kBleName);
  BLEServer *server = BLEDevice::createServer();
  BLEService *service = server->createService(kServiceUuid);

  BLECharacteristic *commandChar = service->createCharacteristic(
      kCommandUuid,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);

  commandChar->setCallbacks(new CommandCallback());
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(kServiceUuid);
  advertising->start();
}

void setup() {
  Serial.begin(115200);
  unsigned long startWait = millis();
  while (!Serial && millis() - startWait < 2000) {
    delay(10);
  }

  pinMode(kSignalPin, OUTPUT);
  applyOutputState(false);
  setupServos();
  setupBle();

  Serial.println("BLE servo controller ready");
  Serial.println("Pins: servo1=GPIO0, servo2=GPIO1, out=GPIO2");
  Serial.println("Commands: servo1:<0-180>, servo2:<0-180>, servos:<0-180>,<0-180>, speed:<0-100>, sweep1:<0|1>, sweep2:<0|1>, out:<0|1>");
}

void loop() {
  while (Serial.available() > 0) {
    char incoming = static_cast<char>(Serial.read());

    if (incoming == '\r') {
      continue;
    }

    if (incoming == '\n') {
      serialBuffer[serialLength] = '\0';
      handleCommand(String(serialBuffer));
      serialLength = 0;
      continue;
    }

    if (serialLength < sizeof(serialBuffer) - 1) {
      serialBuffer[serialLength++] = incoming;
    }
  }

  updateServoMotion();

  unsigned long now = millis();
  if (now - lastStatusAt >= 2000) {
    lastStatusAt = now;
    Serial.print("state servo1=");
    Serial.print(servo1Angle);
    Serial.print(" servo2=");
    Serial.print(servo2Angle);
    Serial.print(" speed=");
    Serial.print(servoStepDelayMs);
    Serial.print(" sweep1=");
    Serial.print(sweep1Active ? "on" : "off");
    Serial.print(" sweep2=");
    Serial.print(sweep2Active ? "on" : "off");
    Serial.print(" out=");
    Serial.println(outputHigh ? "HIGH" : "LOW");
  }

  delay(0);
}