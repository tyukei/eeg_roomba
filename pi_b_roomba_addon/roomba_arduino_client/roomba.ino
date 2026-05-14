#include <SoftwareSerial.h>
SoftwareSerial device(10, 11);

void setup() {
  Serial.begin(9600);
  device.begin(115200);

  // デバッグ: 起動確認
  Serial.println("Arduino started!");
  Serial.println("Waiting for commands...");
  Serial.println("Commands: 0=forward, 1=right, 2=left, 3=back, other=stop");

  // Roombaを確実に起動モードにする
  delay(1000);       // Roombaの起動を待つ
  device.write(128); // Start
  delay(500);
  device.write(131); // Safe mode
  delay(500);

  // 通信確認: 起動時にビープ音を鳴らす
  device.write(140); // Define Song
  device.write(0);   // Song slot 0
  device.write(2);   // 2 notes
  device.write(72);  // C5
  device.write(16);
  device.write(76);  // E5
  device.write(16);
  delay(100);
  device.write(141); // Play Song
  device.write(0);

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

void motor(int l, int r) {
  Serial.print("Motor values - Left: ");
  Serial.print(l);
  Serial.print(", Right: ");
  Serial.println(r);

  byte buffer[] = {byte(146), // Drive PWM
                   byte(r >> 8), byte(r), byte(l >> 8), byte(l)};
  device.write(buffer, 5);
}
