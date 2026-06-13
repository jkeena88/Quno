const socket = io({autoConnect: false});

// Card sprite dimensions at native size (before CSS scale)
const cdWidth = 120;
const cdHeight = 180;
const cards = new Image(); // sprite sheet (all card faces)
const back = new Image();  // card back image
let socketId = -1;
let playerId = -1;
let players = 0;
let playerName;

let isPlayerA = false;       // true if this client is the host
let playerAName = null;
let currentColor = null;
let bootTargetId = null;
let requiredPlay = [];       // card types this player must play on their turn (stacking rules)
let playersInLobby = [];
let gameInProgress = false;
let isDrawing = false;       // true while the server is dealing cards to this player
let matchEverStarted = false;

const sidePanel = document.getElementById('side-panel');
const collapseButton = document.getElementById('collapse-btn');

// ── UI Helpers ──

function show(id, displayType = 'block') {
    document.getElementById(id).style.display = displayType;
}

function hide(id) {
    document.getElementById(id).style.display = 'none';
}

// Render the lobby player list, with host crown and boot-on-click for the host
function renderPlayerList(lobbyPlayers, hostName) {
    const playerListDiv = document.getElementById('playerList');
    playerListDiv.innerHTML = "<strong>Players:</strong>&nbsp;";

    lobbyPlayers.forEach(name => {
        const span = document.createElement('span');
        span.style.marginRight = '10px';
        const isHost = (name === hostName);
        span.innerHTML = isHost ? `<span class="crown">👑</span>${name}` : name;

        if (isPlayerA) {
            if (name === playerName) {
                span.title = 'You (Host)';
                span.style.cursor = 'default';
            } else {
                span.style.cursor = 'pointer';
                span.title = 'Click to boot player';
                span.addEventListener('click', () => showBootModal(name));
            }
        } else {
            span.title = isHost ? 'Host' : '';
        }

        playerListDiv.appendChild(span);
    });
}

collapseButton.addEventListener('click', () => {
    sidePanel.classList.toggle('collapsed');
});

// ── Socket event handlers ──

socket.on('connect', function() {
    socketId = socket.id;
    socket.emit('requestJoin', playerName);
});

// Rebuild the full game state when rejoining after a disconnect
socket.on('rejoinState', function(state) {
    socketId = state.mySocketId;
    gameInProgress = !state.gameIsOver;
    isPlayerA = state.isHost;
    currentColor = state.currentColor;
    requiredPlay = state.requiredPlay || [];
    updateDirectionIndicator(state.cardsToDraw || 0, state.playDirection || -1);

    for (let p of state.playerList) {
        if (p.SocketID === socketId) {
            playerId = p.PlayerID;
            break;
        }
    }

    hide('waitingOverlay');
    hide('status');
    show('uno-buttons', 'flex');
    show('discard', 'inline-block');
    hide('color-buttons');

    if (isPlayerA) {
        show('btnStart', 'inline-block');
        show('btnOptions', 'inline-block');
        if (state.gameIsOver) {
            show('btnDeal', 'inline-block');
        }
    }

    createPlayersUI(state.playerList);

    playersInLobby = state.playersInLobby;
    renderPlayerList(state.playersInLobby, state.hostName);

    // Render each player's hand (own cards face-up, opponents as card-backs)
    for (let player of state.playerList) {
        for (let card of player.Hand) {
            let hand = document.getElementById('hand_' + player.PlayerID);
            if (!hand) continue;
            let cardObj = getCardUI(card, player);
            if (player.SocketID === socketId) cardObj.classList.add('unplayable');
            hand.appendChild(cardObj);
        }
        repositionCards(player);
    }

    // Restore the top discard card
    if (state.topCard) {
        let cardObj = getCardUI(state.topCard);
        cardObj.id = 'discard';
        let discard = document.getElementById('discard');
        discard.parentNode.replaceChild(cardObj, discard);
        applyWildOverlay(state.topCard.Color === 'black' ? state.currentColor : null);
    }

    // Highlight the active player and refresh playable cards if it's our turn
    if (state.currentPlayerId >= 0) {
        document.querySelectorAll('.player').forEach(p => p.classList.remove('active'));
        const activeEl = document.getElementById('player_' + state.currentPlayerId);
        if (activeEl) activeEl.classList.add('active');

        if (state.currentPlayerId == playerId) {
            const topCard = getTopCard();
            updatePlayableCards(topCard, state.currentColor);
        }
    }

    window.playWildDraw4Enabled = state.playWildDraw4;
});

socket.on('setHost', function(name) {
    playerAName = name;
});

// Show host controls when this player becomes the host
socket.on('isPlayerA', function(data) {
    isPlayerA = true;
    hide('waitingOverlay');
    show('btnStart', 'inline-block');
    show('btnOptions', 'inline-block');
    // If promoted mid-game after the hand is already over, also show Deal
    if (data && data.gameInProgress === false && gameInProgress === false) {
        show('btnDeal', 'inline-block');
    }
    updateStartButtonState();
});

// Disable the Start button until there are at least 2 players
function updateStartButtonState() {
    const startBtn = document.getElementById('btnStart');
    const lobbyCount = playersInLobby.length;

    if (!isPlayerA) return;

    if (lobbyCount > 1) {
        startBtn.disabled = false;
        startBtn.value = 'Start New Match';
    } else {
        startBtn.disabled = true;
        startBtn.value = 'Waiting for Players';
    }
}

// Sync all option checkboxes to the current server-side state
socket.on('updateOptions', function(options) {
    window.playWildDraw4Enabled = options.playWildDraw4;

    const optionMap = {
        playWildDraw4: 'playWildDraw4',
        stackDraw2:    'stackDraw2',
        skipDraw2:     'skipDraw2',
        reverseDraw2:  'reverseDraw2',
        skipSkip:      'skipSkip',
        stackDraw4:    'stackDraw4',
        skipDraw4:     'skipDraw4',
        reverseDraw4:  'reverseDraw4',
    };
    for (const [key, name] of Object.entries(optionMap)) {
        const cb = document.querySelector(`input[name="${name}"]`);
        if (cb) cb.checked = !!options[key];
    }
    // Matt Mode master checkbox is checked only if every sub-option is on
    const controlled = document.querySelectorAll('.controlledCheckbox');
    const master = document.getElementById('masterCheckbox');
    if (master && controlled.length) {
        master.checked = Array.from(controlled).every(cb => cb.checked);
    }
});

socket.on('gameStarted', function(playerList) {
    players = playerList.length;
    hide('waitingOverlay');
    gameInProgress = true;
    matchEverStarted = true;

    playSound('audio/game-start.wav', 0.2);

    hide('status');
    hide('btnDeal');
    show('uno-buttons', 'flex');
    show('discard', 'inline-block');
    hide('color-buttons');

    const self = playerList.find(p => p.SocketID === socketId);
    if (self) playerId = self.PlayerID;

    createPlayersUI(playerList);
});

// Show or hide the waiting overlay for non-host players
function updateWaitingOverlay() {
    if (gameInProgress) return;

    const overlay = document.getElementById('waitingOverlay');
    if (!isPlayerA) {
        overlay.style.display = 'flex';
    } else {
        overlay.style.display = 'none';
    }
}

// Remove a player's in-game panel when they leave without rejoining
socket.on('playerLeft', function({ playerId: leftPlayerId }) {
    const panel = document.getElementById('player_' + leftPlayerId);
    if (panel) panel.remove();
});

// Update the lobby player list when anyone joins or leaves
socket.on('newPlayer', function(data) {
    const {players: lobbyPlayers, host: hostName} = data;

    playersInLobby = lobbyPlayers;
    renderPlayerList(lobbyPlayers, hostName);

    if (isPlayerA) {
        updateStartButtonState();
    } else {
        updateWaitingOverlay();
    }
});

// Show the color picker after this player plays a wild
socket.on('chooseColor', function() {
    show('color-buttons', 'flex');

    const hand = document.getElementById('hand_' + playerId);
    if (hand) {
        hand.querySelectorAll('.card').forEach(c => c.classList.add('unplayable'));
    }
});

socket.on('colorChosen', function(color) {
    currentColor = color;
    applyWildOverlay(color);
});

socket.on('hideColor', function() {
    applyWildOverlay(null);
});

// Update which cards are playable when the server changes the required-play list
socket.on('requiredPlay', list => {
    if (playerId === -1) return; // not yet in a game, nothing to update
    const playerEl = document.getElementById('player_' + playerId);
    if (!playerEl) return;
    const myTurn = playerEl.classList.contains('active');
    if (!myTurn) return;

    requiredPlay = list;

    const topCard = getTopCard();
    updatePlayableCards(topCard, currentColor);
});

// ── Direction / draw indicator ─────────────────────────────────────────────

let lastDrawCount = 0;

function updateDirectionIndicator(cardsToDraw, playDirection) {
    const indicator = document.getElementById('direction-indicator');
    const arrow     = document.getElementById('direction-arrow');
    const countEl   = document.getElementById('direction-count');
    if (!indicator || !arrow || !countEl) return;

    arrow.src = playDirection >= 1 ? 'images/rotate-ccw.svg' : 'images/rotate-cw.svg';

    if (cardsToDraw > 0) {
        indicator.classList.add('draws-queued');
        const newText = '+' + cardsToDraw;
        if (cardsToDraw !== lastDrawCount) {
            countEl.classList.remove('pulse');
            void countEl.offsetWidth; // force reflow to restart animation
            countEl.textContent = newText;
            countEl.classList.add('pulse');
        }
    } else {
        indicator.classList.remove('draws-queued');
        countEl.textContent = '';
        countEl.classList.remove('pulse');
    }
    lastDrawCount = cardsToDraw;
}

socket.on('gameStatus', function({ cardsToDraw, playDirection }) {
    updateDirectionIndicator(cardsToDraw, playDirection);
});

socket.on('turnChange', function(PlayerID) {
    document.querySelectorAll('.player').forEach(p => p.classList.remove('active'));
    document.getElementById('player_' + PlayerID).classList.add('active');

    if(PlayerID == playerId) {
        playSound('audio/turn-change.wav');

        const topCard = getTopCard();
        updatePlayableCards(topCard, currentColor);
    } else {
        // It's not our turn — mark all our cards as unplayable
        const hand = document.getElementById('hand_' + playerId);
        if (hand) {
            hand.querySelectorAll('.card').forEach(c => c.classList.add('unplayable'));
        }
    }
});

// Grey out / restore an Uno button to show it's been called or reset
function setUnoButtonState(btnId, called) {
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.disabled = called;
        btn.style.background = called ? 'gray' : '';
        btn.style.color = called ? 'white' : '';
    }
}

socket.on('calledUnoMe',    () => setUnoButtonState('btnUnoMe', true));
socket.on('notCalledUnoMe', () => setUnoButtonState('btnUnoMe', false));
socket.on('calledUnoYou',   () => setUnoButtonState('btnUnoYou', true));
socket.on('notCalledUnoYou',() => setUnoButtonState('btnUnoYou', false));

socket.on('updateScore', function(player, points, handsWon) {
    document.getElementById('points_' + player).innerHTML = 'Points: ' + points;
    document.getElementById('handsWon_' + player).innerHTML = 'Hands Won: ' + handsWon;
});

socket.on('gameOver', function(playerName) {
    playSound('audio/game-over.wav');
    gameInProgress = false;

    document.getElementById('status').innerHTML = playerName + ' WON';
    show('status', 'inline-block');

    if(isPlayerA) {
        show('btnDeal', 'inline-block');
    }
});

// Add a drawn card to this player's hand with a fade-in animation
socket.on('renderCard', function(card, player) {
    let hand = document.getElementById('hand_' + player.PlayerID);

    animateCardDraw(hand, true, () => {
        let cardObj = getCardUI(card, player);
        if (player.SocketID === socketId) cardObj.classList.add('unplayable');
        cardObj.style.opacity = '0';
        cardObj.style.transition = 'opacity 0.15s ease';
        hand.appendChild(cardObj);
        repositionCards(player);
        requestAnimationFrame(() => requestAnimationFrame(() => { cardObj.style.opacity = '1'; }));

        // If cards finished drawing and it's still our turn, refresh playable highlights
        if(!isDrawing && player.SocketID == socketId) {
            const myTurn = document.getElementById('player_' + playerId).classList.contains('active');
            if (myTurn) {
                const topCard = getTopCard();
                const activeColor = currentColor || topCard.Color;
                updatePlayableCards(topCard, activeColor);
            }
        }
    });
});

// Add a face-down card to an opponent's hand
socket.on('renderOpponentCard', function(playerID) {
    if (playerID == playerId) return; // our own card is handled by renderCard

    const hand = document.getElementById('hand_' + playerID);
    if (!hand) return;

    animateCardDraw(hand, false, () => {
        const cardObj = getCardUI({}, { SocketID: null });
        cardObj.style.opacity = '0';
        cardObj.style.transition = 'opacity 0.15s ease';
        hand.appendChild(cardObj);
        repositionCards({ SocketID: null, PlayerID: playerID });
        requestAnimationFrame(() => requestAnimationFrame(() => { cardObj.style.opacity = '1'; }));
    });
});

// Remove one face-down card from an opponent's hand when they play a card
socket.on('removeOpponentCard', function(playerID) {
    if (playerID == playerId) return;

    const hand = document.getElementById('hand_' + playerID);
    if (!hand) return;

    const lastCard = hand.lastElementChild;
    if (lastCard) lastCard.remove();

    repositionCards({ SocketID: null, PlayerID: playerID });
});

// Lock all cards while the server is dealing this player their draw
socket.on('drawStart', function() {
    isDrawing = true;
    const hand = document.getElementById('hand_' + playerId);
    if (hand) hand.querySelectorAll('.card').forEach(c => c.classList.add('unplayable'));
});

// Unlock cards when the draw sequence finishes
socket.on('drawEnd', function() {
    isDrawing = false;
    const myTurn = document.getElementById('player_' + playerId).classList.contains('active');
    if (myTurn) {
        const topCard = getTopCard();
        updatePlayableCards(topCard, currentColor);
    }
});

// Append a message to the game log, colorizing any color names found in the text
socket.on('logMessage', function(message) {
    const messageContainer = document.getElementById('message-container');
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');

    const colors = {
        red: '#FF5555',
        yellow: '#FFAA01',
        green: '#55AA55',
        blue: '#5455FF',
        black: '#a0a0a0'
    };
    let formattedMessage = message;

    for (const [color, hex] of Object.entries(colors)) {
        const regex = new RegExp(`\\b${color}\\b`, 'gi');
        formattedMessage = formattedMessage.replace(
            regex,
            `<span style="color: ${hex}; font-weight: bold;">${color}</span>`
        );
    }

    messageElement.innerHTML = formattedMessage;
    messageContainer.insertBefore(messageElement, messageContainer.firstChild);
});

// Display a rich log entry when the host changes game options
socket.on('optionsChanged', function({ changedBy, options, labels }) {
    const messageContainer = document.getElementById('message-container');
    const el = document.createElement('div');
    el.classList.add('message');

    const rows = Object.entries(labels).map(([key, label]) => {
        const on = !!options[key];
        const dot   = on ? '●' : '○';
        const color = on ? '#3db87a' : '#c94f5f';
        const style = `color:${color};font-weight:700;margin-right:5px;`;
        return `<div style="display:flex;align-items:center;padding:1px 0;">
            <span style="${style}">${dot}</span>
            <span class="log-option-label" style="font-size:11.5px;${on ? '' : 'opacity:0.55;'}">${label}</span>
        </div>`;
    }).join('');

    el.innerHTML = `
        <div style="font-size:11.5px;margin-bottom:5px;" class="log-meta">
            <strong class="log-name">${changedBy}</strong> updated options
        </div>
        ${rows}
    `;
    messageContainer.insertBefore(el, messageContainer.firstChild);
});

// ── Card rendering helpers ──

// Build an SVG pattern overlay element used for colorblind accessibility.
// Each color gets a distinct pattern: red = horizontal stripes, green = dots, blue = diagonal lines.
function getColorPatternSVG(color) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;border-radius:13px;overflow:hidden;';

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const patternEl = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
    const patternId = 'cbp_' + color + '_' + Math.random().toString(36).substr(2, 7);
    patternEl.setAttribute("id", patternId);
    patternEl.setAttribute("patternUnits", "userSpaceOnUse");

    const patternColor = 'rgba(255,255,255,0.45)';

    if (color === 'red') {
        patternEl.setAttribute("width", "9");
        patternEl.setAttribute("height", "9");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "0"); line.setAttribute("y1", "5");
        line.setAttribute("x2", "9"); line.setAttribute("y2", "5");
        line.setAttribute("stroke", patternColor); line.setAttribute("stroke-width", "5");
        patternEl.appendChild(line);
    } else if (color === 'green') {
        patternEl.setAttribute("width", "9");
        patternEl.setAttribute("height", "9");
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "6"); circle.setAttribute("cy", "6"); circle.setAttribute("r", "4");
        circle.setAttribute("fill", patternColor);
        patternEl.appendChild(circle);
    } else if (color === 'blue') {
        patternEl.setAttribute("width", "12");
        patternEl.setAttribute("height", "12");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", "0"); line.setAttribute("y1", "12");
        line.setAttribute("x2", "12"); line.setAttribute("y2", "0");
        line.setAttribute("stroke", patternColor); line.setAttribute("stroke-width", "3");
        patternEl.appendChild(line);
    } else {
        return null; // no pattern for black (wild) cards
    }

    defs.appendChild(patternEl);
    svg.appendChild(defs);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("width", "100%");
    rect.setAttribute("height", "100%");
    rect.setAttribute("fill", `url(#${patternId})`);
    svg.appendChild(rect);

    return svg;
}

// Apply (or remove) a colored, patterned overlay on the discard card to show
// the chosen wild color. No text label — color is communicated by hue + pattern.
function applyWildOverlay(color) {
    const discard = document.getElementById('discard');
    if (!discard) return;

    const existing = discard.querySelector('.wild-color-overlay');
    if (existing) existing.remove();

    if (!color || color === 'rgb(184, 184, 184)') return;

    const colorHex = { red: '#e8342a', green: '#3a9e3a', blue: '#4545ff', yellow: '#FFAA01' };
    const bg = colorHex[color] || color;

    const overlay = document.createElement('div');
    overlay.className = 'wild-color-overlay';
    overlay.style.cssText = `
        position: absolute;
        inset: 0;
        border-radius: 13px;
        background: ${bg};
        opacity: 0.72;
        pointer-events: none;
        z-index: 3;
        overflow: hidden;
    `;

    const patternSVG = getColorPatternSVG(color);
    if (patternSVG) {
        patternSVG.style.borderRadius = '13px';
        overlay.appendChild(patternSVG);
    }

    discard.appendChild(overlay);
}

// ── Animations ──

// Animate a card flying from a player's hand to the discard pile.
// Fire-and-forget: all game state changes happen synchronously before this is called;
// the animation is purely cosmetic and nothing waits on it.
// srcRect must be captured BEFORE the source element is removed from the DOM.
function animateCardPlay(sourceEl, srcRect) {
    const discard = document.getElementById('discard');
    if (!sourceEl || !srcRect || !discard) return;

    const dstRect = discard.getBoundingClientRect();

    // Clone at full logical size (cdWidth x cdHeight) and use transform: scale()
    // to match the visual size. This keeps background-position identical to the
    // original element throughout the flight — no sprite drift possible.
    // The source card has backgroundSize/position scaled for 107px cells;
    // rescale back to native cdWidth cells for this 120x180 flying div.
    const nativeScale = cdWidth / 107; // ~1.121
    const srcBgSize = sourceEl.style.backgroundSize || 'auto';
    let flyingBgSize = srcBgSize;
    let flyingBgPos  = sourceEl.style.backgroundPosition;
    if (srcBgSize !== 'auto' && srcBgSize !== '' && srcBgSize !== '100%') {
        const [sw, sh] = srcBgSize.replace(/px/g, '').split(' ').map(Number);
        const [px, py] = sourceEl.style.backgroundPosition.replace(/px/g, '').split(' ').map(Number);
        flyingBgSize = `${Math.round(sw * nativeScale)}px ${Math.round(sh * nativeScale)}px`;
        flyingBgPos  = `${Math.round(px * nativeScale)}px ${Math.round(py * nativeScale)}px`;
    }
    const flying = document.createElement('div');
    flying.className = 'card';
    flying.style.backgroundImage = sourceEl.style.backgroundImage;
    flying.style.backgroundPosition = flyingBgPos;
    flying.style.backgroundSize = flyingBgSize;
    flying.style.position = 'fixed';
    flying.style.width = cdWidth + 'px';
    flying.style.height = cdHeight + 'px';
    flying.style.borderRadius = '15px';
    flying.style.pointerEvents = 'none';
    flying.style.zIndex = '9999';
    flying.style.margin = '0';
    flying.style.boxShadow = '2px 6px 16px rgba(0,0,0,0.45)';
    flying.style.transformOrigin = 'top left';
    flying.style.transition = 'none';

    const srcScale = srcRect.width / cdWidth;
    const dstScale = dstRect.width / cdWidth;

    // Center-align the flying card over both its start and end positions
    const startX = srcRect.left + srcRect.width / 2 - (cdWidth * srcScale) / 2;
    const startY = srcRect.top + srcRect.height / 2 - (cdHeight * srcScale) / 2;
    const endX   = dstRect.left + dstRect.width / 2 - (cdWidth * dstScale) / 2;
    const endY   = dstRect.top + dstRect.height / 2 - (cdHeight * dstScale) / 2;

    flying.style.left = startX + 'px';
    flying.style.top  = startY + 'px';
    flying.style.transform = `scale(${srcScale})`;
    document.body.appendChild(flying);

    // Double rAF ensures the browser has painted the start position before transitioning
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            flying.style.transition = 'left 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94), ' +
                                      'top 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94), ' +
                                      'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
            flying.style.left = endX + 'px';
            flying.style.top  = endY + 'px';
            flying.style.transform = `scale(${dstScale})`;
        });
    });

    flying.addEventListener('transitionend', function handler(e) {
        if (e.propertyName !== 'top') return;
        flying.removeEventListener('transitionend', handler);
        flying.remove();
    });
}

// Animate a card flying from the draw pile to a target hand, then call onComplete
function animateCardDraw(targetHandEl, isOwn, onComplete) {
    const pile = document.querySelector('.playArea1 .pile');
    if (!pile) { onComplete(); return; }

    const pileRect = pile.getBoundingClientRect();
    const handRect = targetHandEl.getBoundingClientRect();

    const flying = document.createElement('div');
    flying.style.cssText = `
        position: fixed;
        width: ${cdWidth * 0.6}px;
        height: ${cdHeight * 0.6}px;
        border-radius: 9px;
        background-image: url(${back.src});
        background-size: 100%;
        pointer-events: none;
        z-index: 9999;
        left: ${pileRect.left + pileRect.width / 2 - (cdWidth * 0.6) / 2}px;
        top: ${pileRect.top + pileRect.height / 2 - (cdHeight * 0.6) / 2}px;
        transition: left 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94),
                    top 0.28s cubic-bezier(0.25, 0.46, 0.45, 0.94),
                    opacity 0.1s ease 0.22s;
        box-shadow: 2px 4px 12px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(flying);

    const destX = handRect.left + handRect.width / 2 - (cdWidth * 0.6) / 2;
    const destY = handRect.top + handRect.height / 2 - (cdHeight * 0.6) / 2;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            flying.style.left = destX + 'px';
            flying.style.top = destY + 'px';
            flying.style.opacity = '0';
        });
    });

    flying.addEventListener('transitionend', function handler(e) {
        if (e.propertyName !== 'top') return;
        flying.removeEventListener('transitionend', handler);
        flying.remove();
        onComplete();
    });
}

// ── Card UI ──

// Create a card div element. Own cards and the discard pile show the face;
// opponents' cards show the back image and have no click handler.
function getCardUI(card, player) {
    let cardObj = document.createElement('div');
    cardObj.className = 'card';

    const isMyCard = (player == null || player.SocketID == socketId);

    if(isMyCard) {
        cardObj.id = 'card_' + card.ID;
        cardObj.setAttribute('dataCardColor', card.Color);
        cardObj.setAttribute('dataCardType', card.Type);

        // Position the correct sprite from the sheet.
        // Scale the sheet so each cell matches --card-width (107px).
        // Native cell size: cdWidth × cdHeight (120 × 180). Scale = 107/120.
        const spriteScale = 107 / 120;
        const sheetW = Math.round(1688 * spriteScale); // ~1505
        const sheetH = Math.round(1446 * spriteScale); // ~1289
        const offsetX = Math.round((2 + 1680 - cdWidth * (card.ID % 14)) * spriteScale);
        const offsetY = Math.round((1440 - cdHeight * Math.floor(card.ID / 14)) * spriteScale);
        cardObj.style.backgroundImage = 'url(' + cards.src + ')';
        cardObj.style.backgroundSize = `${sheetW}px ${sheetH}px`;
        cardObj.style.backgroundPosition = `${offsetX}px ${offsetY}px`;

        // Colorblind accessibility pattern overlay
        cardObj.style.position = 'relative';
        const patternOverlay = getColorPatternSVG(card.Color);
        if (patternOverlay) cardObj.appendChild(patternOverlay);

        if(player != null) {
            cardObj.addEventListener('click', () => playCard(card, player));

            cardObj.addEventListener('mouseenter', function () {
                cardObj.style.transform = 'scale(0.6) translateY(-50px)';
            });

            cardObj.addEventListener('mouseleave', function () {
                cardObj.style.transform = 'scale(0.6) translateY(0)';
            });
        }
    } else {
        cardObj.style.backgroundImage = 'url(' + back.src + ')';
        cardObj.style.backgroundSize = '100%';
    }

    return cardObj;
}

// Reposition cards within a hand, applying fan overlap.
// Own hand is sorted by color then type; opponent hands just stack in order.
//
// Overlap rules:
//   - Cards are 107px CSS wide, rendered at scale(0.6) → 64.2px visual width.
//   - CSS margin-left is pre-scale, so visual overlap = |marginLeft| * 0.6.
//   - Opponents: minimum starting CSS margin = -70px (~65% overlap).
//     Cards compress up to 75% visual overlap (CSS -80px) before the hand expands.
//   - Own hand: minimum starting CSS margin = -57px (~53% overlap).
//     Cards compress up to 60% visual overlap (CSS -64px) before the hand expands.
//   - In both cases the hand uses as much available container space as possible
//     before applying any extra overlap beyond the starting minimum.
function repositionCards(player) {
    const hand = document.getElementById('hand_' + player.PlayerID);
    if (!hand) return;

    const cards = Array.from(hand.children);
    const cardCount = cards.length;

    // Visual card width at 0.6 scale
    const CSS_CARD_W = 107;
    const SCALE      = 0.6;
    const VIS_W      = CSS_CARD_W * SCALE; // 64.2px

    if (player.SocketID == socketId) {
        // ── Own hand ──
        // Sort by color then type so the fan is visually organised.
        cards.sort((a, b) => {
            const colorDiff = a.getAttribute('dataCardColor').localeCompare(b.getAttribute('dataCardColor'));
            if (colorDiff !== 0) return colorDiff;
            return a.getAttribute('dataCardType').localeCompare(b.getAttribute('dataCardType'));
        });

        hand.innerHTML = '';

        if (cardCount <= 1) {
            cards.forEach(card => { card.style.marginLeft = '0px'; hand.appendChild(card); });
            return;
        }

        // CSS margin limits (negative = overlap)
        const MIN_MARGIN = -57;  // starting / minimum overlap at low card counts (~53% visual)
        const MAX_MARGIN = -64;  // maximum allowed overlap before container must expand (~60% visual)

        // How wide is the hand's grid cell? Walk up to the grid item (.playerOpponent /
        // .playerSelf) for a stable measurement; the .hand div itself has no fixed width.
        const gridCell = hand.closest('.playerOpponent, .playerSelf');
        const containerW = (gridCell ? gridCell.offsetWidth : hand.offsetWidth) || 600;
        // Padding-left (10px) eats into usable width
        const usableW = containerW - 10;

        // Margin needed to fit all cards exactly in the container:
        // usableW = VIS_W + (cardCount-1) * (VIS_W + margin*SCALE)
        // → margin = ((usableW - VIS_W) / (cardCount-1) - VIS_W) / SCALE
        const fitMargin = ((usableW - VIS_W) / (cardCount - 1) - VIS_W) / SCALE;

        // Clamp: don't overlap more than necessary, but never less than MAX_MARGIN
        const margin = Math.max(MAX_MARGIN, Math.min(MIN_MARGIN, fitMargin));

        cards.forEach((card, i) => {
            card.style.marginLeft = (i === 0 ? 0 : margin) + 'px';
            hand.appendChild(card);
        });

    } else {
        // ── Opponent hand ──
        hand.innerHTML = '';

        if (cardCount <= 1) {
            cards.forEach(card => { card.style.marginLeft = '0px'; hand.appendChild(card); });
            return;
        }

        const MIN_MARGIN = -82;  // starting / minimum overlap (~77% visual)
        const MAX_MARGIN = -92;  // maximum allowed overlap before container must expand (~87% visual)

        const gridCell = hand.closest('.playerOpponent, .playerSelf');
        const containerW = (gridCell ? gridCell.offsetWidth : hand.offsetWidth) || 200;
        const usableW = containerW - 10;

        const fitMargin = ((usableW - VIS_W) / (cardCount - 1) - VIS_W) / SCALE;

        const margin = Math.max(MAX_MARGIN, Math.min(MIN_MARGIN, fitMargin));

        cards.forEach((card, i) => {
            card.style.marginLeft = (i === 0 ? 0 : margin) + 'px';
            hand.appendChild(card);
        });
    }
}

// Highlight playable cards and dim unplayable ones based on the current game state
function updatePlayableCards(topCard, currentColor) {
    const hand = document.getElementById('hand_' + playerId);
    if (!hand) return;

    const cards = hand.querySelectorAll('.card');
    const playWildDraw4Enabled = window.playWildDraw4Enabled || false;
    const mustPlaySpecific = requiredPlay.length > 0;

    let hasOtherPlayable = false;

    // First pass: check if there are any playable cards other than Wild Draw 4
    // (Wild Draw 4 is only legal if the player has no other playable card)
    cards.forEach(card => {
        const cardColor = card.getAttribute('dataCardColor');
        const cardType = card.getAttribute('dataCardType');

        if (!mustPlaySpecific && cardType !== 'draw4') {
            if (cardColor === currentColor || cardType === topCard.Type || cardColor === 'black') {
                hasOtherPlayable = true;
            }
        }
    });

    // Second pass: mark cards as playable or unplayable
    cards.forEach(card => {
        const cardColor = card.getAttribute('dataCardColor');
        const cardType = card.getAttribute('dataCardType');

        let playable = false;

        if (mustPlaySpecific) {
            // The card must be one of the required types AND match color or type.
            // Skips/reverses responding to a plain skip still need a color or type match.
            if (requiredPlay.includes(cardType)) {
                if (cardColor === currentColor || cardColor === 'black' || cardType === topCard.Type) {
                    playable = true;
                }
            }
        } else {
            if (cardColor === currentColor) playable = true;
            if (cardType === topCard.Type) playable = true;

            if (cardColor === 'black') {
                if (cardType === 'wild') playable = true;
                if (cardType === 'draw4') {
                    playable = playWildDraw4Enabled || !hasOtherPlayable;
                }
            }
        }

        if (playable) {
            card.classList.remove('unplayable');
        } else {
            card.classList.add('unplayable');
        }
    });
}

function playCard(card, player) {
    if (isDrawing) return; // don't allow plays while a draw sequence is in progress

    socket.emit('playCard', card);
    repositionCards(player);
}

// Update the discard pile when a card is played, with a flying animation
socket.on('discardCard', function(card, player) {
    currentColor = card.Color;

    let cardObj = getCardUI(card);
    cardObj.id = 'discard';

    // Initial deal — no animation, just swap the placeholder immediately
    if (player == null) {
        let discard = document.getElementById('discard');
        discard.parentNode.replaceChild(cardObj, discard);
        return;
    }

    const isMyCard = player.SocketID === socketId;

    if (isMyCard) {
        // Snapshot the source rect while the element is still in the DOM, then
        // do all state changes synchronously so turnChange/updatePlayableCards
        // see the correct state before the animation starts.
        const sourceEl = document.getElementById('card_' + card.ID);
        const srcRect = sourceEl ? sourceEl.getBoundingClientRect() : null;
        if (sourceEl) sourceEl.remove();
        repositionCards(player);

        let discard = document.getElementById('discard');
        discard.parentNode.replaceChild(cardObj, discard);

        animateCardPlay(sourceEl, srcRect);
    } else {
        // For opponents, removeOpponentCard handles DOM removal and repositionCards.
        // Snapshot for animation before it's removed.
        const hand = document.getElementById('hand_' + player.PlayerID);
        const sourceEl = hand ? hand.lastElementChild : null;
        const srcRect = sourceEl ? sourceEl.getBoundingClientRect() : null;

        let discard = document.getElementById('discard');
        discard.parentNode.replaceChild(cardObj, discard);

        animateCardPlay(sourceEl, srcRect);
    }
});

socket.on('cardDrawn', function() {
    let f = document.getElementById("draw-sound")?.value ?? "audio/draw-card.wav";
    playSound(f);
});

// ── Persistence ──

function savePlayerName(name) {
    localStorage.setItem('playerName', name);
}

function getSavedPlayerName() {
    return localStorage.getItem('playerName');
}

// ── Game action buttons ──

function resetGame() {
    socket.emit('resetGame');
}

function newHand() {
    socket.emit('newHand');
}

// Send the chosen color to the server after a wild is played
function setColor(color) {
    hide('color-buttons');
    socket.emit('colorChosen', color);
}

// Build player panels around the table. The local player goes in the bottom slot;
// opponents are placed in the surrounding grid positions relative to seat order.
function createPlayersUI(players) {
    for (let i = 0; i < 7;  i++) {
        document.getElementById('player' + i).innerHTML = '';
    }
    document.getElementById('playerSelf').innerHTML = '';

    for(let i = 0; i < players.length; i++) {
        let div_player = document.createElement('div');
        let div_player_name = document.createElement('div');
        let div_hand = document.createElement('div');
        let div_points = document.createElement('div');
        let div_hands_won = document.createElement('div');

        if(isPlayerA) {
            div_player_name.style.cursor = 'pointer';
            div_player_name.addEventListener('click', () => showBootModal(players[i].SocketID, players[i].Name));
        }

        div_player_name.className = 'name';
        div_points.className = 'points';
        div_points.id = 'points_' + players[i].PlayerID;
        div_hands_won.className = 'hands-won';
        div_hands_won.id = 'handsWon_' + players[i].PlayerID;
        div_player.className = 'player';
        div_player.id = 'player_' + players[i].PlayerID;
        div_hand.className = 'hand';
        div_hand.id = 'hand_' + players[i].PlayerID;

        div_player_name.innerHTML = players[i].Name;
        div_points.innerHTML = 'Points: ' + players[i].Points;
        div_hands_won.innerHTML = 'Hands Won: ' + players[i].HandsWon;
        div_player.appendChild(div_player_name);
        div_player.appendChild(div_hand);
        div_player.appendChild(div_points);
        div_player.appendChild(div_hands_won);
        if(players[i].SocketID == socketId) {
            document.getElementById('playerSelf').appendChild(div_player);
        } else {
            // Place the opponent in a grid slot based on how far ahead of us they sit
            let player_location = playerId - players[i].PlayerID;

            if(player_location < 0) {
                player_location += 8;
            }

            const locationMap = [null, 5, 3, 0, 1, 2, 4, 6]; // maps seat distance to grid slot id
            player_location = locationMap[player_location];

            document.getElementById('player' + player_location).appendChild(div_player);
        }
    }
}

function unoCall(type) {
    setUnoButtonState('btnUno' + type, true);
    socket.emit('uno' + type);
}

function unoMe() { unoCall('Me'); }
function unoYou() { unoCall('You'); }

function showOptions() {
    const options = document.getElementById('options');
    if (options.style.display === 'flex') {
        hide('options');
    } else {
        show('options', 'flex');
    }
}

function saveOptions() {
    hide('options');
    let checkboxes = document.querySelectorAll('#options input[type="checkbox"]:checked');
    let selectedValues = Array.from(checkboxes).map(checkbox => checkbox.value);

    socket.emit('saveOptions', {options: selectedValues});
}

// ── Initialization ──

function init() {
    cards.src = 'images/deck_full.png';
    back.src = 'images/quno.png';

    playerName = getSavedPlayerName();
    if(playerName == null) {
        let defaultName = 'Player' + Math.floor(1000 + Math.random() * 9000);

        playerName = prompt('Enter your name: ', defaultName);

        if (playerName === null || playerName === "") {
            playerName = defaultName;
        } else {
            savePlayerName(playerName);
        }
    }

    playerName = playerName.substring(0, 29);

    socket.connect();
}

// Show the boot confirmation modal before sending the boot request to the server
function showBootModal(playerName) {
    const modal = document.getElementById('bootModal');
    const msg = document.getElementById('bootMessage');
    const confirmBtn = document.getElementById('confirmBoot');
    const cancelBtn = document.getElementById('cancelBoot');

    msg.textContent = `Are you sure you want to boot ${playerName}?`;
    modal.style.display = 'flex';

    confirmBtn.onclick = () => {
        socket.emit('bootPlayer', playerName);
        modal.style.display = 'none';
    };

    cancelBtn.onclick = () => {
        modal.style.display = 'none';
    };
}

// Show the reset confirmation modal before sending the reset request to the server
function showResetConfirm() {
    if (!matchEverStarted) {
        resetGame();
        return;
    }

    const modal = document.getElementById('resetConfirmModal');
    modal.style.display = 'flex';

    document.getElementById('confirmReset').onclick = () => {
        modal.style.display = 'none';
        resetGame();
    };
}

function playSound(src, volume=1.0) {
    const audio = new Audio(src);
    audio.volume = volume;
    audio.play();
}

// Read the top card's color and type from the discard pile DOM element
function getTopCard() {
    const discard = document.getElementById('discard');
    return {
        Color: discard.getAttribute('dataCardColor'),
        Type: discard.getAttribute('dataCardType')
    };
}

// Replace the page with a boot message and prevent reconnection
socket.on('booted', () => {
    socket.io.opts.reconnection = false;
    socket.disconnect();

    document.body.innerHTML = `
        <div style="text-align:center; margin-top:100px;">
            <h1>You have been booted from the game.</h1>
            <p>Refresh to return to the lobby.</p>
        </div>
    `;
});

// ── End-of-hand summary modal ──

socket.on('handSummary', function(summary) {
    const modal = document.getElementById('handSummaryModal');
    const content = document.getElementById('handSummaryContent');

    const ps = summary.playerStats || [];

    // Truncate long player names so they don't break table layout
    const MAX_NAME = 12;
    function truncate(name) {
        return name.length > MAX_NAME ? name.slice(0, MAX_NAME - 1) + '...' : name;
    }

    const thBase  = 'padding:7px 10px;font-size:11px;color:#6b8a7a;font-weight:700;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid rgba(0,232,154,0.3);';
    const thStyle = 'text-align:left;' + thBase;
    const thRight = 'text-align:right;' + thBase;
    const tdStyle = 'padding:6px 8px;font-size:14px;';
    const tdRight = 'text-align:right;padding:6px 8px;font-size:14px;';

    // Build one table row per player showing cards played and time spent
    function buildTurnRows(cardsKey, timeKey) {
        return ps.map(p =>
            `<tr>
                <td style="${tdStyle}">${truncate(p.name)}</td>
                <td style="${tdRight}">${p[cardsKey]}</td>
                <td style="${tdRight}">${formatDuration(p[timeKey])}</td>
            </tr>`
        ).join('');
    }

    const handTurnRows = buildTurnRows('handCardsPlayed', 'handTurnTime');
    const matchTurnRows = buildTurnRows('matchCardsPlayed', 'matchTurnTime');

    const standingRows = ps
        .slice()
        .sort((a, b) => (b.pointsScored - a.pointsScored) || (b.netPoints - a.netPoints))
        .map(p => {
            const netColor = p.netPoints >= 0 ? 'color:#3db87a;font-weight:600;' : 'color:#c94f5f;font-weight:600;';
            const netStr = (p.netPoints >= 0 ? '+' : '') + p.netPoints;
            return `<tr>
                <td style="${tdStyle}font-weight:600;">${truncate(p.name)}</td>
                <td style="${tdRight}">${p.pointsScored}</td>
                <td style="${tdRight}">${p.pointsGivenUp}</td>
                <td style="${tdRight}${netColor}">${netStr}</td>
            </tr>`;
        }).join('');

    const sc = 'padding:10px 0 10px;border-bottom:1px solid rgba(0,232,154,0.15);';
    const slabel = 'font-size:11px;color:#6b8a7a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;';
    const sval = 'font-size:1.15rem;font-weight:700';

    // Pad the points-given-up table to match the standings row count
    const breakdownRows = summary.breakdown.length;
    const standingsCount = ps.length;
    const paddingRows = Math.max(0, standingsCount - breakdownRows);
    const breakdownpadding = paddingRows > 0
        ? `<tr><td colspan="2" style="padding:${paddingRows * 33}px 0 0;"></td></tr>`
        : '';

    const html = `
        <h2 style="margin:0 0 20px;text-align:center;">Hand Summary</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">

            <!-- LEFT: HAND STATS -->
            <div>
                <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b8a7a;margin:0 0 12px;">This hand</p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-bottom:20px;">
                    <div style="${sc}padding-right:12px;"><div style="${slabel}">Winner</div><div style="${sval}color:#3db87a;">${truncate(summary.winner)}</div></div>
                    <div style="${sc}padding-left:12px;"><div style="${slabel}">Points scored</div><div style="${sval}">${summary.pointsThisHand}</div></div>
                    <div style="${sc}padding-right:12px;"><div style="${slabel}">Duration</div><div style="${sval}">${formatDuration(summary.handDuration)}</div></div>
                    <div style="${sc}padding-left:12px;border-bottom:none;"><div style="${slabel}">Cards played</div><div style="${sval}">${summary.handCardsPlayed}</div></div>
                </div>

                <p style="${slabel}margin:0 0 8px;">Points given up</p>
                <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
                    <thead><tr>
                        <th style="${thStyle}">Player</th>
                        <th style="${thRight}">Points</th>
                    </tr></thead>
                    <tbody>
                        ${summary.breakdown.map(b => `<tr><td style="${tdStyle}">${truncate(b.name)}</td><td style="${tdRight}">${b.points}</td></tr>`).join('')}
                        ${breakdownpadding}
                    </tbody>
                </table>

                <p style="${slabel}margin:0 0 8px;">Time spent (this hand)</p>
                <table style="width:100%;border-collapse:collapse;">
                    <thead><tr>
                        <th style="${thStyle}">Player</th>
                        <th style="${thRight}">Cards</th>
                        <th style="${thRight}">Time</th>
                    </tr></thead>
                    <tbody>${handTurnRows}</tbody>
                </table>
            </div>

            <!-- RIGHT: MATCH STATS -->
            <div style="border-left:1px solid rgba(0,232,154,0.15);padding-left:24px;">
                <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b8a7a;margin:0 0 12px;">Match so far</p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-bottom:20px;">
                    <div style="${sc}padding-right:12px;"><div style="${slabel}">Duration</div><div style="${sval}">${formatDuration(summary.matchDuration)}</div></div>
                    <div style="${sc}padding-left:12px;"><div style="${slabel}">Hands played</div><div style="${sval}">${summary.handsPlayed}</div></div>
                    <div style="${sc}padding-right:12px;border-bottom:none;grid-column:1/-1;"><div style="${slabel}">Cards played</div><div style="${sval}">${summary.matchCardsPlayed.toLocaleString()}</div></div>
                </div>

                <p style="${slabel}margin:0 0 8px;">Standings</p>
                <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
                    <thead><tr>
                        <th style="${thStyle}">Player</th>
                        <th style="${thRight}">Scored</th>
                        <th style="${thRight}">Given up</th>
                        <th style="${thRight}">Net</th>
                    </tr></thead>
                    <tbody>${standingRows}</tbody>
                </table>

                <p style="${slabel}margin:0 0 8px;">Time spent (match total)</p>
                <table style="width:100%;border-collapse:collapse;">
                    <thead><tr>
                        <th style="${thStyle}">Player</th>
                        <th style="${thRight}">Cards</th>
                        <th style="${thRight}">Time</th>
                    </tr></thead>
                    <tbody>${matchTurnRows}</tbody>
                </table>
            </div>
        </div>
    `;

    content.innerHTML = html;
    modal.style.display = 'flex';
});

// Format a duration in seconds as "Xh Ym Zs", omitting leading zeroes
function formatDuration(totalSeconds) {
    const seconds = Number(totalSeconds);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.round(seconds % 60);

    return [
        hours ? `${hours}h` : null,
        minutes ? `${minutes}m` : null,
        secs || (!hours && !minutes) ? `${secs}s` : null
    ]
        .filter(Boolean)
        .join(' ');
}

function closeHandSummary() {
    document.getElementById('handSummaryModal').style.display = 'none';
}

// Wire up the "Matt Mode" master checkbox to toggle all sub-options at once
const masterCheckbox = document.getElementById('masterCheckbox');
const controlledCheckboxes = document.querySelectorAll('.controlledCheckbox');
masterCheckbox.addEventListener('click', () => {
    const isChecked = masterCheckbox.checked;
    controlledCheckboxes.forEach(checkbox => { checkbox.checked = isChecked; });
});

init();