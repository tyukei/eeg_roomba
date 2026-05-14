"""
Autonomous driving module using Gemini Robotics-ER 1.5 as VLM.

Captures camera frames, sends to Gemini API for scene understanding,
and executes movement commands based on the model's decisions.
"""

import threading
import time
import json
import os
from typing import Optional, Callable, List, Dict

try:
    from google import genai
    from google.genai import types
except ImportError:
    genai = None

PROMPT_FREE = """\
You are the navigation brain of a Roomba robot. You see through its front camera.

Step 1 - Analyze the scene: Identify obstacles, walls, open paths, and spatial layout.
Step 2 - Decide action: Pick ONE command from the list below.

Commands:
- forward: Path ahead is clear
- left: Turn left to avoid obstacle or explore
- right: Turn right to avoid obstacle or explore
- back: Too close to obstacle, reverse
- stop: Unsafe or unclear situation

Respond with ONLY this JSON (no markdown, no extra text):
{"command": "<command>", "reason": "<brief scene analysis and why this action>"}"""

PROMPT_GOAL = """\
You are the navigation brain of a Roomba robot. You see through its front camera.
Your goal: {goal}

Step 1 - Analyze the scene: What do you see? Is the goal (or path toward it) visible?
Step 2 - Decide action: Move toward the goal while avoiding obstacles.
Step 3 - If you have reached the goal, stop.

Commands:
- forward: Move toward the goal
- left: Turn left to find or approach the goal
- right: Turn right to find or approach the goal
- back: Too close to obstacle, reverse
- stop: Goal reached OR unsafe situation

Respond with ONLY this JSON (no markdown, no extra text):
{{"command": "<command>", "reason": "<what you see and progress toward goal>"}}"""

VALID_COMMANDS = {"forward", "left", "right", "back", "stop"}


class AutoPilot:
    def __init__(self):
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.interval = 3.0
        self.last_command: Optional[str] = None
        self.last_reason: Optional[str] = None
        self.last_error: Optional[str] = None
        self.decisions: List[Dict] = []
        self.max_log = 20
        self._get_frame: Optional[Callable] = None
        self._send_command: Optional[Callable] = None
        self.model = "gemini-robotics-er-1.5-preview"
        self.mode = "free"  # "free" or "goal"
        self.goal = ""

    def start(self, get_frame_fn: Callable, send_command_fn: Callable,
              interval: float = 3.0, model: str = "",
              mode: str = "free", goal: str = ""):
        if genai is None:
            raise RuntimeError(
                "google-genai not installed. Run: uv pip install google-genai")

        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY environment variable not set")

        if model:
            self.model = model
        self.mode = mode if mode in ("free", "goal") else "free"
        self.goal = goal
        self._get_frame = get_frame_fn
        self._send_command = send_command_fn
        self.interval = max(1.0, interval)
        self.running = True
        self.last_error = None
        self.decisions = []

        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5.0)
        self.thread = None
        if self._send_command:
            try:
                self._send_command("stop")
            except Exception:
                pass

    def _build_prompt(self):
        if self.mode == "goal" and self.goal:
            return PROMPT_GOAL.format(goal=self.goal)
        return PROMPT_FREE

    def _loop(self):
        client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
        prompt = self._build_prompt()

        while self.running:
            try:
                frame_bytes = self._get_frame()
                if not frame_bytes:
                    self.last_error = "No camera frame"
                    time.sleep(1)
                    continue

                response = client.models.generate_content(
                    model=self.model,
                    contents=[
                        types.Part.from_bytes(
                            data=frame_bytes, mime_type="image/jpeg"),
                        prompt,
                    ],
                    config=types.GenerateContentConfig(temperature=0.3),
                )

                text = response.text.strip()
                command, reason = self._parse_response(text)

                if command:
                    self.last_command = command
                    self.last_reason = reason
                    self.last_error = None
                    self._log(command, reason)
                    self._send_command(command)
                else:
                    self.last_error = f"Parse error: {text[:100]}"
                    self._log("error", self.last_error)

            except Exception as e:
                self.last_error = str(e)[:200]
                self._log("error", self.last_error)

            time.sleep(self.interval)

    def _parse_response(self, text: str):
        # Try JSON parse
        try:
            clean = text
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[-1]
            if clean.endswith("```"):
                clean = clean[:-3]
            clean = clean.strip()
            if clean.startswith("json"):
                clean = clean[4:].strip()

            data = json.loads(clean)
            cmd = data.get("command", "").lower().strip()
            reason = data.get("reason", "")
            if cmd in VALID_COMMANDS:
                return cmd, reason
        except (json.JSONDecodeError, AttributeError):
            pass

        # Fallback: keyword search
        text_lower = text.lower()
        for cmd in ["forward", "back", "left", "right", "stop"]:
            if cmd in text_lower:
                return cmd, text[:100]

        return None, None

    def _log(self, command: str, reason: str):
        self.decisions.append({
            "time": time.strftime("%H:%M:%S"),
            "command": command,
            "reason": reason,
        })
        if len(self.decisions) > self.max_log:
            self.decisions = self.decisions[-self.max_log:]

    def status(self) -> dict:
        return {
            "running": self.running,
            "interval": self.interval,
            "model": self.model,
            "mode": self.mode,
            "goal": self.goal,
            "last_command": self.last_command,
            "last_reason": self.last_reason,
            "last_error": self.last_error,
            "decisions": self.decisions[-10:],
            "genai_installed": genai is not None,
            "api_key_set": bool(os.environ.get("GEMINI_API_KEY")),
        }
