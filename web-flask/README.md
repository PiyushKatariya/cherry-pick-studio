# web-flask — Python/Flask port (not built yet)

This folder is a placeholder for an optional **Python/Flask** version of
Cherry-Pick Studio (the "option 2" stack). It is **not implemented** because
Python is not installed on this machine.

## To enable it later

1. **Install Python 3** (3.10+ recommended) from <https://www.python.org/downloads/>.
   During install, tick **"Add python.exe to PATH"**.
2. Verify:
   ```bash
   python --version
   pip --version
   ```
3. Then ask to build the Flask port. The plan:
   - Reimplement the `core/` engine (`git.py`, `session.py`) in Python, mirroring
     `core/git.js` / `core/session.js` (same git commands, same state machine).
   - `app.py`: Flask + `flask-sock` (WebSocket) serving the **existing**
     `../frontend/` unchanged — the frontend's transport layer already speaks the
     same JSON protocol, so no UI changes are needed.
   - `requirements.txt`: `flask`, `flask-sock`.
   - Run with `python app.py` → same browser UI.

Until then, use the Node web server (`npm run web`) or the Electron desktop app
(`npm run desktop`) — both are fully functional and need no Python.
