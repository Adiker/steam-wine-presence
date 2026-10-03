#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("node:readline/promises");

const {
    LoginSession,
    EAuthTokenPlatformType,
    EAuthSessionGuardType
} = require("steam-session");

const CONFIG_DIR = path.join(
    os.homedir(),
    ".config",
    "steam-presence"
);

const TOKEN_FILE = path.join(
    CONFIG_DIR,
    "refresh-token"
);

/*
 * ------------------------------------------------------------
 * INPUT
 * ------------------------------------------------------------
 */

async function askText(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        return (
            await rl.question(question)
        ).trim();
    } finally {
        rl.close();
    }
}

/*
 * Hasło bez wyświetlania go w terminalu.
 * Nie potrzebujemy żadnej dodatkowej paczki npm.
 */
function askHidden(question) {
    return new Promise(
        (resolve, reject) => {
            if (!process.stdin.isTTY) {
                reject(
                    new Error(
                        "Hasło musi zostać podane w interaktywnym terminalu."
                    )
                );

                return;
            }

            const stdin =
                process.stdin;

            const oldRawMode =
                stdin.isRaw;

            let value = "";

            process.stdout.write(
                question
            );

            function cleanup() {
                stdin.off(
                    "data",
                    onData
                );

                stdin.setRawMode(
                    Boolean(oldRawMode)
                );

                stdin.pause();

                process.stdout.write(
                    "\n"
                );
            }

            function onData(buffer) {
                const input =
                    buffer.toString("utf8");

                for (const char of input) {
                    /*
                     * Enter
                     */
                    if (
                        char === "\r" ||
                        char === "\n"
                    ) {
                        cleanup();

                        resolve(value);

                        return;
                    }

                    /*
                     * Ctrl+C
                     */
                    if (char === "\u0003") {
                        cleanup();

                        reject(
                            new Error(
                                "Przerwano logowanie."
                            )
                        );

                        return;
                    }

                    /*
                     * Backspace
                     */
                    if (
                        char === "\u007f" ||
                        char === "\b"
                    ) {
                        if (value.length > 0) {
                            value =
                                value.slice(
                                    0,
                                    -1
                                );

                            process.stdout.write(
                                "\b \b"
                            );
                        }

                        continue;
                    }

                    value += char;

                    process.stdout.write(
                        "*"
                    );
                }
            }

            stdin.setRawMode(true);
            stdin.resume();

            stdin.on(
                "data",
                onData
            );
        }
    );
}

/*
 * ------------------------------------------------------------
 * TOKEN
 * ------------------------------------------------------------
 */

function saveToken(token) {
    if (!token) {
        throw new Error(
            "Steam nie zwrócił refresh tokena."
        );
    }

    fs.mkdirSync(
        CONFIG_DIR,
        {
            recursive: true,
            mode: 0o700
        }
    );

    /*
     * mkdir mode nie zmienia istniejącego katalogu,
     * więc ustawiamy prawa również jawnie.
     */
    fs.chmodSync(
        CONFIG_DIR,
        0o700
    );

    fs.writeFileSync(
        TOKEN_FILE,
        token.trim() + "\n",
        {
            mode: 0o600
        }
    );

    fs.chmodSync(
        TOKEN_FILE,
        0o600
    );
}

/*
 * ------------------------------------------------------------
 * LOGIN
 * ------------------------------------------------------------
 */

async function main() {
    console.log(
        "Steam Wine Presence - pierwsze logowanie\n"
    );

    const accountName =
        await askText(
            "Login Steam: "
        );

    if (!accountName) {
        throw new Error(
            "Login nie może być pusty."
        );
    }

    const password =
        await askHidden(
            "Hasło Steam: "
        );

    if (!password) {
        throw new Error(
            "Hasło nie może być puste."
        );
    }

    console.log(
        "\nRozpoczynam logowanie do Steam..."
    );

    /*
     * SteamClient jest ważny:
     * chcemy refresh token nadający się do późniejszego
     * logowania przez steam-user.
     */
    const session =
        new LoginSession(
            EAuthTokenPlatformType.SteamClient
        );

    /*
     * Dajemy 3 minuty na kliknięcie Approve
     * w aplikacji Steam.
     */
    session.loginTimeout =
        180000;

    let authResolve;
    let authReject;
    let authFinished = false;

    const authenticated =
        new Promise(
            (resolve, reject) => {
                authResolve =
                    resolve;

                authReject =
                    reject;
            }
        );

    function finishSuccess() {
        if (authFinished) {
            return;
        }

        authFinished = true;

        authResolve();
    }

    function finishError(err) {
        if (authFinished) {
            return;
        }

        authFinished = true;

        authReject(err);
    }

    /*
     * Polling jest uruchamiany automatycznie,
     * m.in. przy DeviceConfirmation.
     */
    session.on(
        "polling",
        () => {
            console.log(
                "Czekam na autoryzację Steam..."
            );
        }
    );

    /*
     * To zwykle pojawia się, gdy użytkownik
     * otworzy prompt logowania w aplikacji Steam.
     */
    session.on(
        "remoteInteraction",
        () => {
            console.log(
                "Żądanie zostało otwarte w aplikacji Steam."
            );

            console.log(
                "Kliknij Approve / Zatwierdź."
            );
        }
    );

    session.on(
        "authenticated",
        () => {
            try {
                saveToken(
                    session.refreshToken
                );

                console.log(
                    "\n✓ Logowanie zakończone pomyślnie."
                );

                console.log(
                    `SteamID: ${session.steamID}`
                );

                console.log(
                    `Refresh token zapisany w:`
                );

                console.log(
                    TOKEN_FILE
                );

                console.log(
                    "\nToken nie został wyświetlony w terminalu."
                );

                finishSuccess();

            } catch (err) {
                finishError(err);
            }
        }
    );

    session.on(
        "timeout",
        () => {
            finishError(
                new Error(
                    "Przekroczono czas oczekiwania na autoryzację Steam."
                )
            );
        }
    );

    /*
     * steam-session wymaga obsługi error,
     * inaczej taki event może zakończyć Node.
     */
    session.on(
        "error",
        err => {
            finishError(err);
        }
    );

    const result =
        await session.startWithCredentials({
            accountName,
            password
        });

    /*
     * --------------------------------------------------------
     * STEAM GUARD
     * --------------------------------------------------------
     */

    if (result.actionRequired) {
        const actions =
            result.validActions || [];

        const hasDeviceConfirmation =
            actions.some(
                action =>
                    action.type ===
                    EAuthSessionGuardType.DeviceConfirmation
            );

        const hasDeviceCode =
            actions.some(
                action =>
                    action.type ===
                    EAuthSessionGuardType.DeviceCode
            );

        const hasEmailConfirmation =
            actions.some(
                action =>
                    action.type ===
                    EAuthSessionGuardType.EmailConfirmation
            );

        const emailCodeAction =
            actions.find(
                action =>
                    action.type ===
                    EAuthSessionGuardType.EmailCode
            );

        /*
         * PRIORYTET:
         *
         * potwierdzenie w aplikacji Steam.
         *
         * Jeśli Steam daje jednocześnie DeviceCode
         * i DeviceConfirmation, nie pytamy o kod.
         */
        if (hasDeviceConfirmation) {
            console.log(
                "\nSteam Guard wymaga potwierdzenia."
            );

            console.log(
                "Otwórz aplikację Steam na telefonie i zatwierdź logowanie."
            );

        } else if (hasDeviceCode) {
            console.log(
                "\nSteam wymaga kodu Steam Guard z aplikacji."
            );

            const code =
                await askText(
                    "Kod Steam Guard: "
                );

            if (!code) {
                throw new Error(
                    "Nie podano kodu Steam Guard."
                );
            }

            await session.submitSteamGuardCode(
                code
            );

        } else if (hasEmailConfirmation) {
            console.log(
                "\nSteam wymaga potwierdzenia logowania przez e-mail."
            );

            console.log(
                "Otwórz wiadomość od Steam i zatwierdź logowanie."
            );

        } else if (emailCodeAction) {
            console.log(
                "\nSteam wysłał kod logowania na e-mail."
            );

            if (emailCodeAction.detail) {
                console.log(
                    `E-mail: ${emailCodeAction.detail}`
                );
            }

            const code =
                await askText(
                    "Kod z e-maila: "
                );

            if (!code) {
                throw new Error(
                    "Nie podano kodu Steam Guard."
                );
            }

            await session.submitSteamGuardCode(
                code
            );

        } else {
            throw new Error(
                "Steam wymaga nieobsługiwanej metody autoryzacji."
            );
        }

    } else {
        console.log(
            "Steam Guard nie wymaga dodatkowego działania."
        );
    }

    await authenticated;
}

main()
    .then(
        () => {
            process.exitCode = 0;
        }
    )
    .catch(
        err => {
            console.error(
                "\nBŁĄD:",
                err.message || err
            );

            process.exitCode = 1;
        }
    );
