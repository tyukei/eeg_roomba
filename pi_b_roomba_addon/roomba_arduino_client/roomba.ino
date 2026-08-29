#include <SoftwareSerial.h>
SoftwareSerial device(10, 11);

void setup() {
  Serial.begin(9600);
  device.begin(115200);

  // デバッグ: 起動確認
  Serial.println("Arduino started!");
  Serial.println("Waiting for commands...");
  Serial.println("Commands: 0=forward, 1=right, 2=left, 3=back, c=clean, p=pause, d=dock, i=sensors");

  // Roombaを確実に起動モードにする
  delay(1000);       // Roombaの起動を待つ
  device.write(128); // Start
  delay(500);
  device.write(131); // Safe mode
  delay(500);

  // 通信確認: 起動時にビープ音を鳴らす
  device.write(140); // Define Song
  device.write(byte(0)); // Song slot 0
  device.write(2);   // 2 notes
  device.write(72);  // C5
  device.write(16);
  device.write(76);  // E5
  device.write(16);
  delay(100);
  device.write(141); // Play Song
  device.write(byte(0));

  Serial.println("Roomba initialized!");
}

void loop() {

  // デバッグ: シリアル受信確認
  if (Serial.available() > 0) {
    int cmd = Serial.read();

    // デバッグ: 受信したコマンドを表示
    Serial.print("Received command: ");
    Serial.println(cmd);

    Serial.write(cmd);
    switch (cmd) {

    case 48: // '0'
      Serial.println("-> Moving forward");
      motor(200, 200);
      break;
    case 49: // '1'
      Serial.println("-> Turning right");
      motor(200, -200);
      break;
    case 50: // '2'
      Serial.println("-> Turning left");
      motor(-200, 200);
      break;
    case 51: // '3'
      Serial.println("-> Moving back");
      motor(-200, -200);
      break;
    case 'c':
      Serial.println("-> Cleaning");
      device.write(135); // Clean
      return;
    case 'p':
      Serial.println("-> Stop cleaning / safe mode");
      device.write(128); // Start leaves the autonomous Clean cycle
      device.write(131); // return to Safe so manual drive remains available
      motor(0, 0);
      return;
    case 'd':
      Serial.println("-> Seek dock");
      device.write(143); // Force Seeking Dock
      return;
    case 'i':
      sendSensors();
      return;
    default:
      Serial.println("-> Stopping");
      motor(0, 0);
      break;
    }

    // 1秒間動作してから停止
    delay(1000);
    motor(0, 0);
    Serial.println("Stopped");
  }
  delay(100);
}

int readSensorByte() {
  unsigned long until = millis() + 80;
  while (!device.available() && millis() < until) delay(1);
  return device.available() ? device.read() : -1;
}

int readSensorU16() {
  int hi = readSensorByte();
  int lo = readSensorByte();
  return (hi < 0 || lo < 0) ? -1 : ((hi << 8) | lo);
}

void sendSensors() {
  // Individual OI packets keep the relay simple and work with the supported
  // 600-series/Create Open Interface models.  Values are a snapshot only;
  // unknown packets are sent as -1 instead of pretending they are valid.
  device.write(142); device.write(7);   int bumps = readSensorByte();
  device.write(142); device.write(8);   int wall = readSensorByte();
  device.write(142); device.write(9);   int cliff = readSensorByte();
  device.write(142); device.write(21);  int chargeState = readSensorByte();
  device.write(142); device.write(22);  int voltage = readSensorU16();
  device.write(142); device.write(25);  int charge = readSensorU16();
  device.write(142); device.write(26);  int capacity = readSensorU16();
  Serial.print("S,bump_left="); Serial.print(bumps >= 0 ? (bumps & 0x02 ? 1 : 0) : -1);
  Serial.print(",bump_right="); Serial.print(bumps >= 0 ? (bumps & 0x01 ? 1 : 0) : -1);
  Serial.print(",wall="); Serial.print(wall);
  Serial.print(",cliff="); Serial.print(cliff);
  Serial.print(",charging_state="); Serial.print(chargeState);
  Serial.print(",voltage_mv="); Serial.print(voltage);
  Serial.print(",charge_mah="); Serial.print(charge);
  Serial.print(",capacity_mah="); Serial.println(capacity);
}

void motor(int l, int r) {
  Serial.print("Motor values - Left: ");
  Serial.print(l);
  Serial.print(", Right: ");
  Serial.println(r);

  byte buffer[] = {byte(146), // Drive PWM
                   byte(r >> 8), byte(r), byte(l >> 8), byte(l)};
  device.write(buffer, 5);
}
