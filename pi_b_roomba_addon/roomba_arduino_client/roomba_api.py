from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
import serial
import serial.tools.list_ports
import time
from pydantic import BaseModel
from typing import Optional
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
import os
import threading
from dotenv import load_dotenv
load_dotenv()

try:
    import cv2
except Exception:
    cv2 = None

from auto_pilot import AutoPilot

app = FastAPI(title="Roomba Serial API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global serial connection
ser: Optional[serial.Serial] = None


def _find_usb_camera() -> str:
    """Auto-detect USB camera by trying /dev/video0..3 with V4L2 backend."""
    for idx in range(4):
        path = f"/dev/video{idx}"
        if not os.path.exists(path):
            continue
        cap = cv2.VideoCapture(path, cv2.CAP_V4L2)
        if cap.isOpened():
            # Check it can actually grab a frame
            ok, _ = cap.read()
            cap.release()
            if ok:
                return path
    return "/dev/video0"


class UsbCameraStreamer:
    def __init__(self):
        self.cap = None
        self.running = False
        self.thread = None
        self.last_frame = None
        self.lock = threading.Lock()
        self.device = "/dev/video0"
        self.width = 640
        self.height = 480
        self.fps = 15
        self.quality = 70

    def start(self, device: str = "", width: int = 640, height: int = 480, fps: int = 15, quality: int = 70):
        if cv2 is None:
            raise RuntimeError("OpenCV (cv2) is not installed. Install opencv-python.")

        self.device = device if device else _find_usb_camera()
        self.width = width
        self.height = height
        self.fps = fps
        self.quality = max(30, min(90, quality))

        if self.running:
            return

        self.cap = cv2.VideoCapture(self.device, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            self.cap = None
            raise RuntimeError(f"Cannot open camera device {self.device}")

        # Ask camera for MJPEG + lower resolution/fps to reduce CPU load on Pi.
        self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self.cap.set(cv2.CAP_PROP_FPS, self.fps)

        self.running = True
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.0)
        self.thread = None

        if self.cap:
            self.cap.release()
        self.cap = None

        with self.lock:
            self.last_frame = None

    def _capture_loop(self):
        while self.running and self.cap:
            ok, frame = self.cap.read()
            if not ok:
                time.sleep(0.05)
                continue

            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.quality])
            if not ok:
                continue

            with self.lock:
                self.last_frame = buf.tobytes()

            # Keep feed lightweight.
            time.sleep(1.0 / max(1, self.fps))

    def frame_generator(self):
        while self.running:
            with self.lock:
                frame = self.last_frame

            if frame:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                )
            else:
                time.sleep(0.05)

            time.sleep(0.005)


camera = UsbCameraStreamer()
autopilot = AutoPilot()

class ConnectionConfig(BaseModel):
    port: str = "/dev/ttyACM0"
    baud_rate: int = 9600

def get_serial_ports():
    return [port.device for port in serial.tools.list_ports.comports()]

@app.get("/ports")
def list_ports():
    """List available serial ports"""
    return {"ports": get_serial_ports()}

@app.post("/connect")
def connect_serial(config: ConnectionConfig):
    """Connect to the specified serial port"""
    global ser
    
    if ser and ser.is_open:
        ser.close()
        
    try:
        ser = serial.Serial(config.port, config.baud_rate, timeout=1)
        time.sleep(2) # Wait for connection
        return {"status": "connected", "port": config.port}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/disconnect")
def disconnect_serial():
    """Disconnect from the serial port"""
    global ser
    if ser and ser.is_open:
        ser.close()
        ser = None
    return {"status": "disconnected"}

@app.post("/command/{cmd_type}")
def send_command(cmd_type: str):
    """
    Send command to Roomba.
    cmd_type: 'forward', 'right', 'left', 'back', 'stop'
    """
    global ser
    
    if not ser or not ser.is_open:
        raise HTTPException(status_code=400, detail="Serial port not connected. Call /connect first.")
    
    command_map = {
        "forward": b'0',
        "right": b'1',
        "left": b'2',
        "back": b'3',
        "stop": b's' # Stop on any other char
    }
    
    if cmd_type not in command_map:
        raise HTTPException(status_code=400, detail="Invalid command type")
    
    try:
        cmd_char = command_map[cmd_type]
        ser.write(cmd_char)
        
        # Read response if available
        response = ""
        time.sleep(0.1)
        if ser.in_waiting > 0:
            response = ser.read(ser.in_waiting).decode('utf-8', errors='ignore')
            
        return {
            "status": "sent", 
            "command": cmd_type, 
            "char": cmd_char.decode(),
            "arduino_response": response
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/camera/start")
def start_camera(device: str = "", width: int = 640, height: int = 480, fps: int = 15, quality: int = 70):
    try:
        camera.start(device=device, width=width, height=height, fps=fps, quality=quality)
        return {
            "status": "started",
            "device": device,
            "width": width,
            "height": height,
            "fps": fps,
            "quality": camera.quality,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/camera/stop")
def stop_camera():
    camera.stop()
    return {"status": "stopped"}


@app.get("/camera/status")
def camera_status():
    return {
        "running": camera.running,
        "device": camera.device,
        "width": camera.width,
        "height": camera.height,
        "fps": camera.fps,
        "quality": camera.quality,
        "opencv_installed": cv2 is not None,
    }


@app.get("/camera/stream")
def camera_stream():
    if not camera.running:
        # Auto-start with lightweight defaults.
        try:
            camera.start()
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return StreamingResponse(
        camera.frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

# ---------- Autopilot helpers ----------

def _get_camera_frame():
    """Return the latest JPEG frame bytes from the camera."""
    with camera.lock:
        return camera.last_frame


def _send_serial_command(cmd: str):
    """Send a movement command over the serial port."""
    global ser
    command_map = {
        "forward": b'0',
        "right": b'1',
        "left": b'2',
        "back": b'3',
        "stop": b's',
    }
    if ser and ser.is_open and cmd in command_map:
        ser.write(command_map[cmd])


class AutopilotConfig(BaseModel):
    interval: float = 3.0
    model: str = "gemini-robotics-er-1.5-preview"
    mode: str = "free"  # "free" or "goal"
    goal: str = ""


@app.post("/autopilot/start")
def start_autopilot(config: AutopilotConfig = AutopilotConfig()):
    if autopilot.running:
        return {"status": "already_running"}

    if not camera.running:
        try:
            camera.start()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Camera error: {e}")

    try:
        autopilot.start(
            get_frame_fn=_get_camera_frame,
            send_command_fn=_send_serial_command,
            interval=config.interval,
            model=config.model,
            mode=config.mode,
            goal=config.goal,
        )
        return {"status": "started", "interval": config.interval,
                "model": config.model, "mode": config.mode, "goal": config.goal}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/autopilot/stop")
def stop_autopilot():
    autopilot.stop()
    return {"status": "stopped"}


@app.get("/autopilot/status")
def autopilot_status():
    return autopilot.status()


@app.websocket("/ws/control")
async def ws_control(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            data = await ws.receive_json()
            cmd = data.get("cmd")
            if cmd:
                _send_serial_command(cmd)
    except WebSocketDisconnect:
        _send_serial_command("stop")
    except Exception:
        _send_serial_command("stop")


# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def read_index():
    return FileResponse('static/index.html')

if __name__ == "__main__":
    import uvicorn
    print("Starting server... Access docs at http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000)
