===========================================================================
 Cherry-Pick Studio
 Automate cherry-picking commits into a client branch.
===========================================================================

HOW TO RUN

  Run Desktop.bat            Opens the app in its own window.
  Run Web (browser).bat      Opens the app in your default web browser.

  Both do the same job - pick whichever you prefer. You can also
  double-click "Cherry-Pick Studio.exe" directly for the desktop window.

  Keep the .bat files in the same folder as the .exe. They find the .exe
  next to themselves, so moving one on its own will stop it working.


WHAT YOU NEED INSTALLED

  Node.js       NOT needed. It is built into this app.

  Git           REQUIRED. This tool drives the real "git" command, so it
                cannot work without it. If it is missing, the app will
                tell you so at startup instead of failing later.

                Install Git for Windows from:
                    https://git-scm.com/download/win
                Accept the default options, then start this tool again.


ABOUT WEB MODE

  "Run Web (browser).bat" starts a small local server and opens your
  browser at it. A little status window appears showing the address.

      CLOSE THAT WINDOW TO STOP THE SERVER.

  The server is reachable only from this computer (127.0.0.1). Other
  machines on your network cannot connect to it - that is deliberate,
  because the tool runs git commands against folders on this PC.

  Note: the desktop window and a browser tab are SEPARATE sessions, not
  two views of the same one. Use one at a time for a given repository.


WHERE YOUR DATA IS KEPT

  Logs and your saved repository list live in your user profile, not in
  this folder, so replacing this folder with a newer version keeps them:

      %APPDATA%\cherry-pick-studio\data\logs
      %APPDATA%\cherry-pick-studio\data\config\repos.json

  Paste %APPDATA%\cherry-pick-studio\data into Explorer's address bar to open
  it. (The other folders alongside "data" are the app's internal browser cache -
  leave them alone.)


FIRST-RUN WARNING FROM WINDOWS

  This app is not code-signed, so Windows SmartScreen may show
  "Windows protected your PC" the first time you run it. Choose
  "More info", then "Run anyway".

  Some corporate antivirus tools may also quarantine it. If that happens,
  ask your IT team to allow the folder.


===========================================================================
