# Quno

A multiplayer Uno clone built with Node.js and Socket.IO. Players share a single game room, and the host can enable house rules.

## Getting Started

You'll need [Node.js](https://nodejs.org/) (which includes npm) installed.

1. Clone the repo and navigate into it
2. Install dependencies (this includes the test tooling):
    ```bash
    npm install
    ```
3. Start the server:
    ```bash
    node server.js
    ```
4. Open your browser to `http://localhost:3000`

Set the `PORT` environment variable to use a different port.

The prod server is https://quno.azurewebsites.net/. Changes that are merged into the `main` branch will automatically deploy there.

## How It Works

- The server holds all game state in memory and is the authority on the rules. Clients send actions (play a card, call Quno, and so on) and render whatever the server broadcasts back.
- The first person to join is the host. The host starts matches, deals hands, changes options, and can boot players. If the host leaves, the role passes to another connected player.
- Players who disconnect have a short grace period to reconnect and keep their seat. Late joiners wait for the next hand.
- Because state is in memory, restarting the server ends the current game.

## Admin Page

`/admin` is a control panel for whoever runs the server. It shows the game state and lets you intervene (boot players, adjust scores, force a turn, change options, and so on). It runs on its own Socket.IO namespace, so opening it doesn't count as a player.

Players' cards are hidden on the admin page by default, so an admin who is also playing has no advantage. A toggle shows or hides them, and each change is announced in the players' game log. The server only sends the hands while they are shown, and card removal is disabled while they're hidden.

It is protected by a password set in the `ADMIN_PASSWORD` environment variable. **If `ADMIN_PASSWORD` isn't set, the admin page is disabled** and the server logs a warning at startup.

### Running locally with an admin password

macOS / Linux (bash):
```bash
ADMIN_PASSWORD='choose-a-password' node server.js
```

Windows (PowerShell):
```powershell
$env:ADMIN_PASSWORD = 'choose-a-password'
node server.js
```

Windows (cmd):
```cmd
set ADMIN_PASSWORD=choose-a-password
node server.js
```

Then open `http://localhost:3000/admin` and sign in.

### Production (Azure)

Add an `ADMIN_PASSWORD` application setting to the App Service (in the Azure portal, under **Settings → Environment variables**) and let the app restart. Use a long, unique password, since the admin page can see every player's hand and remove players.

### Notes

- Repeated wrong passwords are rate limited per IP address.
- Never commit the password or put it in `web.config` or any other file in the repo.
- Use HTTPS anywhere public. Azure provides it by default.

## Project Structure

| File | Purpose |
|---|---|
| `server.js` | Server and socket event handling: joins, turns, game flow, the event log, and the admin namespace |
| `Gamelogic.js` | Pure game logic with no socket I/O: card attributes, deck creation, scoring, turn order, draw stats |
| `main.js` | Client-side logic: rendering, animations, socket event handlers |
| `style.css` | Styling |
| `index.html` | Game page |
| `admin.html` | Admin page (served at `/admin`) |
| `web.config` | Azure/IIS settings |

`Gamelogic.js` is the single source of truth for all pure game functions. `server.js` imports from it rather than duplicating logic.

### Game log

Everything in the game log goes through `logEvent(message, type, affects)` in `server.js`. `type` categorizes the entry, and `affects` names the players it concerns. Messages can include structured parts (such as `cardPart()` and `colorPart()`) so clients render them without parsing text. The admin page's event log consumes the same entries, so changes to event types need to be reflected in both `main.js` and `admin.html`.

## Running Tests

Tests cover the pure game logic in `Gamelogic.js`:

```bash
npx jest
```

If you're adding or changing logic in `Gamelogic.js`, add corresponding tests in `Gamelogic.test.js`. Functions in `server.js` that involve socket I/O are not unit tested here.