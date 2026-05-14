import serial
import serial.tools.list_ports
import time
import sys

def get_serial_ports():
    """Lists available serial ports."""
    ports = serial.tools.list_ports.comports()
    return ports

def main():
    print("Roomba Serial Controller")
    print("------------------------")
    
    # 1. Select Serial Port
    ports = get_serial_ports()
    
    if not ports:
        print("Error: No serial ports found. Please connect your Arduino.")
        return

    print("Available ports:")
    for i, port in enumerate(ports):
        print(f"{i}: {port.device} - {port.description}")

    selected_index = input("Select port index (default 0): ")
    if selected_index == "":
        selected_index = 0
    else:
        try:
            selected_index = int(selected_index)
            if selected_index < 0 or selected_index >= len(ports):
                print("Invalid index.")
                return
        except ValueError:
            print("Please enter a number.")
            return

    port_name = ports[selected_index].device
    baud_rate = 9600  # Must match Arduino Serial.begin(9600)

    try:
        ser = serial.Serial(port_name, baud_rate, timeout=1)
        time.sleep(2)  # Wait for Arduino restart on serial connection
        print(f"Connected to {port_name} at {baud_rate} baud.")
    except Exception as e:
        print(f"Error connecting to serial port: {e}")
        return

    print("\nControls:")
    print("0: Forward")
    print("1: Right")
    print("2: Left")
    print("3: Back")
    print("Any other key: Stop")
    print("Type 'q' to quit.")

    try:
        while True:
            command = input("\nEnter command: ").strip()
            
            if command.lower() == 'q':
                break
            
            if len(command) > 0:
                # Send first character only as Arduino expects single byte
                char_to_send = command[0]
                
                # Check if command is one of the valid control characters
                if char_to_send in ['0', '1', '2', '3']:
                    print(f"Sending: {char_to_send}")
                    ser.write(char_to_send.encode('utf-8'))
                    
                    # Read response if any (Arduino code has Serial.write(cmd))
                    time.sleep(0.1)
                    if ser.in_waiting > 0:
                        response = ser.read(ser.in_waiting)
                        try:
                            print(f"Arduino echoed: {response.decode('utf-8')}")
                        except:
                            print(f"Arduino echoed: {response}")
                else:
                    print(f"Sending unknown command: {char_to_send} (Stop)")
                    ser.write(char_to_send.encode('utf-8'))

    except KeyboardInterrupt:
        print("\nExiting...")
    finally:
        ser.close()
        print("Serial connection closed.")

if __name__ == "__main__":
    main()
