# DevOps Career Hub

A private, single-user career dashboard for job applications, recruiter follow-ups, and GitHub project visibility. The core app runs locally with Node.js and a persistent SQLite database; it has no runtime package dependencies.

## Run locally

Requirements: Node.js 22.13 or newer (Node 24 recommended).

1. Extract this folder.
2. Run `npm start` (or `node server.mjs`).
3. Open <http://127.0.0.1:3000>.

The application database is created at `data/career-hub.sqlite`. The three requested applications are inserted only when the database is first created and dates remain blank. Back up the `data/` directory to retain your records. The server binds to `127.0.0.1` by default and should not be exposed to a public network as-is.

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
