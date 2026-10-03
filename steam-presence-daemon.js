#!/usr/bin/env node

"use strict";

const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".config", "steam-presence");
const TOKEN_FILE = path.join(CONFIG_DIR, "refresh-token");
const GAMES_FILE = path.join(CONFIG_DIR, "games.json");

const LOGON_ID = 424242;
const DEBUG = process.argv.includes("--debug");

const DEFAULT_CONFIG = {
    /*
     * Szybkie wykrywanie START/STOP whitelistowanych gier.
     */
    scanIntervalMs: 2500,

    /*
     * Pełne szukanie nieznanych programów Wine.
     * Nie wpływa na presence.
     */
    discoveryIntervalMs: 60000,

    /*
     * Gra musi istnieć tyle czasu przed publikacją.
     */
    stableForMs: 3000,

    /*
     * Ile czekamy po zniknięciu procesu,
     * zanim usuniemy presence.
     */
    missingGraceMs: 8000,

    games: [
        {
            name: "CONTROL Resonant",
            executables: [
                "CONTROLResonant.exe"
            ]
        }
    ]
};

const IGNORE_EXES = new Set([
    "services.exe",
    "winedevice.exe",
    "explorer.exe",
    "rpcss.exe",
    "plugplay.exe",
    "svchost.exe",
    "conhost.exe",
    "start.exe",
    "cmd.exe",
    "reg.exe",
    "rundll32.exe",
    "msiexec.exe",
    "wineboot.exe",
    "winemenubuilder.exe",
    "crashpad_handler.exe",
    "tabtip.exe",

    "steam.exe",
    "steamwebhelper.exe",
    "upc.exe",
    "uplaywebcore.exe",
    "ubisoftconnect.exe",
    "eadesktop.exe",
    "eabackgroundservice.exe",
    "epicgameslauncher.exe"
].map(x => x.toLowerCase()));

let config = DEFAULT_CONFIG;
let configMtime = 0;

/*
 * Prekompilowane mapowanie:
 *
 * exe -> wpisy games.json
 */
let gamesByExe = new Map();

/*
 * Możliwe wartości /proc/PID/comm dla whitelistowanych EXE.
 *
 * Linux potrafi przycinać comm do 15 znaków,
 * dlatego przechowujemy też taki wariant.
 */
let whitelistCommSet = new Set();

let currentGame = null;
let candidateGame = null;
let candidateSince = 0;
let missingSince = 0;

let loggedOn = false;
let shuttingDown = false;

/*
 * Żeby [NEW] nie spamował co minutę tym samym EXE.
 */
const discovered = new Set();

function log(...args) {
    console.log(
        `[${new Date().toLocaleString()}]`,
        ...args
    );
}

function debug(...args) {
    if (DEBUG) {
        log("[debug]", ...args);
    }
}

/*
 * ------------------------------------------------------------
 * CONFIG
 * ------------------------------------------------------------
 */

function ensureConfig() {
    fs.mkdirSync(CONFIG_DIR, {
        recursive: true,
        mode: 0o700
    });

    if (!fs.existsSync(GAMES_FILE)) {
        fs.writeFileSync(
            GAMES_FILE,
            JSON.stringify(DEFAULT_CONFIG, null, 4) + "\n",
            {
                mode: 0o600
            }
        );

        log(`Utworzono konfigurację: ${GAMES_FILE}`);
    }

    reloadConfig(true);
}

function buildGameIndex() {
    gamesByExe = new Map();
    whitelistCommSet = new Set();

    for (const game of config.games || []) {
        if (
            !game ||
            !game.name ||
            !Array.isArray(game.executables)
        ) {
            continue;
        }

        for (const exe of game.executables) {
            if (
                typeof exe !== "string" ||
                !exe.trim()
            ) {
                continue;
            }

            const exeLower =
                path.basename(exe).toLowerCase();

            if (!gamesByExe.has(exeLower)) {
                gamesByExe.set(
                    exeLower,
                    []
                );
            }

            gamesByExe
                .get(exeLower)
                .push(game);

            /*
             * Pełna nazwa.
             */
            whitelistCommSet.add(
                exeLower
            );

            /*
             * Typowe ograniczenie TASK_COMM_LEN:
             * 15 znaków danych + NUL.
             */
            whitelistCommSet.add(
                exeLower.slice(0, 15)
            );
        }
    }
}

function reloadConfig(force = false) {
    let stat;

    try {
        stat = fs.statSync(GAMES_FILE);
    } catch (err) {
        log(
            "Nie mogę odczytać games.json:",
            err.message
        );

        return false;
    }

    if (
        !force &&
        stat.mtimeMs === configMtime
    ) {
        return false;
    }

    /*
     * Zapamiętujemy mtime nawet przy błędnym JSON-ie,
     * żeby nie spamować tym samym błędem co 2.5 s.
     */
    configMtime =
        stat.mtimeMs;

    try {
        const parsed = JSON.parse(
            fs.readFileSync(
                GAMES_FILE,
                "utf8"
            )
        );

        if (!Array.isArray(parsed.games)) {
            throw new Error(
                '"games" musi być tablicą'
            );
        }

        config = {
            ...DEFAULT_CONFIG,
            ...parsed
        };

        buildGameIndex();

        log(
            `Wczytano games.json: ${config.games.length} wpisów`
        );

        debug(
            `Whitelist EXE: ${[...gamesByExe.keys()].join(", ") || "(pusta)"}`
        );

        return true;

    } catch (err) {
        log(
            "BŁĄD games.json — zostawiam poprzednią konfigurację:",
            err.message
        );

        return false;
    }
}

/*
 * ------------------------------------------------------------
 * STEAM TOKEN
 * ------------------------------------------------------------
 */

function loadRefreshToken() {
    if (!fs.existsSync(TOKEN_FILE)) {
        throw new Error(
            `Brak refresh tokena: ${TOKEN_FILE}`
        );
    }

    const token = fs
        .readFileSync(
            TOKEN_FILE,
            "utf8"
        )
        .trim();

    if (!token) {
        throw new Error(
            `Refresh token jest pusty: ${TOKEN_FILE}`
        );
    }

    return token;
}

function saveRefreshToken(token) {
    if (!token) {
        return;
    }

    fs.mkdirSync(CONFIG_DIR, {
        recursive: true,
        mode: 0o700
    });

    fs.writeFileSync(
        TOKEN_FILE,
        token.trim() + "\n",
        {
            mode: 0o600
        }
    );

    debug(
        "Zapisano odnowiony refresh token."
    );
}

/*
 * ------------------------------------------------------------
 * /proc HELPERS
 * ------------------------------------------------------------
 */

function parseEnvironment(buffer) {
    const result = {};

    for (const item of buffer.split("\0")) {
        if (!item) {
            continue;
        }

        const pos =
            item.indexOf("=");

        if (pos === -1) {
            continue;
        }

        result[
            item.slice(0, pos)
        ] =
            item.slice(pos + 1);
    }

    return result;
}

function readEnvironment(pid) {
    try {
        return parseEnvironment(
            fs.readFileSync(
                `/proc/${pid}/environ`,
                "utf8"
            )
        );
    } catch (_) {
        return {};
    }
}

function getBottleInfo(prefix) {
    if (!prefix) {
        return {
            prefix: null,
            bottle: null
        };
    }

    const normalized =
        prefix.replace(/\/+$/, "");

    return {
        prefix,
        bottle:
            path.basename(normalized)
    };
}

/*
 * /proc/PID/stat:
 *
 * field 22 = starttime
 *
 * Dzięki temu nie sprawdzamy tylko "czy PID istnieje".
 * Jeśli Linux kiedyś wykorzysta ten sam PID ponownie,
 * starttime będzie inne.
 */
function readProcStartTime(pid) {
    try {
        const stat = fs.readFileSync(
            `/proc/${pid}/stat`,
            "utf8"
        );

        /*
         * comm może zawierać spacje i nawiasy,
         * więc szukamy ostatniego ')'.
         */
        const closing =
            stat.lastIndexOf(")");

        if (closing === -1) {
            return null;
        }

        const rest =
            stat
                .slice(closing + 2)
                .trim()
                .split(/\s+/);

        /*
         * rest[0] = field 3 (state)
         * ...
         * rest[19] = field 22 (starttime)
         */
        return rest[19] || null;

    } catch (_) {
        return null;
    }
}

function isSameProcessAlive(game) {
    if (
        !game ||
        !game.pid ||
        !game.startTime
    ) {
        return false;
    }

    const nowStartTime =
        readProcStartTime(
            game.pid
        );

    return (
        nowStartTime !== null &&
        nowStartTime ===
            game.startTime
    );
}

function extractExeFromCmdline(cmdline) {
    const args =
        cmdline
            .split("\0")
            .filter(Boolean);

    for (const arg of args) {
        /*
         * C:\Games\Foo\foo.exe
         */
        const windowsMatch =
            arg.match(
                /([^\\/:]+\.exe)$/i
            );

        if (windowsMatch) {
            return windowsMatch[1];
        }

        /*
         * /foo/bar/foo.exe
         */
        if (/\.exe$/i.test(arg)) {
            return path.basename(arg);
        }
    }

    return null;
}

/*
 * ------------------------------------------------------------
 * WHITELIST FAST SCAN
 * ------------------------------------------------------------
 */

/*
 * Rozwiązuje konkretny EXE do wpisu games.json.
 *
 * WINEPREFIX czytamy tylko wtedy, kiedy jest naprawdę
 * potrzebny do rozstrzygnięcia warunku "bottle".
 */
function resolveWhitelistedGame(
    pid,
    exe,
    startTime
) {
    const exeLower =
        exe.toLowerCase();

    const candidates =
        gamesByExe.get(
            exeLower
        );

    if (
        !candidates ||
        candidates.length === 0
    ) {
        return null;
    }

    const needsBottle =
        candidates.some(
            game => Boolean(game.bottle)
        );

    let bottle = null;
    let prefix = null;

    if (needsBottle) {
        const env =
            readEnvironment(pid);

        const info =
            getBottleInfo(
                env.WINEPREFIX || null
            );

        bottle =
            info.bottle;

        prefix =
            info.prefix;
    }

    /*
     * Najpierw najbardziej konkretny wpis,
     * czyli z wymaganym Bottle.
     */
    if (bottle) {
        const bottleMatch =
            candidates.find(
                game =>
                    game.bottle &&
                    game.bottle.toLowerCase() ===
                        bottle.toLowerCase()
            );

        if (bottleMatch) {
            return {
                name:
                    bottleMatch.name,
                exe,
                pid,
                startTime,
                bottle,
                prefix
            };
        }
    }

    /*
     * Potem wpis bez ograniczenia Bottle.
     */
    const generic =
        candidates.find(
            game =>
                !game.bottle
        );

    if (!generic) {
        return null;
    }

    return {
        name:
            generic.name,
        exe,
        pid,
        startTime,
        bottle,
        prefix
    };
}

/*
 * Ten skan NIE robi discovery.
 *
 * Interesują nas wyłącznie EXE już wpisane
 * do games.json.
 */
function scanWhitelistedGames() {
    let entries;

    try {
        entries =
            fs.readdirSync(
                "/proc",
                {
                    withFileTypes: true
                }
            );

    } catch (err) {
        debug(
            "Nie udało się odczytać /proc:",
            err.message
        );

        return [];
    }

    const found = [];

    for (const entry of entries) {
        if (
            !entry.isDirectory() ||
            !/^\d+$/.test(entry.name)
        ) {
            continue;
        }

        const pid =
            Number(entry.name);

        const procDir =
            `/proc/${pid}`;

        try {
            /*
             * TANI ETAP:
             *
             * tylko comm.
             */
            const comm =
                fs.readFileSync(
                    `${procDir}/comm`,
                    "utf8"
                )
                .trim();

            const commLower =
                comm.toLowerCase();

            /*
             * Jeżeli nawet comm nie przypomina żadnego
             * whitelistowanego EXE, kończymy tutaj.
             *
             * Zero cmdline.
             * Zero environ.
             */
            if (
                !whitelistCommSet.has(
                    commLower
                )
            ) {
                continue;
            }

            /*
             * Dopiero teraz czytamy cmdline,
             * bo comm może być przycięte do 15 znaków.
             */
            const cmdline =
                fs.readFileSync(
                    `${procDir}/cmdline`,
                    "utf8"
                );

            let exe =
                extractExeFromCmdline(
                    cmdline
                );

            /*
             * Dla krótkiej nazwy comm może zawierać
             * kompletne foo.exe.
             */
            if (
                !exe &&
                /\.exe$/i.test(comm)
            ) {
                exe =
                    path.basename(comm);
            }

            if (!exe) {
                continue;
            }

            const exeLower =
                exe.toLowerCase();

            /*
             * Ostateczne sprawdzenie pełnej nazwy.
             */
            if (
                !gamesByExe.has(exeLower)
            ) {
                continue;
            }

            const startTime =
                readProcStartTime(pid);

            if (!startTime) {
                continue;
            }

            const game =
                resolveWhitelistedGame(
                    pid,
                    exe,
                    startTime
                );

            if (game) {
                found.push(game);
            }

        } catch (_) {
            /*
             * Proces mógł umrzeć w czasie skanu.
             */
        }
    }

    return found;
}

function sameGame(a, b) {
    if (!a || !b) {
        return false;
    }

    return (
        a.name === b.name &&
        a.exe.toLowerCase() ===
            b.exe.toLowerCase() &&
        (a.bottle || "") ===
            (b.bottle || "")
    );
}

function chooseGame(found) {
    if (
        !found ||
        found.length === 0
    ) {
        return null;
    }

    /*
     * Jeżeli ta sama gra już była aktywna
     * i tylko zmieniła PID, zachowujemy ją.
     */
    if (currentGame) {
        const same =
            found.find(
                game =>
                    sameGame(
                        game,
                        currentGame
                    )
            );

        if (same) {
            return same;
        }
    }

    /*
     * W przeciwnym wypadku najnowszy PID.
     */
    found.sort(
        (a, b) =>
            b.pid - a.pid
    );

    return found[0];
}

/*
 * ------------------------------------------------------------
 * DISCOVERY — TYLKO CO ~60 SEKUND
 * ------------------------------------------------------------
 */

function discoveryKey(proc) {
    return [
        proc.bottle || "?",
        proc.exe.toLowerCase()
    ].join("|");
}

function reportUnknown(proc) {
    const key =
        discoveryKey(proc);

    if (
        discovered.has(key)
    ) {
        return;
    }

    discovered.add(key);

    console.log("");

    log(
        "[NEW] Nieznany program Wine/Bottles"
    );

    console.log(
        `      EXE:    ${proc.exe}`
    );

    console.log(
        `      PID:    ${proc.pid}`
    );

    console.log(
        `      Bottle: ${proc.bottle || "(nieznana)"}`
    );

    console.log(
        `      Prefix: ${proc.prefix || "(brak WINEPREFIX)"}`
    );

    console.log(
        "      Steam:  IGNOROWANY"
    );

    console.log("");
    console.log(
        "      Przykładowy wpis do games.json:"
    );

    const suggestion = {
        name:
            proc.exe.replace(
                /\.exe$/i,
                ""
            ),

        executables: [
            proc.exe
        ]
    };

    if (proc.bottle) {
        suggestion.bottle =
            proc.bottle;
    }

    console.log(
        JSON.stringify(
            suggestion,
            null,
            4
        )
            .split("\n")
            .map(
                line =>
                    "      " + line
            )
            .join("\n")
    );

    console.log("");
}

/*
 * Pełny discovery scan jest celowo droższy,
 * ale wykonuje się tylko co discoveryIntervalMs.
 */
function scanUnknownWinePrograms() {
    if (
        !loggedOn ||
        shuttingDown
    ) {
        return;
    }

    let entries;

    try {
        entries =
            fs.readdirSync(
                "/proc",
                {
                    withFileTypes: true
                }
            );
    } catch (_) {
        return;
    }

    debug(
        "Discovery scan..."
    );

    for (const entry of entries) {
        if (
            !entry.isDirectory() ||
            !/^\d+$/.test(entry.name)
        ) {
            continue;
        }

        const pid =
            Number(entry.name);

        const procDir =
            `/proc/${pid}`;

        try {
            const comm =
                fs.readFileSync(
                    `${procDir}/comm`,
                    "utf8"
                )
                .trim();

            /*
             * Jeżeli comm daje pełne *.exe,
             * nie potrzebujemy cmdline do nazwy.
             */
            let exe =
                /\.exe$/i.test(comm)
                    ? path.basename(comm)
                    : null;

            let cmdline = null;

            /*
             * Długie Windows EXE mogą mieć comm
             * ucięte, więc w discovery sprawdzamy
             * też cmdline.
             *
             * To jest droga operacja, ale tylko raz/min.
             */
            if (!exe) {
                cmdline =
                    fs.readFileSync(
                        `${procDir}/cmdline`,
                        "utf8"
                    );

                exe =
                    extractExeFromCmdline(
                        cmdline
                    );
            }

            if (!exe) {
                continue;
            }

            const exeLower =
                exe.toLowerCase();

            if (
                IGNORE_EXES.has(
                    exeLower
                )
            ) {
                continue;
            }

            /*
             * Dopiero dla Windows EXE czytamy environ.
             */
            const env =
                readEnvironment(pid);

            const prefix =
                env.WINEPREFIX || null;

            /*
             * Jeśli nie ma WINEPREFIX, wymagamy przynajmniej
             * śladu Wine/Bottles w cmdline.
             */
            if (!prefix) {
                if (cmdline === null) {
                    try {
                        cmdline =
                            fs.readFileSync(
                                `${procDir}/cmdline`,
                                "utf8"
                            );
                    } catch (_) {
                        cmdline = "";
                    }
                }

                const combined =
                    `${comm}\0${cmdline}`
                        .toLowerCase();

                if (
                    !combined.includes("wine") &&
                    !combined.includes("bottles")
                ) {
                    continue;
                }
            }

            const bottleInfo =
                getBottleInfo(prefix);

            /*
             * Jeśli proces pasuje do whitelisty,
             * nie jest [NEW].
             *
             * Przy wpisach z bottle sprawdzamy również Bottle.
             */
            if (
                gamesByExe.has(exeLower)
            ) {
                const mapped =
                    resolveWhitelistedGame(
                        pid,
                        exe,
                        readProcStartTime(pid)
                    );

                if (mapped) {
                    continue;
                }
            }

            reportUnknown({
                exe,
                pid,
                prefix:
                    bottleInfo.prefix,
                bottle:
                    bottleInfo.bottle
            });

        } catch (_) {
            /*
             * Proces zniknął podczas discovery.
             */
        }
    }
}

/*
 * ------------------------------------------------------------
 * STEAM PRESENCE
 * ------------------------------------------------------------
 */

function setSteamGame(game) {
    if (!loggedOn) {
        return;
    }

    if (!game) {
        if (currentGame) {
            log(
                `OFFLINE GAME <- "${currentGame.name}"`
            );
        }

        client.gamesPlayed([]);

        currentGame = null;
        candidateGame = null;
        candidateSince = 0;
        missingSince = 0;

        return;
    }

    if (
        currentGame &&
        sameGame(
            currentGame,
            game
        )
    ) {
        /*
         * Może być nowy PID po restarcie EXE.
         */
        currentGame = {
            ...game
        };

        return;
    }

    /*
     * STRING = non-Steam presence.
     */
    client.gamesPlayed(
        game.name
    );

    currentGame = {
        ...game
    };

    log(
        `IN-GAME -> "${game.name}"`,
        `[${game.exe}, PID ${game.pid}]`,
        game.bottle
            ? `[Bottle: ${game.bottle}]`
            : ""
    );
}

/*
 * Czy obecna gra wciąż w ogóle istnieje
 * w konfiguracji po hot-reloadzie?
 */
function currentGameStillConfigured() {
    if (!currentGame) {
        return false;
    }

    return gamesByExe.has(
        currentGame.exe.toLowerCase()
    );
}

/*
 * ------------------------------------------------------------
 * FAST TICK
 * ------------------------------------------------------------
 */

function fastScan() {
    if (
        !loggedOn ||
        shuttingDown
    ) {
        return;
    }

    const configChanged =
        reloadConfig();

    /*
     * Jeżeli usunięto aktualną grę z whitelisty,
     * przestajemy ją publikować.
     */
    if (
        configChanged &&
        currentGame &&
        !currentGameStillConfigured()
    ) {
        log(
            `"${currentGame.name}" usunięto z whitelisty.`
        );

        setSteamGame(null);
    }

    /*
     * NAJWAŻNIEJSZA OPTYMALIZACJA:
     *
     * Jeśli aktualna gra nadal jest dokładnie tym samym
     * procesem (PID + starttime), nie skanujemy /proc.
     *
     * Jeden odczyt /proc/PID/stat i koniec.
     */
    if (
        currentGame &&
        isSameProcessAlive(
            currentGame
        )
    ) {
        missingSince = 0;

        debug(
            `ACTIVE "${currentGame.name}" PID ${currentGame.pid} — fast path`
        );

        return;
    }

    /*
     * Tutaj trafiamy tylko:
     *
     * - gdy żadna gra nie działa,
     * - albo gdy aktywny PID właśnie zniknął.
     */
    const found =
        scanWhitelistedGames();

    if (DEBUG) {
        if (found.length) {
            debug(
                "Whitelist scan:",
                found
                    .map(
                        game =>
                            `${game.name}<-${game.exe}[${game.pid}]`
                    )
                    .join(", ")
            );
        } else {
            debug(
                "Whitelist scan: brak gry"
            );
        }
    }

    const game =
        chooseGame(found);

    const now =
        Date.now();

    /*
     * Znaleźliśmy whitelistowaną grę.
     */
    if (game) {
        missingSince = 0;

        /*
         * Ta sama gra mogła tylko zrestartować EXE
         * i dostać nowy PID.
         *
         * Presence nie musi być wysyłane ponownie.
         */
        if (
            currentGame &&
            sameGame(
                currentGame,
                game
            )
        ) {
            debug(
                `"${game.name}" dostało nowy PID: ` +
                `${currentGame.pid} -> ${game.pid}`
            );

            currentGame = {
                ...game
            };

            candidateGame = null;
            candidateSince = 0;

            return;
        }

        /*
         * Pierwsze wykrycie nowej gry.
         */
        if (
            !candidateGame ||
            !sameGame(
                candidateGame,
                game
            )
        ) {
            candidateGame = {
                ...game
            };

            candidateSince =
                now;

            debug(
                `Nowy kandydat "${game.name}", ` +
                `czekam ${config.stableForMs} ms`
            );

            return;
        }

        /*
         * Kandydat przeżył stableForMs.
         */
        if (
            now - candidateSince >=
            config.stableForMs
        ) {
            setSteamGame(game);

            candidateGame = null;
            candidateSince = 0;
        }

        return;
    }

    /*
     * Nie znaleziono żadnej whitelistowanej gry.
     */
    candidateGame = null;
    candidateSince = 0;

    if (!currentGame) {
        return;
    }

    /*
     * Aktywny PID zniknął.
     *
     * Zaczynamy grace period.
     */
    if (!missingSince) {
        missingSince =
            now;

        debug(
            `"${currentGame.name}" zniknęło; ` +
            `grace ${config.missingGraceMs} ms`
        );

        return;
    }

    if (
        now - missingSince >=
        config.missingGraceMs
    ) {
        setSteamGame(null);
    }
}

/*
 * ------------------------------------------------------------
 * DYNAMIC TIMERS
 * ------------------------------------------------------------
 *
 * setTimeout zamiast setInterval.
 *
 * Dzięki temu zmiana scanIntervalMs w games.json
 * zaczyna działać bez restartowania usługi.
 */

function scheduleFastScan() {
    if (shuttingDown) {
        return;
    }

    const delay =
        Math.max(
            500,
            Number(
                config.scanIntervalMs
            ) || 2500
        );

    setTimeout(
        () => {
            try {
                fastScan();
            } catch (err) {
                log(
                    "Fast scan error:",
                    err.stack || err
                );
            }

            scheduleFastScan();
        },
        delay
    );
}

function scheduleDiscovery() {
    if (shuttingDown) {
        return;
    }

    const delay =
        Math.max(
            10000,
            Number(
                config.discoveryIntervalMs
            ) || 60000
        );

    setTimeout(
        () => {
            try {
                scanUnknownWinePrograms();
            } catch (err) {
                log(
                    "Discovery error:",
                    err.stack || err
                );
            }

            scheduleDiscovery();
        },
        delay
    );
}

/*
 * ------------------------------------------------------------
 * STEAM
 * ------------------------------------------------------------
 */

ensureConfig();

const refreshToken =
    loadRefreshToken();

const client =
    new SteamUser({
        autoRelogin: true,
        renewRefreshTokens: true
    });

client.on(
    "refreshToken",
    token => {
        saveRefreshToken(token);
    }
);

client.on(
    "loggedOn",
    () => {
        loggedOn = true;

        log(
            "Steam zalogowany.",
            `SteamID: ${client.steamID}`
        );

        client.setPersona(
            SteamUser.EPersonaState.Online
        );

        /*
         * Czyścimy presence tej konkretnej sesji.
         */
        client.gamesPlayed([]);

        /*
         * Po reconnect wymuszamy ponowne wykrycie,
         * bo Steam dostał właśnie gamesPlayed([]).
         */
        currentGame = null;
        candidateGame = null;
        candidateSince = 0;
        missingSince = 0;

        /*
         * Nie czekamy 2.5 s po zalogowaniu.
         */
        setTimeout(
            () => {
                try {
                    fastScan();
                } catch (err) {
                    log(
                        "Initial scan error:",
                        err.stack || err
                    );
                }
            },
            500
        );
    }
);

client.on(
    "disconnected",
    (eresult, msg) => {
        loggedOn = false;

        log(
            "Steam rozłączony:",
            eresult,
            msg || ""
        );
    }
);

client.on(
    "error",
    err => {
        log(
            "Steam error:",
            err.message || err
        );
    }
);

client.on(
    "playingState",
    state => {
        debug(
            "Steam playingState:",
            state
        );
    }
);

/*
 * ------------------------------------------------------------
 * SHUTDOWN
 * ------------------------------------------------------------
 */

function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    log(
        `${signal}: zatrzymuję daemon...`
    );

    try {
        if (loggedOn) {
            client.gamesPlayed([]);
        }
    } catch (_) {}

    setTimeout(
        () => {
            try {
                client.logOff();
            } catch (_) {}

            setTimeout(
                () => {
                    process.exit(0);
                },
                500
            );
        },
        500
    );
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

/*
 * ------------------------------------------------------------
 * START
 * ------------------------------------------------------------
 */

client.logOn({
    refreshToken,
    logonID: LOGON_ID,
    machineName: "wine-presence-daemon"
});

scheduleFastScan();
scheduleDiscovery();

log(
    "Steam Wine/Bottles Presence Daemon uruchomiony."
);

log(
    "Tryb: WHITELIST ONLY — nieznane EXE nigdy nie są publikowane."
);

log(
    `Fast scan: ${config.scanIntervalMs} ms`
);

log(
    `Discovery: ${config.discoveryIntervalMs} ms`
);

log(
    `Config: ${GAMES_FILE}`
);
