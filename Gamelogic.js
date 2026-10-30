/**
 * Pure game-logic functions for Quno.
 * No socket I/O — safe to require in tests and in server.js alike.
 */

// ── Card attribute helpers ────────────────────────────────────────────────────
// The 112-card deck maps to a sprite sheet: 14 columns × 8 rows.
// Columns 0–9: numbered cards.  10: skip  11: reverse  12: draw2  13: wild/draw4.
// Rows 0–3: first copy of each color.  Rows 4–7: second copy.
// Row 0&4 = red,  1&5 = yellow,  2&6 = green,  3&7 = blue.
// Column 13 in every row is always black (wild or draw4).

function cardColor(card) {
    if (card % 14 === 13) return 'black'; // wilds and draw 4s are black
    switch (Math.floor(card / 14)) {
        case 0: case 4: return 'red';
        case 1: case 5: return 'yellow';
        case 2: case 6: return 'green';
        case 3: case 7: return 'blue';
    }
}

function cardType(card) {
    switch (card % 14) {
        case 10: return 'skip';
        case 11: return 'reverse';
        case 12: return 'draw2';
        case 13:
            // Rows 4–7 (indices 56+) hold the draw 4s; rows 0–3 hold plain wilds
            return Math.floor(card / 14) >= 4 ? 'draw4' : 'wild';
        default:
            return card % 14; // numbered card — value doubles as type
    }
}

// Look up the card's point value (for end-of-hand scoring)
function cardValue(card) {
    switch (card % 14) {
        case 10: case 11: case 12: return 20; // skip, reverse, draw2
        case 13: return 50;                   // wild, draw4
        default: return card % 14;
    }
}

function buildCard(id) {
    return { ID: id, Color: cardColor(id), Type: cardType(id), Value: cardValue(id) };
}

// ── Deck creation & shuffle ───────────────────────────────────────────────────

// Build a fresh 112-card shuffled deck
function createDeck() {
    const deck = [];
    for (let i = 0; i < 112; i++) deck.push(buildCard(i));
    shuffle(deck);
    return deck;
}

// Fisher-Yates shuffle (in-place)
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── canPlay ───────────────────────────────────────────────────────────────────
// Returns true if the given hand contains at least one legally playable card,
// ignoring card types listed in invalidCards.

function canPlay(hand, currentColor, currentType, invalidCards = []) {
    return hand.some(card => {
        if (invalidCards.includes(card.Type)) return false;
        return (
            card.Color === currentColor ||
            card.Color === 'black' ||
            card.Type === currentType
        );
    });
}

// ── getPoints ─────────────────────────────────────────────────────────────────
// Totals card values in every non-winner's hand and awards them to the winner.
// Mutates player.Points, player.HandsWon, and player.PointsGivenUp in-place.
// Returns { pointsThisHand, breakdown, standings, playerStats }.

function getPoints(playersMap, winner) {
    let pointsThisHand = 0;
    const breakdown = [];

    playersMap.forEach(player => {
        if (player.SocketID !== winner.SocketID) {
            const pts = player.Hand.reduce((sum, card) => sum + card.Value, 0);
            breakdown.push({ name: player.Name, points: pts });
            pointsThisHand += pts;
            player.PointsGivenUp += pts;
        }
    });

    winner.Points += pointsThisHand;
    winner.HandsWon++;

    const standings = Array.from(playersMap.values())
        .map(p => ({ name: p.Name, points: p.Points }))
        .sort((a, b) => b.points - a.points);

    const playerStats = Array.from(playersMap.values()).map(p => ({
        name: p.Name,
        handCardsPlayed: p.HandCardsPlayed,
        matchCardsPlayed: p.MatchCardsPlayed,
        handForced: p.HandForced,
        matchForced: p.MatchForced,
        handReceived: p.HandReceived,
        matchReceived: p.MatchReceived,
        handSearched: p.HandSearched,
        matchSearched: p.MatchSearched,
        handSelfOwned: p.HandSelfOwned,
        matchSelfOwned: p.MatchSelfOwned,
        handTurnTime: Math.round(p.HandTurnTime),
        matchTurnTime: Math.round(p.MatchTurnTime),
        pointsScored: p.Points,
        pointsGivenUp: p.PointsGivenUp,
        netPoints: p.Points - p.PointsGivenUp,
    }));

    return { pointsThisHand, breakdown, standings, playerStats };
}

// ── recordDrawStats ───────────────────────────────────────────────────────────
// Updates the cards-drawn counters when `drawer` draws `num` cards that they didn't
// choose to draw (a stack payout or a Quno penalty).  Mutates player objects in-place.
//
// forcedBy is a list of [playerName, count] pairs naming who put those cards on the
// table.  Each card the drawer draws lands in exactly one of two buckets:
//   - SelfOwned: cards the drawer added to their own stack, or a penalty they caused
//     themselves (selfInflicted — a wrongly timed Quno call)
//   - Received:  everything else, i.e. cards put there by other players
// Other players named in forcedBy are credited Forced.

function recordDrawStats(playersMap, drawer, num, forcedBy = [], selfInflicted = false) {
    let ownCards = selfInflicted ? num : 0;

    forcedBy.forEach(([name, count]) => {
        if (name === drawer.Name) {
            ownCards += count;
            return;
        }
        const forcer = Array.from(playersMap.values()).find(p => p.Name === name);
        if (!forcer) return; // they left the game before the cards were drawn
        forcer.HandForced += count;
        forcer.MatchForced += count;
    });

    drawer.HandReceived += num - ownCards;
    drawer.MatchReceived += num - ownCards;
    drawer.HandSelfOwned += ownCards;
    drawer.MatchSelfOwned += ownCards;
}

// ── nextPlayerID ──────────────────────────────────────────────────────────────
// Pure turn-advance: given the current player's ID, direction, and player count,
// returns the next player's ID (wrapping around).

function nextPlayerID(currentID, direction, playerCount) {
    let next = currentID + direction;
    if (next < 0) next += playerCount;
    if (next >= playerCount) next -= playerCount;
    return next;
}

// ── reshuffleSeats ────────────────────────────────────────────────────────────
// Randomly reassigns PlayerIDs within a players Map (in-place).

function reshuffleSeats(playersMap) {
    const playerArray = Array.from(playersMap.values());
    const ids = playerArray.map(p => p.PlayerID);

    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    playerArray.forEach((player, index) => {
        player.PlayerID = ids[index];
    });
}

// ── buildRequiredPlay ─────────────────────────────────────────────────────────
// Returns the list of card types the current player is allowed to play given
// the active draw stack.  All inputs are explicit so this stays side-effect free.
//
// stackType:   'draw2' | 'draw4' | null
// options:     object with boolean flags matching the server option names:
//              stackDraw2, skipDraw2, reverseDraw2, stackDraw4, skipDraw4, reverseDraw4

function buildRequiredPlay(stackType, options = {}) {
    const rp = [];
    if (stackType === 'draw2') {
        if (options.stackDraw2)   rp.push('draw2');
        if (options.skipDraw2)    rp.push('skip');
        if (options.reverseDraw2) rp.push('reverse');
    } else if (stackType === 'draw4') {
        if (options.stackDraw4)   rp.push('draw4');
        if (options.skipDraw4)    rp.push('skip');
        if (options.reverseDraw4) rp.push('reverse');
    }
    return rp;
}

// ── computeHandMargin ─────────────────────────────────────────────────────────
// Returns the CSS margin-left (in px, negative = overlap) to apply between
// cards in a hand, given the container width, card count, and scale constants.
// Clamped between minMargin and maxMargin.
//
// usableW:    available container width in px (container width minus any padding)
// cardCount:  number of cards in the hand
// cssCardW:   card width before CSS scale is applied (default 107)
// scale:      CSS scale factor (default 0.6)
// minMargin:  minimum (least-overlap) margin — cards start here (e.g. -57 for own, -70 for opponent)
// maxMargin:  maximum (most-overlap) margin — hard cap on compression (e.g. -64 or -80)

function computeHandMargin(usableW, cardCount, cssCardW = 107, scale = 0.6, minMargin = -57, maxMargin = -64) {
    if (cardCount <= 1) return 0;
    const visW = cssCardW * scale;
    const fitMargin = ((usableW - visW) / (cardCount - 1) - visW) / scale;
    return Math.max(maxMargin, Math.min(minMargin, fitMargin));
}

module.exports = {
    cardColor, cardType, cardValue, buildCard,
    createDeck, shuffle,
    canPlay, getPoints, nextPlayerID, reshuffleSeats,
    buildRequiredPlay, computeHandMargin, recordDrawStats,
};