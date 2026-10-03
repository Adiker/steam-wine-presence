# Steam Wine Presence

A lightweight Linux daemon that detects configured Windows game processes running under Wine or Bottles and shows their names as **non-Steam game presence** on Steam.

The project uses [`steam-user`](https://github.com/DoctorMcKay/node-steam-user) to connect to the Steam network and report the active game, and [`steam-session`](https://github.com/DoctorMcKay/node-steam-session) for the interactive first-time login helper. Games do not need to be added as shortcuts in the desktop Steam client. The daemon reports a custom game name; it does not provide Steam achievements, overlay integration, or store-app playtime tracking.

## Features

- Case-insensitive matching of executable names from a game allowlist.
- Multiple executable names per game, including long names truncated in Linux process names.
- Optional matching by Wine prefix directory name, useful for separate Bottles environments.
- A stability delay before publishing a game and a grace period before clearing it.
- A fast path that checks the active process's PID and start time without rescanning all processes.
- Automatic configuration reload and adjustable scan intervals.
- Periodic discovery of unknown Wine programs, with suggested configuration entries. Unknown programs are **never published** to Steam.
- Automatic Steam reconnection and refresh-token renewal through `steam-user`.
- Interactive first-time login with a masked password and preferred Steam mobile app confirmation.
- Presence cleanup on Ctrl+C or SIGTERM.
- An example systemd user service.

## Requirements

- Linux with readable `/proc` process metadata.
- Node.js 22 or newer and npm. Use a supported Node.js release.
- Wine or Bottles and a game with an identifiable `.exe` process name.
- Your own Steam account and internet access. The included login helper creates a refresh token valid for **Steam client login**.
- An interactive terminal for first-time login, and access to your account's Steam Guard authentication method. Confirmation in the Steam mobile app is preferred.
- systemd only if you want to use the optional user service.

Run the daemon as the same user who runs the games. Process isolation or restrictions on `/proc` can prevent detection, especially reading `WINEPREFIX` for bottle matching. The daemon does not require root.

## Installation

Clone into your home directory to match the example service:

```bash
git clone https://github.com/Adiker/steam-wine-presence.git "$HOME/steam-wine-presence"
cd "$HOME/steam-wine-presence"
npm ci --omit=dev
npm run check
```

The committed lockfile provides reproducible dependency installation. `private: true` in `package.json` prevents accidental npm publication; the GitHub repository is public.

## Configuration

The daemon always reads these files relative to the current user's home directory:

```text
~/.config/steam-presence/
├── games.json
└── refresh-token
```

There is currently no configuration-path flag or `XDG_CONFIG_HOME` override. Configuration files in the repository root are not used.

### 1. Create the game configuration

From the cloned repository:

```bash
install -d -m 700 "$HOME/.config/steam-presence"
```

For a fresh installation, copy the example:

```bash
install -m 600 examples/games.json "$HOME/.config/steam-presence/games.json"
```

If you already use the daemon, keep your existing configuration and edit it instead of replacing it. Replace the fictional game names and executables in the example with your games:

```json
{
  "scanIntervalMs": 2500,
  "discoveryIntervalMs": 60000,
  "stableForMs": 3000,
  "missingGraceMs": 8000,
  "games": [
    {
      "name": "Example Adventure",
      "executables": ["Adventure.exe", "Adventure-Win64-Shipping.exe"]
    },
    {
      "name": "Example Racing",
      "executables": ["Racing.exe"],
      "bottle": "RacingBottle"
    }
  ]
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `scanIntervalMs` | `2500` | Delay between game scans, in milliseconds; minimum effective delay is 500 ms. |
| `discoveryIntervalMs` | `60000` | Delay between discovery scans; minimum effective delay is 10,000 ms. |
| `stableForMs` | `3000` | How long a detected game must remain a candidate before publication. |
| `missingGraceMs` | `8000` | How long the game must remain absent before presence is cleared. |
| `games` | Built-in sample entry | Array of allowed games. Use `[]` to publish no games. |

Use positive numeric values for intervals and non-negative values for the two delays. Timing follows the scan cadence, so a 3-second stability delay may take longer than 3 seconds to appear on Steam.

Each game has a display `name` and an `executables` array of executable basenames, not installation paths. The optional `bottle` matches the last directory component of the process's `WINEPREFIX`, case-insensitively. A bottle-specific entry takes precedence over a generic entry for the same executable. If `WINEPREFIX` cannot be read, only generic entries can match.

Save `games.json` to apply changes without restarting. Invalid JSON or a missing `games` array leaves the previous configuration active. Removing an active executable from the allowlist clears its presence on the next scan. Restart after changing only the name or bottle restriction of an already active game to ensure immediate application.

If `games.json` does not exist, the daemon creates its original built-in sample configuration. The example above is the recommended starting point. `fallbackUnknownExe` is not a supported option; unknown executables remain discovery-only.

### 2. First-time Steam login

Run the included helper manually in an interactive terminal, before starting the daemon or enabling its systemd service:

```bash
cd "$HOME/steam-wine-presence"
npm run login
# Equivalent: node steam-login.js
```

1. Enter your Steam **account login name**, not your profile display name.
2. Enter your Steam password. The terminal shows asterisks instead of the password; the password itself is never displayed or written to disk by the script.
3. Open the Steam app on your phone and approve the login request when prompted.
4. Wait for the success message confirming that the refresh token was saved locally.

**`DeviceConfirmation` in the Steam mobile app is the preferred flow.** If Steam offers both mobile approval and a Steam Guard code, the helper waits for mobile approval and does not ask for a code. The approval timeout is three minutes. If mobile confirmation is unavailable, the helper follows the method offered by Steam: an app code, email confirmation, or an email code. Accounts without an additional Steam Guard requirement can complete login directly.

The helper uses `steam-session` with `EAuthTokenPlatformType.SteamClient` to obtain a token suitable for the daemon. It automatically writes the refresh token to:

```text
~/.config/steam-presence/refresh-token
```

The configuration directory has permissions **`0700`**, and the token file has permissions **`0600`** (read/write for its owner only). The helper explicitly applies these permissions even when the directory or file already exists. No manual token copying is needed. You can verify the file's permissions without displaying its contents:

```bash
stat -c '%a %n' "$HOME/.config/steam-presence/refresh-token"
```

**Neither the password nor the token is stored in the repository or displayed by the login script.** The password is used in memory for authentication; the refresh token is stored only in the local file above. The login helper does display the account's SteamID and the local token-file path in its success message, so remove these details before sharing output.

After this one-time login, `npm start` reads the saved refresh token and connects without prompting for your password or requiring the login helper at each startup. Through `steam-user`, the daemon can renew the refresh token later and save the replacement back to the same local file. If the token expires or is revoked, perform the interactive login again as described under Troubleshooting.

Keep the token outside the repository and treat it as a credential. Never include it in screenshots, issues, or logs. See the [`steam-user` refresh-token documentation](https://github.com/DoctorMcKay/node-steam-user#using-refresh-tokens) for background.

## Run in a terminal

```bash
cd "$HOME/steam-wine-presence"
npm start
```

For detailed scanning output:

```bash
npm run debug
# Equivalent: node steam-presence-daemon.js --debug
```

Launch a configured game through Wine or Bottles. After the stability delay, Steam should show its configured name. Close the game to clear presence after the grace period. Press Ctrl+C to stop the daemon cleanly.

The original runtime messages, including the login prompts, are mostly in Polish. Useful daemon markers include `IN-GAME`, `OFFLINE GAME`, `[NEW]`, and `[debug]`. A `[NEW]` entry includes an executable name and a suggested game mapping; add the mapping to `games.json` if you want that game published.

The daemon sets your Steam persona to Online on login and uses its own client session. It reports one game at a time and retains the active game while its process stays alive. Avoid running multiple daemon instances or another presence publisher for the same account. To move an existing installation, stop its previous service before starting this one.

## Run as a systemd user service

The example expects the checkout at `~/steam-wine-presence` and Node.js at `/usr/bin/node`. Check `command -v node` first. If your checkout or Node.js location differs, edit the copied unit's `WorkingDirectory` and `ExecStart`. systemd does not load shell initialization files for tools such as nvm.

The service runs **only `steam-presence-daemon.js`**. It does not run `steam-login.js` or prompt for credentials. Complete `npm run login` manually in a terminal first, then install and enable the service:

```bash
install -d -m 700 "$HOME/.config/systemd/user"
install -m 644 examples/systemd/steam-wine-presence.service \
  "$HOME/.config/systemd/user/steam-wine-presence.service"
systemctl --user daemon-reload
systemctl --user enable --now steam-wine-presence.service
```

Inspect status and logs:

```bash
systemctl --user status steam-wine-presence.service
journalctl --user -u steam-wine-presence.service -f
```

Stop or disable the service:

```bash
systemctl --user stop steam-wine-presence.service
systemctl --user disable steam-wine-presence.service
```

This is a user service and normally starts with your user session. The example restarts on failure; missing credentials must be fixed before it can run successfully.

## Troubleshooting and privacy

- **Missing or empty refresh token:** run `npm run login` manually and finish Steam authentication before starting the daemon. A missing token prevents startup; the service may keep restarting until it is created.
- **Expired, revoked, or rejected token:** stop the daemon (Ctrl+C, or `systemctl --user stop steam-wine-presence.service`), run `npm run login` again, and approve the new login in Steam. The helper replaces the local token file. Then run `npm start`, or `systemctl --user start steam-wine-presence.service` if you use the service. Do not run both simultaneously.
- **Login approval timeout:** rerun `npm run login` and approve the request in the Steam mobile app within three minutes. Enter a Steam Guard code only when the helper requests one.
- **Interactive terminal required:** run `npm run login` in a real terminal, not through systemd or with piped credentials.
- **Other Steam login errors:** check the account login name, password, Steam Guard approval, and connectivity. Reauthenticate with `npm run login` if the existing token no longer works.
- **Game not detected:** run in debug mode, verify executable basenames, and check that the process is visible in `/proc`. For bottle-specific entries, verify the final `WINEPREFIX` directory name.
- **Unknown game appears only in logs:** this is expected until you add it to the allowlist. Discovery runs separately, about once a minute by default.
- **Service cannot start Node.js:** update `ExecStart` to your actual Node.js executable and reload the user units.
- **Sharing diagnostic output:** remove SteamID, account details, local paths, bottle names, and credentials first. Login output and daemon logs include the logged-in SteamID; discovery logs may include private Wine prefix paths. Do not commit logs or personal configurations.

The repository contains source code and fictional examples only. `.gitignore` excludes common credentials, logs, dependencies, and local configuration files. It does not replace reviewing staged files before publishing.

## Repository layout

```text
steam-wine-presence/
├── steam-presence-daemon.js       # Original daemon, unchanged
├── steam-login.js                 # Interactive first-time Steam login
├── package.json
├── package-lock.json
├── examples/
│   ├── games.json                 # Fictional game mappings
│   └── systemd/
│       └── steam-wine-presence.service
├── .gitignore
├── LICENSE
└── README.md
```

## License and acknowledgements

MIT. See [LICENSE](LICENSE).

Steam connectivity is provided by [`steam-user`](https://github.com/DoctorMcKay/node-steam-user), and first-time authentication by [`steam-session`](https://github.com/DoctorMcKay/node-steam-session), maintained by DoctorMcKay and contributors. Dependencies retain their own licenses. Steam is a trademark of Valve Corporation; this project is independent and is not affiliated with or endorsed by Valve.
