# DevOps Career Hub

A private, single-user career dashboard for job applications, recruiter follow-ups, and GitHub project visibility. The core app runs locally with Node.js and a persistent SQLite database; it has no runtime package dependencies.

## Run locally

Requirements: Node.js 22.13 or newer (Node 24 recommended).

1. Extract this folder.
2. Run `npm start` (or `node server.mjs`).
3. Open <http://127.0.0.1:3000>.

The application database is created at `data/career-hub.sqlite`. The three requested applications are inserted only when the database is first created and dates remain blank. Back up the `data/` directory to retain your records. The server binds to `127.0.0.1` by default and should not be exposed to a public network as-is.

## Desktop shortcuts (Windows and macOS)
​
These optional launcher scripts start the local server and open the dashboard in your browser. Keep the terminal window open while using the app; closing it stops the server. Make sure Node.js 22.13 or newer is installed first.
​
### Windows
​
1. In the project folder (the folder containing `server.mjs`), create a file named `start-career-hub.bat` with this content:
​
```bat
@echo off
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install Node.js, then try again.
  pause
  exit /b 1
)
start "DevOps Career Hub server" /D "%~dp0" cmd /k node server.mjs
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3000"
```
​
2. In File Explorer, right-click `start-career-hub.bat` and choose **Show more options → Send to → Desktop (create shortcut)**. Double-click the new desktop shortcut to launch the app.
3. To stop the app, close the server's Command Prompt window. If you already started the server manually, stop it before using the shortcut to avoid a port conflict.
​
### macOS
​
1. In the project folder (the folder containing `server.mjs`), create a file named `start-career-hub.command` with this content:
​
```zsh
#!/bin/zsh
cd "$(dirname "$0")" || exit 1
​
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required. Install Node.js, then try again."
  echo "Press Return to close this window."
  read _
  exit 1
fi
​
node server.mjs &
server_pid=$!
​
for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:3000 >/dev/null 2>&1; then
    open http://127.0.0.1:3000
    wait "$server_pid"
    exit $?
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  sleep 0.5
done
​
echo "The app did not respond at http://127.0.0.1:3000. Check the server output above."
wait "$server_pid"
```
​
2. In Terminal, make the script executable (replace the example path with your project folder):
​
```bash
cd "/path/to/DevOps Career Hub"
chmod +x start-career-hub.command
```
​
3. In Finder, right-click `start-career-hub.command`, choose **Make Alias**, then move the alias to your Desktop. Double-click the alias to launch the app. If macOS asks for confirmation the first time, choose **Open**.
4. To stop the app, close the Terminal window running the server. If the app is already running in another Terminal window, stop it there first to avoid a port conflict.
​

## What's included

- Dashboard cards, status distribution, recent applications, and upcoming reminders.
- Persistent application CRUD with nine Kanban statuses, drag-and-drop, searchable/filterable table, and CSV export.
- Follow-up dates and a contact-history log connected to each application.
- GitHub OAuth setup flow; encrypted access-token storage; repository listing and GitHub Projects v2 board/item read view.
- Responsive dark interface and local settings/privacy guidance.

## GitHub OAuth setup (optional)

1. Create a GitHub OAuth App in GitHub Developer settings. Set its callback URL to exactly `http://127.0.0.1:3000/auth/github/callback` (or the matching URL for your chosen `APP_URL`).
2. Copy `.env.example` to `.env` and fill in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
3. Generate an encryption key with `openssl rand -hex 32` and set it as `APP_ENCRYPTION_KEY`. Keep `.env` private; losing/changing the key makes the stored token unreadable.
4. Restart the server, open the GitHub Projects page, then choose **Connect GitHub securely**. Approve the requested scopes: `read:user`, `repo`, and `read:project`.
5. Select an existing Project v2 board and optionally filter items by repository. The app reads existing boards; it does not create or duplicate boards.

OAuth tokens are encrypted with AES-256-GCM in the local SQLite database and are not returned to the browser. The Projects and Settings pages provide a disconnect action that clears the local token and requests grant revocation from GitHub. Review the consent screen carefully: GitHub OAuth App's `repo` scope is broader than read-only and can include private-repository access; remove that scope from the code if you only need public repositories. Set `COOKIE_SECURE=1` only if the app is served over HTTPS. The app is intended for local, single-user use; it does not include multi-user account authentication, remote hosting hardening, database backups, or automatic background sync. GitHub data is fetched when you open or refresh the Projects page.

## Notes

- GitHub Projects v2 may return fields such as status, priority, and due dates only when those fields exist on the board. The dashboard displays available values and links issue/PR items to GitHub.
- CSV export uses UTF-8 and includes the application fields. Follow-up contact history is stored in SQLite; export individual logs from a future extension if required.
