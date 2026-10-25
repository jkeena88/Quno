const { clear } = require('console');
const { resolve } = require('dns');
const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
const port = process.env.PORT || 3000;
const path = require('path');
const crypto = require('crypto');

const {
    buildCard, createDeck: buildDeck, shuffle,
    canPlay: canPlayHand, getPoints, nextPlayerID, reshuffleSeats: reshuffleSeatsMap,
} = require('./Gamelogic');

app.use(express.static(__dirname + '/public', { 'Content-Type': 'application/javascript' }));
app.get('/admin', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.sendFile(path.join(__dirname, 'admin.html'));
});
io.on('connection', onConnection);
server.listen(port, () => console.log('listening on port ' + port));

// ── Game constants ──
const maxPlayers = 8;
const CARD_DRAW_DELAY_MS = 300; // milliseconds between each card drawn in a multi-draw sequence
const REJOIN_GRACE_MS = 10000;  // how long to wait before treating a disconnect as a permanent leave

// ── Game state ──
let playDirection = -1;  // 1 = clockwise, -1 = counter-clockwise
let currentPlayer;       // socket ID of the player whose turn it is
let currentColor;        // active card color
let currentType;         // active card type (number, skip, etc.)
let cardsToDraw = 0;     // accumulated cards a player must draw (from stacked draw 2s / draw 4s)
let stackType = null;    // 'draw2' | 'draw4' | null — which draw type is currently being stacked
let pendingSkipTarget = null; // socket ID of the player who is about to be skipped (null if no skip pending)
let discardPile = [];
let players = new Map(); // socket ID → player object
let pendingPlayers = []; // socket IDs of players waiting to join at the next hand start
let waitingList = [];    // socket IDs waiting for a seat because the game is full (oldest first)
let playersInLobby = []; // ordered list of player names, for the lobby display
let hostName = null;
let deck = [];
let playerA = null;      // socket ID of the host
let gameIsOver = false;
let pendingWinnerSocketId = null; // deferred win check — set when a player empties their hand on a draw card

// ── Per-hand / per-match stats ──
let matchStartTime = null;
let handStartTime = null;
let handsPlayed = 0;
let matchCardsPlayed = 0;
let handCardsPlayed = 0;
let turnStartTime = null;
let lastHandSummary = null; // stats snapshot from the most recently completed hand

// ── Options (all off by default) ──
let playWildDraw4 = false;  // allow Wild Draw 4 regardless of hand contents
let stackDraw2 = false;     // next player can stack a Draw 2 on a Draw 2
let skipDraw2 = false;      // next player can play a Skip to dodge a Draw 2
let reverseDraw2 = false;   // next player can play a Reverse to dodge a Draw 2
let skipSkip = false;       // targeted player can play a Skip to redirect a plain Skip
let stackDraw4 = false;
let skipDraw4 = false;
let reverseDraw4 = false;

// All card types — used to build the "excluded" list when checking who can stack
const cardList = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'skip', 'reverse', 'draw2', 'wild', 'draw4'];

// Cards a player is required to play on their turn (e.g. when stacking is enabled)
let requiredPlay = [];


function onConnection(socket) {

    // Boot a player from the game (host only)
    socket.on('bootPlayer', (targetName) => {
        if(socket.id == playerA) bootPlayerByName(targetName);
    });

    socket.on('disconnect', () => {
        // If this socket was booted by the host, bootPlayer already cleaned everything up
        if (socket.wasBooted) return;

        // Someone waiting for a seat just stops waiting; nothing else to clean up
        if (waitingList.includes(socket.id)) {
            waitingList = waitingList.filter(id => id !== socket.id);
            recordEvent(`${socket.playerName} stopped waiting for a seat`);
            waitingList.forEach((id, i) => io.to(id).emit('roomFull', { position: i + 1, maxPlayers }));
            return;
        }

        const disconnectedName = socket.playerName;
        const disconnectedId = socket.id;

        recordEvent(`${disconnectedName || 'A visitor'} disconnected`);

        // If the host disconnected, promote a new host immediately, unless the admin just
        // refreshed their page; then they keep the role through the grace period below
        if (disconnectedId === playerA && !socket.adminRefresh) {
            promoteNextHost(disconnectedId);
        }

        // Stamp the disconnect time so requestJoin can enforce the grace window
        const disconnectedPlayer = players.get(disconnectedId);
        if (disconnectedPlayer) {
            disconnectedPlayer.disconnectedAt = Date.now();
        }

        setTimeout(() => {
            // A host whose page was refreshed by the admin never came back: hand the role on now
            if (disconnectedId === playerA) promoteNextHost(disconnectedId);

            // The player rejoined successfully if their old socket ID was replaced in the
            // map (disconnectedAt cleared) or if the old entry is simply gone (new socket
            // took over). If the entry still has a disconnectedAt stamp it means nobody
            // has reclaimed this slot — treat it as a permanent leave.
            const entry = players.get(disconnectedId);
            const hasRejoined = entry
                ? entry.disconnectedAt === undefined
                : (!disconnectedName || Array.from(io.sockets.sockets.values()).some(s => s.playerName === disconnectedName));

            if (!hasRejoined) {
                playersInLobby = playersInLobby.filter(p => p !== disconnectedName);
                pendingPlayers = pendingPlayers.filter(id => id !== disconnectedId);
                const leavingPlayerId = entry ? entry.PlayerID : -1;
                players.delete(disconnectedId);
                io.emit('playerLeft', { playerName: disconnectedName, playerId: leavingPlayerId });
                io.emit('newPlayer', { players: playersInLobby, host: hostName });
                logEvent(disconnectedName + ' left the game');

                if (disconnectedId === currentPlayer && !gameIsOver) {
                    nextTurn();
                }
                if (players.size === 0) promoteWaiting(); // no match yet: seat the next person right away
            }
        }, REJOIN_GRACE_MS);
    });

    // Handle a player joining or rejoining the lobby
    socket.on('requestJoin', function(playerName) {
        playerName = playerName.substring(0, 29);
        socket.playerName = playerName;

        // Check if this is a player rejoining with a new socket after disconnecting
        let rejoiningPlayer = null;
        for (let [oldSocketId, player] of players.entries()) {
            if (player.Name === playerName) {
                // Only allow the rejoin if still within the grace window
                const withinGrace = player.disconnectedAt !== undefined &&
                    (Date.now() - player.disconnectedAt) < REJOIN_GRACE_MS;
                // Also allow if disconnectedAt is undefined (they never disconnected —
                // e.g. duplicate tab opened by the same player while still connected)
                const neverDisconnected = player.disconnectedAt === undefined;
                if (!withinGrace && !neverDisconnected) break; // grace expired — fall through to new-player path

                rejoiningPlayer = player;
                // Swap the old socket ID for the new one and clear the disconnect stamp
                players.delete(oldSocketId);
                player.SocketID = socket.id;
                player.disconnectedAt = undefined;
                players.set(socket.id, player);

                if (currentPlayer === oldSocketId) {
                    currentPlayer = socket.id;
                }
                if (oldSocketId === playerA) {
                    playerA = socket.id;
                }
                break;
            }
        }

        if (rejoiningPlayer) {
            // Send the full game state to the rejoining player, hiding other players' cards
            const currentPlayerObj = players.get(currentPlayer);
            const sanitizedList = Array.from(players.values()).map(p => ({
                ...p,
                Hand: p.SocketID === socket.id ? p.Hand : p.Hand.map(() => ({}))
            }));

            io.to(socket.id).emit('rejoinState', {
                playerList: sanitizedList,
                mySocketId: socket.id,
                currentPlayerId: currentPlayerObj ? currentPlayerObj.PlayerID : -1,
                currentColor: currentColor,
                topCard: discardPile.length > 0 ? discardPile[discardPile.length - 1] : null,
                gameIsOver: gameIsOver,
                requiredPlay: requiredPlay,
                stackType: stackType,
                cardsToDraw: cardsToDraw,
                playDirection: playDirection,
                deckCount: deck.length,
                discardCount: discardPile.length,
                isHost: socket.id === playerA,
                hostName: hostName,
                playersInLobby: playersInLobby,
                playWildDraw4
            });
            if (gameIsOver) {
                io.to(socket.id).emit('revealHands', revealPayload());
            }
            io.emit('newPlayer', { players: playersInLobby, host: hostName });
            logEvent(playerName + ' rejoined the game');
            io.to(socket.id).emit('updateOptions', { playWildDraw4, stackDraw2, skipDraw2, reverseDraw2, skipSkip, stackDraw4, skipDraw4, reverseDraw4 });
            if (socket.id === playerA) {
                io.to(socket.id).emit('isPlayerA', { gameInProgress: !gameIsOver });
                io.emit('setHost', hostName);
            }
            return;
        }

        // First player to join becomes the host
        let becameHost = false;
        if(playerA == null) {
            playerA = socket.id;
            hostName = playerName;
            becameHost = true;
            io.to(socket.id).emit('isPlayerA');
            io.emit('setHost', hostName);
        }

        io.to(socket.id).emit('updateOptions', { playWildDraw4, stackDraw2, skipDraw2, reverseDraw2, skipSkip, stackDraw4, skipDraw4, reverseDraw4 });

        // Game is full (or others are already queued ahead of this person): wait for a seat
        if (!playersInLobby.includes(playerName) &&
            (playersInLobby.length >= maxPlayers || waitingList.length > 0)) {
            if (!waitingList.includes(socket.id)) waitingList.push(socket.id);
            io.to(socket.id).emit('roomFull', { position: waitingList.indexOf(socket.id) + 1, maxPlayers });
            logEvent(playerName + ' is waiting for a seat (the game is full)');
            return;
        }

        socket.join();
        if (!playersInLobby.includes(playerName)) {
            playersInLobby.push(playerName);
        }
        io.to(socket.id).emit('responseRoom', [playersInLobby.length, maxPlayers]);
        io.emit('newPlayer', {players: playersInLobby, host: hostName});
        logEvent(playerName + ' joined the game');
        if (becameHost) {
            logEvent(playerName + ' is now the host');
        }

        // If a hand is currently in progress, hold this player in a pending queue
        // rather than adding them to the active game — they'll join at the next hand.
        if (!gameIsOver && players.size > 0) {
            if (!pendingPlayers.includes(socket.id)) {
                pendingPlayers.push(socket.id);
            }
            io.to(socket.id).emit('pendingJoin');
        }
    });

    // Start a new match (resets scores and seats)
    socket.on('resetGame', () => startNewMatch());

    // Deal a new hand without resetting scores
    socket.on('newHand', () => dealNewHand());

    socket.on('playCard', async function(card) {
        let player = players.get(socket.id);
        if (!player) return;
        if (player.WaitingForColorChoice) return; // don't process further input while color picker is open

        let playColor = card.Color;
        let playType = card.Type;

        // Only process the play if it's this player's turn
        if(socket.id == currentPlayer) {

            let colorMatch = (playColor == currentColor && playColor != 'black');
            let typeMatch = (playType == currentType && playColor != 'black');
            let wild = (playType == 'wild');
            let draw4wild = false;

            if(playWildDraw4) {
                draw4wild = (playType == 'draw4');
            } else {
                // Wild Draw 4 is only legal if the player has no other playable card
                draw4wild = (playType == 'draw4' && !canPlay(currentPlayer, ['draw4']));
            }

            // Play is legal if it matches color/type/wild, and satisfies any stacking requirement
            if((colorMatch || typeMatch || wild || draw4wild) && (requiredPlay.length == 0 || requiredPlay.includes(playType))) {
                handCardsPlayed++;

                // Track per-player turn stats
                const playingPlayer = players.get(socket.id);
                if (playingPlayer) {
                    playingPlayer.HandCardsPlayed++;
                    playingPlayer.MatchCardsPlayed++;
                    if (turnStartTime !== null) {
                        const elapsed = (Date.now() - turnStartTime) / 1000;
                        playingPlayer.HandTurnTime += elapsed;
                        playingPlayer.MatchTurnTime += elapsed;
                    }
                    turnStartTime = null;
                }
                requiredPlay = [];
                io.to(currentPlayer).emit('requiredPlay', requiredPlay);
                discardCard(card, socket.id);
                io.emit('hideColor');
                logEvent(socket.playerName + ' played a ' + playColor + ' ' + playType);

                // Defer the win check for draw/skip/reverse cards — the effect still needs to resolve
                const isDeferredWin = (playType === 'draw2' || playType === 'draw4') ||
                    (playType === 'skip' || playType === 'reverse');
                if (!isDeferredWin) {
                    checkForWin(socket.id);
                }

                if(playType == 'wild') {
                    player.WaitingForColorChoice = true;
                    io.to(socket.id).emit('chooseColor');

                } else if(playType == 'draw4') {
                    cardsToDraw += 4;
                    stackType = 'draw4';
                    emitGameStatus();
                    player.WaitingForColorChoice = true;
                    // requiredPlay will be set after color is chosen (in colorChosen handler)
                    io.to(socket.id).emit('chooseColor');

                } else if(playType == 'draw2') {
                    cardsToDraw += 2;
                    stackType = 'draw2';
                    emitGameStatus();
                    if (players.get(socket.id).Hand.length === 0) {
                        pendingWinnerSocketId = socket.id;
                    }
                    await nextTurn(true);
                    await offerStack();

                } else if(playType == 'skip' || (playType == 'reverse' && players.size == 2)) {
                    // With 2 players, Reverse always acts as a Skip.
                    // In both cases: the targeted player gets a chance to respond before being skipped.
                    if (players.get(socket.id).Hand.length === 0) {
                        pendingWinnerSocketId = socket.id;
                    }

                    if (cardsToDraw > 0) {
                        // Mid-stack skip: the next player receives the draw queue (they are the one
                        // being skipped onto). One advance puts us on that player.
                        await nextTurn(true);  // move to the player who receives the draws
                        await offerStack();
                    } else {
                        // Plain skip (no draw queue): give the targeted player a chance to respond.
                        await nextTurn(true);          // move turn to the targeted player
                        pendingSkipTarget = currentPlayer;
                        await offerSkipResponse();
                    }

                } else if(playType == 'reverse') {
                    if (players.get(socket.id).Hand.length === 0) {
                        pendingWinnerSocketId = socket.id;
                    }

                    if (cardsToDraw > 0) {
                        playDirection = -playDirection;
                        emitGameStatus();
                        await nextTurn(true);
                        await offerStack();
                    } else {
                        playDirection = -playDirection;
                        emitGameStatus();
                        await nextTurn(true);
                        resolvePendingWin();
                        if (!gameIsOver) {
                            if (!canPlay(currentPlayer, ['none'])) {
                                autoDraw(currentPlayer);
                            }
                            clearRequiredPlay();
                            io.emit('turnChange', players.get(currentPlayer).PlayerID);
                            turnStartTime = Date.now();
                        }
                    }

                } else {
                    // Numbered card — just advance the turn
                    nextTurn();
                }
            }
        }
    });

    // Player manually draws from the pile
    socket.on('drawCard', function() {
        autoDraw(socket.id);
    });

    // Advance the game after the player picks a color following a wild
    socket.on('colorChosen', async function(color) {
        let player = players.get(socket.id);
        if (!player) return;

        player.WaitingForColorChoice = false;

        currentColor = color;
        io.emit('colorChosen', color);
        logEvent('The color was changed to ' + color);

        if(cardsToDraw > 0) {
            // Wild Draw 4 was just played — advance and offer the stack
            if (players.get(socket.id).Hand.length === 0) {
                pendingWinnerSocketId = socket.id;
            }
            await nextTurn(true);
            await offerStack();
        } else {
            // Plain wild — color is set, just move on
            nextTurn();
        }
    });

    // Player called Uno for themselves
    socket.on('unoMe', function() {
        let player = players.get(socket.id);
        if (!player) return;

        if (player.HasCalledUnoMeThisTurn) return; // can't call it twice in one turn

        player.HasCalledUnoMeThisTurn = true;
        io.to(socket.id).emit('calledUnoMe');

        const now = Date.now();
        const GRACE_MS = 1000; // forgiveness window if unoYou fires at the same instant

        player.LastUnoMeTime = Date.now();

        // Valid call: it's their turn with ≤2 cards, or they're down to 1 card on any turn
        if((player.Hand.length <= 2 && socket.id == currentPlayer) || player.Hand.length == 1) {
            if (!player.HasCalledUno) {
                logEvent(socket.playerName + ' called Quno');
                player.HasCalledUno = true;
            }
        } else {
            // Invalid call — penalize unless they were just called on (avoid double penalty)
            const recentlyGotUnoYou = player.LastUnoYouTime && (now - player.LastUnoYouTime < GRACE_MS);

            if (!recentlyGotUnoYou) {
                logEvent(socket.playerName + ' called Quno at the wrong time - oops!');
                drawCards(socket.id, 2);
                io.to(socket.id).emit('calledUnoMe');
            }
        }
    });

    // Player called Uno on someone else
    socket.on('unoYou', function() {

        let caller = players.get(socket.id);
        if (!caller) return;

        if (caller.HasCalledUnoYou) return; // can only call once per turn

        caller.HasCalledUnoYou = true;
        io.to(socket.id).emit('calledUnoYou');

        const now = Date.now();
        const GRACE_MS = 1000;

        players.forEach((player) => {
            if (player.SocketID === socket.id) return; // can't call Quno on yourself
            const recentlyCalledUnoMe = player.LastUnoMeTime && (now - player.LastUnoMeTime < GRACE_MS);

            // Catch any player who has 1 card and hasn't called Uno (and didn't just call it)
            if(player.Hand.length == 1 && !player.HasCalledUno && !recentlyCalledUnoMe) {
                logEvent(socket.playerName + ' called Quno at the wrong time - oops!');
                drawCards(player.SocketID, 4);
                player.LastUnoYouTime = Date.now();
            };
        });
    });

    // Send the last completed-hand stats snapshot to whoever asks for it
    socket.on('requestStats', function() {
        socket.emit('statsData', lastHandSummary);
    });

    // Save updated game options sent by the host
    socket.on('saveOptions', (data) => {
        if (socket.id !== playerA) return; // host only
        applyOptions(data.options, socket.playerName);
    });
}

// Apply a list of enabled option names and tell everyone
function applyOptions(selectedOptions, changedBy) {
    if (!Array.isArray(selectedOptions)) return;

    playWildDraw4 = selectedOptions.includes('playWildDraw4');
    stackDraw2 = selectedOptions.includes('stackDraw2');
    skipDraw2 = selectedOptions.includes('skipDraw2');
    reverseDraw2 = selectedOptions.includes('reverseDraw2');
    skipSkip = selectedOptions.includes('skipSkip');
    stackDraw4 = selectedOptions.includes('stackDraw4');
    skipDraw4 = selectedOptions.includes('skipDraw4');
    reverseDraw4 = selectedOptions.includes('reverseDraw4');

    const allOptions = { playWildDraw4, stackDraw2, skipDraw2, reverseDraw2, skipSkip, stackDraw4, skipDraw4, reverseDraw4 };
    io.emit('updateOptions', allOptions);

    const optionLabels = {
        playWildDraw4: 'Play Wild Draw 4 any time',
        stackDraw2: 'Stack Draw 2s', skipDraw2: 'Skip Draw 2s', reverseDraw2: 'Reverse Draw 2s',
        skipSkip: 'Skip a Skip',
        stackDraw4: 'Stack Draw 4s', skipDraw4: 'Skip Draw 4s', reverseDraw4: 'Reverse Draw 4s',
    };
    io.emit('optionsChanged', { changedBy, options: allOptions, labels: optionLabels });

    const on = Object.keys(allOptions).filter(k => allOptions[k]);
    recordEvent(`${changedBy} updated options (on: ${on.length ? on.join(', ') : 'none'})`);
}

function assignHost(targetSocket) {
    if (playerA && playerA !== targetSocket.id) io.to(playerA).emit('demoted');
    playerA = targetSocket.id;
    hostName = targetSocket.playerName;
    io.to(playerA).emit('isPlayerA', { gameInProgress: !gameIsOver });
    io.to(playerA).emit('updateOptions', { playWildDraw4, stackDraw2, skipDraw2, reverseDraw2, skipSkip, stackDraw4, skipDraw4, reverseDraw4 });
    io.emit('setHost', hostName);
    io.emit('newPlayer', { players: playersInLobby, host: hostName });
    logEvent(hostName + ' is now the host');
}

function promoteNextHost(excludeId) {
    playerA = null;
    hostName = null;
    const next = Array.from(io.sockets.sockets.values())
        .find(s => s.id !== excludeId && s.playerName && !waitingList.includes(s.id));
    if (next) assignHost(next);
}

// Connected people who hold a seat in the lobby (everyone except those waiting for room)
function lobbySockets() {
    return Array.from(io.sockets.sockets.values())
        .filter(s => s.playerName && !waitingList.includes(s.id));
}

// Give open seats to the people waiting, oldest first
function promoteWaiting() {
    let promoted = false;
    while (waitingList.length > 0 && playersInLobby.length < maxPlayers) {
        const id = waitingList.shift();
        const s = io.sockets.sockets.get(id);
        if (!s || playersInLobby.includes(s.playerName)) continue;
        playersInLobby.push(s.playerName);
        if (players.size > 0) pendingPlayers.push(id); // absorbed by dealNewHand
        io.to(id).emit('roomJoined');
        logEvent(s.playerName + ' joined the game');
        promoted = true;
    }
    if (promoted) io.emit('newPlayer', { players: playersInLobby, host: hostName });
    waitingList.forEach((id, i) => io.to(id).emit('roomFull', { position: i + 1, maxPlayers }));
    if (playerA === null) promoteNextHost(null);
}

function startNewMatch() {
    promoteWaiting();
    if (lobbySockets().length < 2) return false;
    matchStartTime = Date.now();
    handsPlayed = 0;
    matchCardsPlayed = 0;
    pendingPlayers = [];
    lastHandSummary = null;
    logEvent('A new match was started');
    createPlayers();
    startGame();
    return true;
}

function dealNewHand() {
    // Absorb any players who joined during the previous hand
    promoteWaiting();

    // Close any gaps left by players who left, so seat IDs run 0..n-1
    Array.from(players.values())
        .sort((a, b) => a.PlayerID - b.PlayerID)
        .forEach((p, i) => { p.PlayerID = i; });

    if (pendingPlayers.length > 0) {
        let nextID = players.size; // start assigning IDs after existing players
        pendingPlayers.forEach((pendingSocketId) => {
            const pendingSocket = io.sockets.sockets.get(pendingSocketId);
            if (!pendingSocket) return; // socket disconnected before hand ended
            const player = {
                Name: pendingSocket.playerName,
                PlayerID: nextID++,
                Points: 0,
                HandsWon: 0,
                Hand: [],
                SocketID: pendingSocketId,
                HasCalledUno: false,
                HasCalledUnoMeThisTurn: false,
                HasCalledUnoYou: false,
                LastUnoMeTime: 0,
                LastUnoYouTime: 0,
                HandCardsPlayed: 0,
                MatchCardsPlayed: 0,
                HandTurnTime: 0,
                MatchTurnTime: 0,
                PointsGivenUp: 0,
                WaitingForColorChoice: false
            };
            players.set(pendingSocketId, player);
            logEvent(pendingSocket.playerName + ' joined the game');
        });
        pendingPlayers = [];
    }

    logEvent('A new hand was dealt');
    reshuffleSeats();
    startGame();
}

function bootPlayerByName(targetName) {
    // Try to find a live socket first; if the player navigated away their socket
    // is already gone, so fall back to looking them up in the players Map by name.
    const targetSocket = Array.from(io.sockets.sockets.values()).find(s => s.playerName === targetName);
    const targetPlayerEntry = targetSocket
        ? players.get(targetSocket.id)
        : Array.from(players.values()).find(p => p.Name === targetName);

    if (targetPlayerEntry) {
        const targetSocketId = targetPlayerEntry.SocketID;
        const wasCurrentPlayer = (targetSocketId === currentPlayer);

        if (targetSocket) {
            // Player is still connected — tell their browser and disconnect them
            targetSocket.wasBooted = true;
            targetSocket.emit('booted');
            targetSocket.disconnect(true);
        }
        // (If the socket is already gone we just do state cleanup below)

        // If it's the booted player's turn, advance BEFORE removing them
        if (wasCurrentPlayer && players.size > 2) {
            nextTurn();
        }

        // Clean up all server state for this player
        playersInLobby = playersInLobby.filter(p => p !== targetName);
        pendingPlayers = pendingPlayers.filter(id => id !== targetSocketId);
        const leavingPlayerId = targetPlayerEntry.PlayerID;
        players.delete(targetSocketId);

        io.emit('playerLeft', { playerName: targetName, playerId: leavingPlayerId });
        io.emit('setHost', hostName);
        io.emit('newPlayer', { players: playersInLobby, host: hostName });
        logEvent(targetName + ' was booted by the host');

        // End the game if too few players remain to continue
        if (players.size <= 1) {
            gameIsOver = true;
            io.emit('turnChange', -1);
            logEvent('Game over — not enough players to continue');
        }
    }

    else if (targetSocket) {
        // In the lobby only (or waiting to join next hand): no seat to clean up
        targetSocket.wasBooted = true;
        targetSocket.emit('booted');
        targetSocket.disconnect(true);
        playersInLobby = playersInLobby.filter(p => p !== targetName);
        pendingPlayers = pendingPlayers.filter(id => id !== targetSocket.id);
        io.emit('newPlayer', { players: playersInLobby, host: hostName });
        waitingList = waitingList.filter(id => id !== targetSocket.id);
        if (players.size === 0) promoteWaiting();
        logEvent(targetName + ' was booted');
    }
}

// ── Thin wrappers around pure functions ──────────────────────────────────────
// These bridge the pure gameLogic.js API (which takes explicit arguments) and
// the server's module-level state (currentColor, currentType, players Map).

// Returns true if the player with the given socket ID has a legally playable card
function canPlay(socketId, invalidCards) {
    const player = players.get(socketId);
    return canPlayHand(player.Hand, currentColor, currentType, invalidCards);
}

// Randomly reassign seat positions between hands
function reshuffleSeats() {
    reshuffleSeatsMap(players);
}

// Build a new shuffled deck and assign it to the module-level deck variable
function createDeck() {
    deck = buildDeck();
}

// ── Server-side game functions ────────────────────────────────────────────────

// Build the players Map from all currently connected sockets
function createPlayers() {
    players.clear();

    lobbySockets().forEach((socket, i) => {
        const player = {
            Name: socket.playerName,
            PlayerID: i,
            Points: 0,
            HandsWon: 0,
            Hand: [],
            SocketID: socket.id,
            HasCalledUno: false,
            HasCalledUnoMeThisTurn: false,
            HasCalledUnoYou: false,
            LastUnoMeTime: 0,
            LastUnoYouTime: 0,
            HandCardsPlayed: 0,
            MatchCardsPlayed: 0,
            HandTurnTime: 0,
            MatchTurnTime: 0,
            PointsGivenUp: 0,
            WaitingForColorChoice: false
        };
        players.set(socket.id, player);
    });
}

// Deal 7 cards to each player, then flip the first non-wild card to start the discard pile
function dealHands() {
    for(let i = 0; i < 7; i++) {
        players.forEach((player) => {
            let card = deck.pop();
            player.Hand.push(card);
            io.to(player.SocketID).emit('renderCard', card, player);
            io.emit('renderOpponentCard', player.PlayerID);
        });
    }

    do {
        // Keep flipping until the opening card isn't a wild
        card = deck.pop();
        discardCard(card, -1);
    } while(card.Type === 'wild' || card.Type === 'draw4')
}

// Draw one card for a player, reshuffling the discard pile into the deck if needed
function performDraw(player) {
    if(deck.length < 1) {
        // Keep the top discard card in place; shuffle the rest back into the deck
        const tempCard = discardPile.pop();
        deck = discardPile;
        discardPile = [tempCard];
        shuffle(deck);
    }

    const card = deck.pop();
    player.Hand.push(card);
    io.to(player.SocketID).emit('renderCard', card, player);
    io.emit('renderOpponentCard', player.PlayerID);

    io.emit('cardDrawn');
    emitPileStatus();
}

// ── Stacking helpers ──────────────────────────────────────────────────────────

// Build the list of card types the current player is allowed to play given the
// active stack.  stackType must already be set before calling this.
// For a draw2 stack: more draw2s, and (if enabled) skips and reverses.
// For a draw4 stack: more draw4s, and (if enabled) skips and reverses.
function buildRequiredPlay() {
    const rp = [];
    if (stackType === 'draw2') {
        if (stackDraw2)   rp.push('draw2');
        if (skipDraw2)    rp.push('skip');
        if (reverseDraw2) rp.push('reverse');
    } else if (stackType === 'draw4') {
        if (stackDraw4)   rp.push('draw4');
        if (skipDraw4)    rp.push('skip');
        if (reverseDraw4) rp.push('reverse');
    }
    return rp;
}

// After a draw card (or a skip/reverse mid-stack) has been played and the turn
// has already been advanced to the new current player, check if that player can
// respond.  If they can, set requiredPlay so they know what they must play.
// If they can't, immediately deal the accumulated draws and advance the turn.
async function offerStack() {
    if (gameIsOver) return;

    requiredPlay = buildRequiredPlay();

    // If no stacking options are enabled at all, or the active player has none,
    // resolve the stack immediately.
    const hasStackOption = requiredPlay.length > 0;
    const tempExclude = cardList.filter(item => !requiredPlay.includes(item));
    const playerCanStack = hasStackOption && canPlay(currentPlayer, tempExclude);

    if (!playerCanStack) {
        // No stack possible — deal the cards now
        await drawCards(currentPlayer, cardsToDraw);
        stackType = null;
        clearRequiredPlay();
        resolvePendingWin();
        nextTurn();
    } else {
        // Give the player the option to respond
        io.to(currentPlayer).emit('requiredPlay', requiredPlay);
        io.emit('turnChange', players.get(currentPlayer).PlayerID);
        turnStartTime = Date.now();
    }
}

// After a plain skip (no draw queue) has been played and the turn has been
// advanced to the targeted player, check if that player has a skip to respond
// with.  If they do, give them their turn normally (with skip as a required
// play).  If they don't, skip them immediately.
async function offerSkipResponse() {
    if (gameIsOver) return;

    // The player can respond with a skip (or reverse in 2-player) to redirect.
    const skipsAvailable = [];
    if (skipSkip) skipsAvailable.push('skip');
    // In 2-player, reverse acts as a skip — allow it as a redirect too
    if (players.size == 2 && skipSkip) skipsAvailable.push('reverse');

    const tempExclude = cardList.filter(item => !skipsAvailable.includes(item));
    const canRespond = skipsAvailable.length > 0 && canPlay(currentPlayer, tempExclude);

    if (!canRespond) {
        // Skipped player has nothing — skip them and move on
        pendingSkipTarget = null;
        clearRequiredPlay();
        resolvePendingWin();
        if (!gameIsOver) {
            await nextTurn(true);
            clearRequiredPlay();
            if (!canPlay(currentPlayer, ['none'])) {
                autoDraw(currentPlayer);
            }
            io.emit('turnChange', players.get(currentPlayer).PlayerID);
            turnStartTime = Date.now();
        }
    } else {
        // Give the targeted player a chance to respond
        requiredPlay = skipsAvailable;
        io.to(currentPlayer).emit('requiredPlay', requiredPlay);
        io.emit('turnChange', players.get(currentPlayer).PlayerID);
        turnStartTime = Date.now();
    }
}

// Broadcast current draw queue and play direction to all clients so the
// direction indicator widget stays in sync.
function emitGameStatus() {
    io.emit('gameStatus', { cardsToDraw, playDirection });
}

// Tell all clients how tall each pile is so they can draw the right number of layers
function emitPileStatus() {
    io.emit('pileStatus', { deckCount: deck.length, discardCount: discardPile.length });
}

// Everyone's remaining cards, sent at the end of a hand so players can see what was left
function revealPayload() {
    return Array.from(players.values()).map(p => ({ PlayerID: p.PlayerID, Hand: p.Hand }));
}

// Draw a fixed number of cards for a player, with a staggered delay between each
function drawCards(SocketID, num) {
    if (num <= 0) return Promise.resolve();

    const player = players.get(SocketID);
    if (!player) return Promise.resolve();

    const label = num === 1 ? ' card' : ' cards';
    logEvent(`${player.Name} drew ${num}${label}`);

    cardsToDraw = 0;
    stackType = null;
    emitGameStatus();

    io.to(SocketID).emit('notCalledUnoMe');

    io.to(SocketID).emit('drawStart');

    return new Promise((resolve) => {
        for (let i = 0; i < num; i++) {
            setTimeout(() => {
                performDraw(player);
                if (i === num - 1) {
                    io.to(SocketID).emit('drawEnd');
                    resolve();
                }
            }, i * CARD_DRAW_DELAY_MS);
        }
    });
}

// Draw cards one at a time until the player has something playable
function autoDraw(SocketID) {
    if (gameIsOver) return Promise.resolve();
    const player = players.get(SocketID);
    if (!player) return Promise.resolve();

    return new Promise((resolve) => {
        let drawn = 0; // cards drawn in this sequence

        const tryDraw = () => {
            if (!canPlay(SocketID, ['none'])) {
                performDraw(player);
                drawn++;
                setTimeout(tryDraw, CARD_DRAW_DELAY_MS);
            } else {
                // Log once, after the player has found a playable card
                if (drawn > 0) {
                    logEvent(`${player.Name} drew ${drawn} ${drawn === 1 ? 'card' : 'cards'}`);
                }

                player.HasCalledUno = false;
                io.to(SocketID).emit('notCalledUnoMe');
                // Charge the draw time to this player's turn
                if (turnStartTime !== null) {
                    const elapsed = (Date.now() - turnStartTime) / 1000;
                    player.HandTurnTime += elapsed;
                    player.MatchTurnTime += elapsed;
                    turnStartTime = null;
                }
                resolve();
            }
        };

        tryDraw();
    });
}

// Check if the given player has won (empty hand), and end the hand/match if so
function checkForWin(SocketID) {
    let player = players.get(SocketID);

    if(player.Hand.length === 0) {
        let winner = players.get(SocketID);

        const summary = getPoints(players, winner);
        io.emit('updateScore', winner.PlayerID, winner.Points, winner.HandsWon);

        summary.winner = winner.Name;
        summary.handDuration = (Date.now() - handStartTime) / 1000;
        summary.matchDuration = (Date.now() - matchStartTime) / 1000;
        handsPlayed++;
        matchCardsPlayed += handCardsPlayed;
        summary.handsPlayed = handsPlayed;
        summary.handCardsPlayed = handCardsPlayed;
        summary.matchCardsPlayed = matchCardsPlayed;

        lastHandSummary = summary; // keep for on-demand viewing

        gameIsOver = true;
        io.emit('turnChange', -1);
        io.emit('revealHands', revealPayload());
        io.emit('handSummary', summary);
        io.emit('gameOver', winner.Name);
        logEvent(winner.Name + ' won the game');
    }
}

// Remove a card from a player's hand and push it onto the discard pile
function discardCard(card, SocketID) {
    let player;

    // SocketID of -1 means this is the initial flip at game start, not a player play
    if(SocketID != -1) {
        player = players.get(SocketID);
        let cardIndex = player.Hand.findIndex(item => item.ID == card.ID);
        player.Hand.splice(cardIndex, 1);
    }

    discardPile.push(card);
    if (card.Color !== 'black') currentColor = card.Color;
    currentType = card.Type;
    io.emit('discardCard', card, player);

    if (SocketID !== -1) {
        io.emit('removeOpponentCard', player.PlayerID);
    }
    emitPileStatus();
}

// Clear the required-play list and stack state, and broadcast the update to all clients
function clearRequiredPlay() {
    requiredPlay = [];
    stackType = null;
    pendingSkipTarget = null;
    io.emit('requiredPlay', requiredPlay);
}

// Resolve a win that was deferred while a draw card effect played out
function resolvePendingWin() {
    if (pendingWinnerSocketId) {
        checkForWin(pendingWinnerSocketId);
        pendingWinnerSocketId = null;
    }
}

// Advance to the next player's turn, optionally skipping the auto-draw check
async function nextTurn(skipAutoDraw = false) {
    if (gameIsOver) return;
    let player = players.get(currentPlayer);

    const nextID = nextPlayerID(player.PlayerID, playDirection, players.size);

    players.forEach((nextPlayer) => {
        if(nextPlayer.PlayerID == nextID) {
            currentPlayer = nextPlayer.SocketID;
        }
    });

    // Reset Uno-call state for all players at the start of each turn
    players.forEach((p) => {
        p.HasCalledUnoYou = false;
        p.HasCalledUnoMeThisTurn = false;
    });

    io.emit('notCalledUnoMe');
    io.emit('notCalledUnoYou');

    if(!skipAutoDraw) {
        let hasCard = canPlay(currentPlayer, ['none']);
        if(!hasCard) {
            autoDraw(currentPlayer);
        }
        // Only clear the stack state on a normal turn advance; when skipAutoDraw
        // is true the caller (offerStack, offerSkipResponse, etc.) is responsible
        // for managing requiredPlay and stackType.
        clearRequiredPlay();
        io.to(currentPlayer).emit('requiredPlay', requiredPlay);
    }

    io.emit('turnChange', nextID);
    turnStartTime = Date.now();
}

// Reset game state and deal a new hand
async function startGame() {
    gameIsOver = false;
    playDirection = -1;
    cardsToDraw = 0;
    stackType = null;
    pendingSkipTarget = null;
    pendingWinnerSocketId = null;
    handStartTime = Date.now();
    handCardsPlayed = 0;
    discardPile = [];
    clearRequiredPlay();
    emitGameStatus();
    io.emit('notCalledUnoMe');
    io.emit('colorChosen', 'red');
    io.emit('hideColor');
    io.emit('hideDraw');

    // Randomly pick the first player
    let currentPlayerID = Math.floor(Math.random() * players.size);

    players.forEach((player) => {
        player.Hand = [];
        player.HasCalledUno = false;
        player.HasCalledUnoMeThisTurn = false;
        player.HasCalledUnoYou = false;
        player.LastUnoMeTime = 0;
        player.LastUnoYouTime = 0;
        player.WaitingForColorChoice = false;
        player.HandCardsPlayed = 0;
        player.HandTurnTime = 0;
        if(player.PlayerID == currentPlayerID) {
            currentPlayer = player.SocketID;
        }
    });

    io.emit('notCalledUnoMe');
    io.emit('notCalledUnoYou');

    io.emit('gameStarted', Array.from(players.values()));
    createDeck();
    dealHands();

    // If the first player has nothing to play, draw for them before the turn starts
    let hasCard = canPlay(currentPlayer, ['none']);
    if(!hasCard) {
        await autoDraw(currentPlayer);
    }

    io.emit('turnChange', currentPlayerID);
    turnStartTime = Date.now();
}

// ── Admin tools ───────────────────────────────────────────────────────────────
// A separate Socket.IO namespace (/admin) so the admin page never counts as a player
// and never receives game broadcasts. The /admin page itself is only a login screen;
// the password is checked here, when its socket connects.

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminNs = io.of('/admin');
const adminFailures = new Map(); // ip → { count, lockedUntil }

if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the /admin page is disabled');

function passwordMatches(supplied) {
    if (!ADMIN_PASSWORD || typeof supplied !== 'string') return false;
    const hash = s => crypto.createHash('sha256').update(s).digest();
    return crypto.timingSafeEqual(hash(supplied), hash(ADMIN_PASSWORD));
}

const denied = msg => { const e = new Error(msg); e.data = { auth: true }; return e; };

adminNs.use((socket, next) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    const ip = fwd ? fwd.split(',')[0].trim() : socket.handshake.address;
    const rec = adminFailures.get(ip) || { count: 0, lockedUntil: 0 };

    if (Date.now() < rec.lockedUntil) return next(denied('Too many attempts. Try again in a minute.'));
    if (passwordMatches(socket.handshake.auth && socket.handshake.auth.password)) {
        adminFailures.delete(ip);
        return next();
    }
    if (++rec.count >= 5) { rec.lockedUntil = Date.now() + 60000; rec.count = 0; }
    adminFailures.set(ip, rec);
    next(denied(ADMIN_PASSWORD ? 'Wrong password' : 'Admin is disabled (ADMIN_PASSWORD is not set)'));
});

adminNs.on('connection', (socket) => {
    socket.emit('catalog', Array.from({ length: 112 }, (_, i) => buildCard(i)));
    socket.emit('eventLog', eventLog);
    socket.emit('state', buildAdminState());

    socket.on('action', (type, payload, ack) => {
        let result;
        try { result = runAdminAction(type, payload || {}); }
        catch (e) { result = { ok: false, msg: 'Error: ' + e.message }; }
        if (result.ok) recordEvent('[admin] ' + result.msg);
        if (typeof ack === 'function') ack(result);
        adminNs.emit('state', buildAdminState());
    });
});

// Push a fresh snapshot once a second while an admin page is open
setInterval(() => {
    if (adminNs.sockets.size > 0) adminNs.emit('state', buildAdminState());
}, 1000);

function buildAdminState() {
    const sockets = io.sockets.sockets;
    const nameOf = id => (players.get(id) || {}).Name || null;

    return {
        hostName,
        game: {
            hasMatch: players.size > 0,
            gameIsOver,
            currentPlayer: nameOf(currentPlayer),
            currentColor, currentType, playDirection, cardsToDraw, stackType,
            requiredPlay,
            pendingSkipTarget: nameOf(pendingSkipTarget),
            pendingWinner: nameOf(pendingWinnerSocketId),
            deckCount: deck.length,
            discardCount: discardPile.length,
            topCard: discardPile.length ? discardPile[discardPile.length - 1] : null,
            handsPlayed,
        },
        options: { playWildDraw4, stackDraw2, skipDraw2, reverseDraw2, skipSkip, stackDraw4, skipDraw4, reverseDraw4 },
        players: Array.from(players.values())
            .sort((a, b) => a.PlayerID - b.PlayerID)
            .map(p => ({
                name: p.Name, seat: p.PlayerID, points: p.Points, handsWon: p.HandsWon,
                hand: p.Hand,
                connected: sockets.has(p.SocketID),
                isHost: p.SocketID === playerA,
                isCurrent: p.SocketID === currentPlayer,
                calledUno: p.HasCalledUno,
                waitingForColor: p.WaitingForColorChoice,
            })),
        // Connected people who aren't seated in the current hand (lobby / waiting for next deal)
        waiting: Array.from(sockets.values())
            .filter(s => s.playerName && !players.has(s.id))
            .map(s => ({ name: s.playerName, isHost: s.id === playerA })),
    };
}

// Deal cards to a player without touching the draw stack (unlike drawCards)
function adminDraw(player, num) {
    logEvent(`${player.Name} drew ${num} ${num === 1 ? 'card' : 'cards'} (admin)`);
    player.HasCalledUno = false;
    io.to(player.SocketID).emit('notCalledUnoMe');
    io.to(player.SocketID).emit('drawStart');
    for (let i = 0; i < num; i++) {
        setTimeout(() => {
            performDraw(player);
            if (i === num - 1) io.to(player.SocketID).emit('drawEnd');
        }, i * CARD_DRAW_DELAY_MS);
    }
}

// ── Event log (also shown on the admin page) ──
const EVENT_LOG_MAX = 300;
const eventLog = []; // { t: timestamp, msg }

// Admin-only entry (not shown to players)
function recordEvent(message) {
    const entry = { t: Date.now(), msg: message };
    eventLog.push(entry);
    if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
    adminNs.emit('logEvent', entry);
}

// Show a message in every player's log panel and keep a copy for the admin page
function logEvent(message) {
    io.emit('logMessage', message);
    recordEvent(message);
}

function runAdminAction(type, p) {
    const ok = msg => ({ ok: true, msg });
    const fail = msg => ({ ok: false, msg });
    const findSocket = name => Array.from(io.sockets.sockets.values()).find(s => s.playerName === name);
    const findPlayer = name => Array.from(players.values()).find(pl => pl.Name === name);

    switch (type) {
        case 'setHost': {
            const target = findSocket(p.name);
            if (!target) return fail(p.name + ' is not connected');
            if (target.id === playerA) return fail(p.name + ' is already the host');
            assignHost(target);
            return ok(p.name + ' is now the host');
        }

        case 'draw': {
            const pl = findPlayer(p.name);
            if (!pl) return fail(p.name + ' is not seated in the current hand');
            if (gameIsOver) return fail('The hand is over');
            const available = deck.length + Math.max(0, discardPile.length - 1);
            const n = Math.min(Math.floor(Number(p.count)), 50, available);
            if (!(n >= 1)) return fail('Enter a number of cards (1 or more)');
            adminDraw(pl, n);
            return ok(`${pl.Name} is drawing ${n} card${n === 1 ? '' : 's'}`);
        }

        case 'giveCard': {
            const pl = findPlayer(p.name);
            if (!pl) return fail(p.name + ' is not seated in the current hand');
            const idx = deck.findIndex(c => c.ID === Number(p.cardId));
            if (idx === -1) return fail('That card is not in the draw pile (it is in a hand or the discard pile)');
            const [card] = deck.splice(idx, 1);
            pl.Hand.push(card);
            io.to(pl.SocketID).emit('renderCard', card, pl);
            io.emit('renderOpponentCard', pl.PlayerID);
            io.emit('cardDrawn');
            emitPileStatus();
            logEvent(`${pl.Name} was dealt a card (admin)`);
            return ok(`Gave ${pl.Name} a ${card.Color} ${card.Type}`);
        }

        case 'setOptions': {
            if (!Array.isArray(p.options)) return fail('Invalid options');
            applyOptions(p.options, 'Admin');
            return ok('Options updated');
        }

        case 'adjustScore': {
            const pl = findPlayer(p.name);
            if (!pl) return fail(p.name + ' is not seated in the current match');
            const field = p.field === 'handsWon' ? 'HandsWon' : 'Points';
            const label = field === 'HandsWon' ? 'hands won' : 'points';
            const value = p.value === '' ? NaN : Math.round(Number(p.value));
            if (!Number.isFinite(value)) return fail('Enter a number');
            pl[field] = Math.max(0, p.mode === 'add' ? pl[field] + value : value);
            io.emit('updateScore', pl.PlayerID, pl.Points, pl.HandsWon);
            logEvent(`${pl.Name}'s ${label} changed to ${pl[field]} (admin)`);
            return ok(`${pl.Name} now has ${pl[field]} ${label}`);
        }

        case 'removeCard': {
            const pl = findPlayer(p.name);
            if (!pl) return fail(p.name + ' is not seated in the current hand');
            if (gameIsOver) return fail('The hand is over');
            const idx = pl.Hand.findIndex(c => c.ID === Number(p.cardId));
            if (idx === -1) return fail('That card is not in their hand');
            if (pl.Hand.length <= 1) return fail("Can't remove a player's last card");
            const [card] = pl.Hand.splice(idx, 1);
            // Back into the draw pile at a random spot so the deck stays at 112 cards
            deck.splice(Math.floor(Math.random() * (deck.length + 1)), 0, card);
            io.to(pl.SocketID).emit('adminRemoveCard', card.ID);
            io.emit('removeOpponentCard', pl.PlayerID);
            emitPileStatus();
            logEvent(`A card was removed from ${pl.Name}'s hand (admin)`);
            return ok(`Removed a ${card.Color} ${card.Type} from ${pl.Name}`);
        }

        case 'refresh': {
            const targets = p.name === '*'
                ? Array.from(io.sockets.sockets.values())
                : [findSocket(p.name)].filter(Boolean);
            if (!targets.length) return fail('No connected players to refresh');
            // adminRefresh stops the disconnect handler from moving the host role on
            targets.forEach(s => { s.adminRefresh = true; s.emit('adminRefresh'); });
            return ok(`Refreshing ${targets.length} page${targets.length === 1 ? '' : 's'}`);
        }

        case 'newMatch':
            return startNewMatch() ? ok('New match started') : fail('Need at least 2 connected players');

        case 'newHand':
            if (players.size < 2) return fail('Start a match first');
            dealNewHand();
            return ok('New hand dealt');

        case 'nextTurn': {
            if (gameIsOver || !players.get(currentPlayer)) return fail('No hand is in progress');
            // If a win was waiting on a draw card's effect, finish it instead of skipping
            resolvePendingWin();
            if (gameIsOver) return ok('A pending win was resolved; the hand is over');
            // Throw away any half-resolved effect, then advance
            cardsToDraw = 0;
            pendingSkipTarget = null;
            players.forEach(pl => { pl.WaitingForColorChoice = false; });
            emitGameStatus();
            nextTurn(); // also clears requiredPlay and stackType
            logEvent('The admin skipped to the next turn');
            return ok('Advanced to the next turn');
        }

        case 'boot': {
            const sock = findSocket(p.name);
            const entry = findPlayer(p.name);
            if (!sock && !entry) return fail(p.name + ' not found');
            const targetId = sock ? sock.id : entry.SocketID;
            if (targetId === playerA) promoteNextHost(targetId);
            bootPlayerByName(p.name);
            return ok(p.name + ' was booted');
        }

        case 'broadcast': {
            const text = String(p.text || '').trim().slice(0, 200).replace(/</g, '&lt;');
            if (!text) return fail('Type a message first');
            logEvent('Admin: ' + text);
            return ok('Message sent');
        }

        default:
            return fail('Unknown action: ' + type);
    }
}