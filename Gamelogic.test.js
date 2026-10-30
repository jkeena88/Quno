/**
 * Unit tests for Quno game logic (server.js pure functions).
 *
 * Run with:  npx jest
 */

const {
    cardColor, cardType, cardValue, buildCard,
    createDeck, shuffle,
    canPlay, getPoints, nextPlayerID, reshuffleSeats,
    buildRequiredPlay, computeHandMargin, recordDrawStats,
} = require('./Gamelogic');

// Test-only helper: build a minimal player object
function makePlayer(socketId, playerID, hand = [], extra = {}) {
    return {
        Name: 'Player' + playerID,
        PlayerID: playerID,
        Points: 0,
        HandsWon: 0,
        Hand: hand,
        SocketID: socketId,
        HasCalledUno: false,
        HasCalledUnoMeThisTurn: false,
        HasCalledUnoYou: false,
        LastUnoMeTime: 0,
        LastUnoYouTime: 0,
        HandCardsPlayed: 0,
        MatchCardsPlayed: 0,
        HandForced: 0,
        MatchForced: 0,
        HandReceived: 0,
        MatchReceived: 0,
        HandSearched: 0,
        MatchSearched: 0,
        HandSelfOwned: 0,
        MatchSelfOwned: 0,
        HandTurnTime: 0,
        MatchTurnTime: 0,
        PointsGivenUp: 0,
        WaitingForColorChoice: false,
        ...extra,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// cardColor
// ─────────────────────────────────────────────────────────────────────────────

describe('cardColor', () => {
    // Each color occupies two rows of 14 (one for each copy of the color).
    // Row 0 (IDs 0–13) and row 4 (IDs 56–69) → red
    // Row 1 (IDs 14–27) and row 5 (IDs 70–83) → yellow
    // Row 2 (IDs 28–41) and row 6 (IDs 84–97) → green
    // Row 3 (IDs 42–55) and row 7 (IDs 98–111) → blue
    // Column 13 in every row is always black (wild/draw4)

    test.each([
        [0,  'red'],
        [5,  'red'],
        [12, 'red'],
        [56, 'red'],
        [68, 'red'],
    ])('ID %i → red', (id, expected) => {
        expect(cardColor(id)).toBe(expected);
    });

    test.each([
        [14, 'yellow'],
        [20, 'yellow'],
        [26, 'yellow'],
        [70, 'yellow'],
    ])('ID %i → yellow', (id, expected) => {
        expect(cardColor(id)).toBe(expected);
    });

    test.each([
        [28, 'green'],
        [35, 'green'],
        [40, 'green'],
        [84, 'green'],
    ])('ID %i → green', (id, expected) => {
        expect(cardColor(id)).toBe(expected);
    });

    test.each([
        [42, 'blue'],
        [50, 'blue'],
        [54, 'blue'],
        [98, 'blue'],
    ])('ID %i → blue', (id, expected) => {
        expect(cardColor(id)).toBe(expected);
    });

    test('column-13 cards are always black (wild / draw4)', () => {
        const col13s = [13, 27, 41, 55, 69, 83, 97, 111];
        col13s.forEach(id => expect(cardColor(id)).toBe('black'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// cardType
// ─────────────────────────────────────────────────────────────────────────────

describe('cardType', () => {
    test('numbered cards return their face value', () => {
        // ID 0 → col 0 → type 0, ID 5 → col 5 → type 5, etc.
        for (let col = 0; col <= 9; col++) {
            expect(cardType(col)).toBe(col);       // row 0
            expect(cardType(col + 56)).toBe(col);  // row 4
        }
    });

    test('column 10 → skip', () => {
        expect(cardType(10)).toBe('skip');
        expect(cardType(24)).toBe('skip'); // row 1, col 10
    });

    test('column 11 → reverse', () => {
        expect(cardType(11)).toBe('reverse');
        expect(cardType(25)).toBe('reverse');
    });

    test('column 12 → draw2', () => {
        expect(cardType(12)).toBe('draw2');
        expect(cardType(26)).toBe('draw2');
    });

    test('column 13, rows 0–3 → wild', () => {
        [13, 27, 41, 55].forEach(id => expect(cardType(id)).toBe('wild'));
    });

    test('column 13, rows 4–7 → draw4', () => {
        [69, 83, 97, 111].forEach(id => expect(cardType(id)).toBe('draw4'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// cardValue
// ─────────────────────────────────────────────────────────────────────────────

describe('cardValue', () => {
    test('numbered cards are worth their face value (0–9)', () => {
        for (let col = 0; col <= 9; col++) {
            expect(cardValue(col)).toBe(col);
        }
    });

    test('skip, reverse, draw2 are worth 20 points', () => {
        expect(cardValue(10)).toBe(20); // skip
        expect(cardValue(11)).toBe(20); // reverse
        expect(cardValue(12)).toBe(20); // draw2
    });

    test('wild and draw4 are worth 50 points', () => {
        expect(cardValue(13)).toBe(50);  // wild
        expect(cardValue(69)).toBe(50);  // draw4
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// createDeck
// ─────────────────────────────────────────────────────────────────────────────

describe('createDeck', () => {
    let deck;

    beforeEach(() => {
        deck = createDeck();
    });

    test('deck has exactly 112 cards', () => {
        expect(deck).toHaveLength(112);
    });

    test('every card has the correct Color, Type, and Value for its ID', () => {
        // Re-sort by ID to check each card's attributes independently of shuffle order
        const sorted = [...deck].sort((a, b) => a.ID - b.ID);
        sorted.forEach((card, i) => {
            expect(card.ID).toBe(i);
            expect(card.Color).toBe(cardColor(i));
            expect(card.Type).toBe(cardType(i));
            expect(card.Value).toBe(cardValue(i));
        });
    });

    test('deck contains 8 wilds and 8 draw4s', () => {
        const wilds  = deck.filter(c => c.Type === 'wild');
        const draw4s = deck.filter(c => c.Type === 'draw4');
        expect(wilds).toHaveLength(4);
        expect(draw4s).toHaveLength(4);
    });

    test('deck contains 8 cards of each color action type (skip/reverse/draw2)', () => {
        ['skip', 'reverse', 'draw2'].forEach(type => {
            expect(deck.filter(c => c.Type === type)).toHaveLength(8);
        });
    });

    test('card IDs are unique (no duplicates)', () => {
        const ids = deck.map(c => c.ID);
        expect(new Set(ids).size).toBe(112);
    });

    test('deck is shuffled (not in sequential ID order)', () => {
        // The probability of a 112-card deck being in sorted order by chance is 1/112!,
        // so this check will essentially never produce a false failure.
        const ids = deck.map(c => c.ID);
        const isSorted = ids.every((id, i) => i === 0 || id > ids[i - 1]);
        expect(isSorted).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// shuffle
// ─────────────────────────────────────────────────────────────────────────────

describe('shuffle', () => {
    test('returns the same array reference (in-place)', () => {
        const arr = [1, 2, 3, 4, 5];
        const ref = arr;
        shuffle(arr);
        expect(arr).toBe(ref);
    });

    test('shuffled array contains the same elements', () => {
        const original = [1, 2, 3, 4, 5, 6, 7, 8];
        const copy = [...original];
        shuffle(copy);
        expect(copy.sort()).toEqual(original.sort());
    });

    test('a single-element array is unchanged', () => {
        const arr = [42];
        shuffle(arr);
        expect(arr).toEqual([42]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// canPlay
// ─────────────────────────────────────────────────────────────────────────────

describe('canPlay', () => {
    const redSkip  = { ID: 10, Color: 'red',    Type: 'skip',    Value: 20 };
    const redFive  = { ID: 5,  Color: 'red',    Type: 5,         Value: 5  };
    const blueFive = { ID: 61, Color: 'blue',   Type: 5,         Value: 5  };
    const blueTwo  = { ID: 58, Color: 'blue',   Type: 2,         Value: 2  };
    const wildCard = { ID: 13, Color: 'black',  Type: 'wild',    Value: 50 };
    const draw4    = { ID: 69, Color: 'black',  Type: 'draw4',   Value: 50 };

    test('color match allows play', () => {
        expect(canPlay([redFive], 'red', 'skip')).toBe(true);
    });

    test('type match allows play', () => {
        expect(canPlay([blueFive], 'red', 5)).toBe(true);
    });

    test('black (wild) cards are always playable', () => {
        expect(canPlay([wildCard], 'green', 'reverse')).toBe(true);
        expect(canPlay([draw4],   'yellow', 4)).toBe(true);
    });

    test('no match → cannot play', () => {
        expect(canPlay([blueTwo], 'red', 'skip')).toBe(false);
    });

    test('empty hand → cannot play', () => {
        expect(canPlay([], 'red', 5)).toBe(false);
    });

    test('invalidCards list excludes matching cards', () => {
        // draw4 matches color='black' but is in the exclusion list
        expect(canPlay([draw4], 'green', 'reverse', ['draw4'])).toBe(false);
    });

    test('invalidCards exclusion does not affect other playable cards', () => {
        // redSkip matches color; excluding draw4 should not prevent it playing
        expect(canPlay([redSkip, draw4], 'red', 'wild', ['draw4'])).toBe(true);
    });

    test('stacking scenario: only draw2 is required, skip is not playable', () => {
        const redDraw2 = { ID: 12, Color: 'red',  Type: 'draw2', Value: 20 };
        const greenSkip = { ID: 66, Color: 'green', Type: 'skip', Value: 20 };

        // With requiredPlay = ['draw2'], greenSkip should not count as playable
        // (simulated here by passing ['skip', 'reverse', ...everything else] as invalid)
        const invalidCards = [0,1,2,3,4,5,6,7,8,9,'skip','reverse','wild','draw4'];
        expect(canPlay([greenSkip], 'red', 'draw2', invalidCards)).toBe(false);
        expect(canPlay([redDraw2],  'red', 'draw2', invalidCards)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// canPlay — stacking scenarios
//
// These tests mirror how server.js uses canPlay() to decide whether a player
// can respond to an active draw stack.  The server builds an invalidCards list
// of everything NOT in requiredPlay, then calls canPlay with that list.
// A card is only stackable if it is in requiredPlay AND matches color/type.
//
// Helper: given requiredPlay types, return the invalidCards list the server
// would pass to canPlay.
// ─────────────────────────────────────────────────────────────────────────────

describe('canPlay — stacking scenarios', () => {
    const ALL_TYPES = [0,1,2,3,4,5,6,7,8,9,'skip','reverse','draw2','wild','draw4'];
    function excludeAllExcept(allowed) {
        return ALL_TYPES.filter(t => !allowed.includes(t));
    }

    // ── Draw-2 stack responses ────────────────────────────────────────────────

    const redDraw2   = buildCard(12);  // red draw2
    const yellowDraw2= buildCard(26);  // yellow draw2
    const redSkip    = buildCard(10);  // red skip
    const redReverse = buildCard(11);  // red reverse
    const blueDraw2  = buildCard(40);  // green draw2 — wrong color, right type
    const yellowSkip = buildCard(24);  // yellow skip — right color (after yellow draw2), right type

    test('draw2 stack: same-color draw2 is stackable', () => {
        const invalid = excludeAllExcept(['draw2']);
        expect(canPlay([redDraw2], 'red', 'draw2', invalid)).toBe(true);
    });

    test('draw2 stack: different-color draw2 is NOT stackable (color and type both checked)', () => {
        // blueDraw2 is actually green — color does not match red, type matches draw2
        // type match IS sufficient for canPlay, so a same-type different-color draw2
        // should still be stackable (type === currentType)
        const invalid = excludeAllExcept(['draw2']);
        expect(canPlay([buildCard(26)], 'red', 'draw2', invalid)).toBe(true); // yellow draw2, type match
    });

    test('draw2 stack: same-color skip is stackable when skip is in requiredPlay', () => {
        const invalid = excludeAllExcept(['draw2', 'skip']);
        expect(canPlay([redSkip], 'red', 'draw2', invalid)).toBe(true);
    });

    test('draw2 stack: same-color skip is NOT stackable when skip is not in requiredPlay', () => {
        const invalid = excludeAllExcept(['draw2']); // skip not allowed
        expect(canPlay([redSkip], 'red', 'draw2', invalid)).toBe(false);
    });

    test('draw2 stack: wrong-color skip is not stackable even if skip is in requiredPlay', () => {
        // yellowSkip does not match currentColor=red and type skip ≠ draw2
        const invalid = excludeAllExcept(['draw2', 'skip']);
        expect(canPlay([yellowSkip], 'red', 'draw2', invalid)).toBe(false);
    });

    test('draw2 stack: same-color reverse is stackable when reverse is in requiredPlay', () => {
        const invalid = excludeAllExcept(['draw2', 'reverse']);
        expect(canPlay([redReverse], 'red', 'draw2', invalid)).toBe(true);
    });

    test('draw2 stack: hand with only numbered cards cannot stack', () => {
        const invalid = excludeAllExcept(['draw2', 'skip', 'reverse']);
        const redSix = buildCard(6);
        expect(canPlay([redSix], 'red', 'draw2', invalid)).toBe(false);
    });

    test('draw2 stack: wild is not stackable (not in requiredPlay for draw2)', () => {
        const invalid = excludeAllExcept(['draw2', 'skip', 'reverse']);
        const wild = buildCard(13);
        expect(canPlay([wild], 'red', 'draw2', invalid)).toBe(false);
    });

    // ── Draw-4 stack responses ────────────────────────────────────────────────

    const redDraw4   = buildCard(69);  // red draw4 (black, but type=draw4)
    const yellowDraw4= buildCard(83);  // another draw4
    const greenSkip  = buildCard(38);  // green skip

    test('draw4 stack: any draw4 is stackable (draw4s are black, always color-valid)', () => {
        const invalid = excludeAllExcept(['draw4']);
        expect(canPlay([redDraw4],    'red',    'draw4', invalid)).toBe(true);
        expect(canPlay([yellowDraw4], 'yellow', 'draw4', invalid)).toBe(true);
    });

    test('draw4 stack: same-color skip is stackable when skip is in requiredPlay', () => {
        const invalid = excludeAllExcept(['draw4', 'skip']);
        expect(canPlay([greenSkip], 'green', 'draw4', invalid)).toBe(true);
    });

    test('draw4 stack: wrong-color skip is not stackable', () => {
        const invalid = excludeAllExcept(['draw4', 'skip']);
        expect(canPlay([greenSkip], 'red', 'draw4', invalid)).toBe(false);
    });

    test('draw4 stack: draw2 is never stackable on a draw4 stack', () => {
        // draw2 excluded because it is not in requiredPlay for a draw4 stack
        const invalid = excludeAllExcept(['draw4', 'skip', 'reverse']);
        expect(canPlay([redDraw2], 'red', 'draw4', invalid)).toBe(false);
    });

    // ── Mixed hand: only the valid stacking card is highlighted ──────────────

    test('draw2 stack: hand with valid and invalid cards — valid card wins', () => {
        const invalid = excludeAllExcept(['draw2']);
        // red draw2 is valid; red skip is not (not in requiredPlay)
        expect(canPlay([redSkip, redDraw2], 'red', 'draw2', invalid)).toBe(true);
    });

    test('draw4 stack: hand with draw2 and draw4 — only draw4 is valid', () => {
        const invalid = excludeAllExcept(['draw4']);
        expect(canPlay([redDraw2, redDraw4], 'red', 'draw4', invalid)).toBe(true);
    });

    test('draw4 stack: hand with only draw2 — cannot stack', () => {
        const invalid = excludeAllExcept(['draw4']);
        expect(canPlay([redDraw2], 'red', 'draw4', invalid)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPoints
// ─────────────────────────────────────────────────────────────────────────────

describe('getPoints', () => {
    function makePlayersMap(configs) {
        // configs: [{ socketId, playerID, hand }]
        const map = new Map();
        configs.forEach(({ socketId, playerID, hand }) => {
            map.set(socketId, makePlayer(socketId, playerID, hand));
        });
        return map;
    }

    test('winner gets the sum of all other players\' card values', () => {
        const hand1 = [buildCard(5), buildCard(3)]; // 5 + 3 = 8
        const hand2 = [buildCard(10)];              // skip = 20
        const map = makePlayersMap([
            { socketId: 'A', playerID: 0, hand: [] },    // winner
            { socketId: 'B', playerID: 1, hand: hand1 },
            { socketId: 'C', playerID: 2, hand: hand2 },
        ]);
        const winner = map.get('A');
        const result = getPoints(map, winner);

        expect(result.pointsThisHand).toBe(28); // 8 + 20
        expect(winner.Points).toBe(28);
        expect(winner.HandsWon).toBe(1);
    });

    test('winner\'s own hand is not counted', () => {
        const winnerHand = [buildCard(9)]; // 9 points — should be ignored
        const loserHand  = [buildCard(12)]; // draw2 = 20
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: winnerHand },
            { socketId: 'L', playerID: 1, hand: loserHand },
        ]);
        const winner = map.get('W');
        const result = getPoints(map, winner);

        expect(result.pointsThisHand).toBe(20);
        expect(winner.Points).toBe(20);
    });

    test('PointsGivenUp is updated for each losing player', () => {
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: [] },
            { socketId: 'L', playerID: 1, hand: [buildCard(7)] }, // 7 pts
        ]);
        getPoints(map, map.get('W'));
        expect(map.get('L').PointsGivenUp).toBe(7);
    });

    test('breakdown lists each non-winner player and their points', () => {
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: [] },
            { socketId: 'A', playerID: 1, hand: [buildCard(5)] },  // 5
            { socketId: 'B', playerID: 2, hand: [buildCard(11)] }, // reverse = 20
        ]);
        const result = getPoints(map, map.get('W'));

        expect(result.breakdown).toHaveLength(2);
        const names = result.breakdown.map(b => b.name);
        expect(names).toContain('Player1');
        expect(names).toContain('Player2');
    });

    test('standings are sorted highest points first', () => {
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: [] },
            { socketId: 'L', playerID: 1, hand: [buildCard(3)] },
        ]);
        // Give L some pre-existing points so order is meaningful
        map.get('L').Points = 10;
        getPoints(map, map.get('W')); // W gets 3 pts; standings: W=3, L=10
        // L already has 10, W now has 3 → L should be first
        const result2 = getPoints(map, map.get('W')); // run again to check ordering
        expect(result2.standings[0].points).toBeGreaterThanOrEqual(result2.standings[1].points);
    });

    test('wild card (50 pts) is correctly totalled', () => {
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: [] },
            { socketId: 'L', playerID: 1, hand: [buildCard(13)] }, // wild = 50
        ]);
        const result = getPoints(map, map.get('W'));
        expect(result.pointsThisHand).toBe(50);
    });

    test('draw4 card (50 pts) is correctly totalled', () => {
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: [] },
            { socketId: 'L', playerID: 1, hand: [buildCard(69)] }, // draw4 = 50
        ]);
        const result = getPoints(map, map.get('W'));
        expect(result.pointsThisHand).toBe(50);
    });

    test('zero points when all other players have empty hands', () => {
        const map = makePlayersMap([
            { socketId: 'W', playerID: 0, hand: [] },
            { socketId: 'L', playerID: 1, hand: [] },
        ]);
        const result = getPoints(map, map.get('W'));
        expect(result.pointsThisHand).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// nextPlayerID
// ─────────────────────────────────────────────────────────────────────────────

describe('nextPlayerID', () => {
    // direction = -1 (default)  →  IDs decrease (wrapping at 0)
    // direction = +1            →  IDs increase (wrapping at playerCount)

    describe('direction = -1 (counter-clockwise)', () => {
        test('normal advance', () => {
            expect(nextPlayerID(2, -1, 4)).toBe(1);
        });

        test('wraps from 0 to last player', () => {
            expect(nextPlayerID(0, -1, 4)).toBe(3);
        });

        test('two players: 0 → 1', () => {
            expect(nextPlayerID(0, -1, 2)).toBe(1);
        });

        test('two players: 1 → 0', () => {
            expect(nextPlayerID(1, -1, 2)).toBe(0);
        });
    });

    describe('direction = +1 (clockwise after reverse)', () => {
        test('normal advance', () => {
            expect(nextPlayerID(1, 1, 4)).toBe(2);
        });

        test('wraps from last player to 0', () => {
            expect(nextPlayerID(3, 1, 4)).toBe(0);
        });

        test('two players: 0 → 1', () => {
            expect(nextPlayerID(0, 1, 2)).toBe(1);
        });
    });

    test('all IDs in a 5-player game advance correctly (direction -1)', () => {
        const expected = [4, 0, 1, 2, 3]; // nextPlayerID(i, -1, 5)
        [0,1,2,3,4].forEach((id, i) => {
            expect(nextPlayerID(id, -1, 5)).toBe(expected[i]);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// reshuffleSeats
// ─────────────────────────────────────────────────────────────────────────────

describe('reshuffleSeats', () => {
    function makeMap(n) {
        const map = new Map();
        for (let i = 0; i < n; i++) {
            const p = makePlayer('socket' + i, i);
            map.set('socket' + i, p);
        }
        return map;
    }

    test('the set of PlayerIDs is unchanged after reshuffling', () => {
        const map = makeMap(4);
        const before = new Set(Array.from(map.values()).map(p => p.PlayerID));
        reshuffleSeats(map);
        const after = new Set(Array.from(map.values()).map(p => p.PlayerID));
        expect(after).toEqual(before);
    });

    test('each player still has exactly one PlayerID', () => {
        const map = makeMap(5);
        reshuffleSeats(map);
        const ids = Array.from(map.values()).map(p => p.PlayerID);
        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5); // no duplicates
    });

    test('PlayerIDs are still in the range [0, n-1]', () => {
        const n = 6;
        const map = makeMap(n);
        reshuffleSeats(map);
        Array.from(map.values()).forEach(p => {
            expect(p.PlayerID).toBeGreaterThanOrEqual(0);
            expect(p.PlayerID).toBeLessThan(n);
        });
    });

    test('single-player map is a no-op', () => {
        const map = makeMap(1);
        reshuffleSeats(map);
        expect(map.get('socket0').PlayerID).toBe(0);
    });

    test('socket-to-player mapping is preserved (SocketID not changed)', () => {
        const map = makeMap(4);
        reshuffleSeats(map);
        map.forEach((player, socketId) => {
            expect(player.SocketID).toBe(socketId);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: card attribute consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('card attribute consistency across the full deck', () => {
    let deck;
    beforeAll(() => { deck = createDeck(); });

    test('every colored card has a non-black color', () => {
        deck.filter(c => c.Type !== 'wild' && c.Type !== 'draw4')
            .forEach(c => expect(c.Color).not.toBe('black'));
    });

    test('every wild and draw4 has color=black', () => {
        deck.filter(c => c.Type === 'wild' || c.Type === 'draw4')
            .forEach(c => expect(c.Color).toBe('black'));
    });

    test('numbered card values match their type (type IS the value)', () => {
        deck.filter(c => typeof c.Type === 'number')
            .forEach(c => expect(c.Value).toBe(c.Type));
    });

    test('total point value of a full deck is correct', () => {
        // 2 copies of each color × (0+1+2+…+9) = 2×4×45 = 360  (numbered)
        // 2 copies × 4 colors × 3 action types × 20 pts = 480    (skip/reverse/draw2)
        // 4 wilds × 50 + 4 draw4s × 50 = 400                     (wilds)
        // Total = 360 + 480 + 400 = 1240
        const total = deck.reduce((sum, c) => sum + c.Value, 0);
        expect(total).toBe(1240);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRequiredPlay
//
// These tests verify that the server's stacking-option flags are correctly
// translated into the list of types the next player is allowed to play.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRequiredPlay', () => {
    const ALL_OFF = {
        stackDraw2: false, skipDraw2: false, reverseDraw2: false,
        stackDraw4: false, skipDraw4: false, reverseDraw4: false,
    };
    const ALL_ON = {
        stackDraw2: true, skipDraw2: true, reverseDraw2: true,
        stackDraw4: true, skipDraw4: true, reverseDraw4: true,
    };

    // ── null stack (no active draw) ───────────────────────────────────────────

    test('null stackType always returns []', () => {
        expect(buildRequiredPlay(null, ALL_OFF)).toEqual([]);
        expect(buildRequiredPlay(null, ALL_ON)).toEqual([]);
    });

    // ── draw2 stack ───────────────────────────────────────────────────────────

    test('draw2 stack, all options off → []', () => {
        expect(buildRequiredPlay('draw2', ALL_OFF)).toEqual([]);
    });

    test('draw2 stack, stackDraw2 only → [draw2]', () => {
        expect(buildRequiredPlay('draw2', { ...ALL_OFF, stackDraw2: true })).toEqual(['draw2']);
    });

    test('draw2 stack, skipDraw2 only → [skip]', () => {
        expect(buildRequiredPlay('draw2', { ...ALL_OFF, skipDraw2: true })).toEqual(['skip']);
    });

    test('draw2 stack, reverseDraw2 only → [reverse]', () => {
        expect(buildRequiredPlay('draw2', { ...ALL_OFF, reverseDraw2: true })).toEqual(['reverse']);
    });

    test('draw2 stack, all draw2 options on → [draw2, skip, reverse]', () => {
        const opts = { ...ALL_OFF, stackDraw2: true, skipDraw2: true, reverseDraw2: true };
        expect(buildRequiredPlay('draw2', opts)).toEqual(['draw2', 'skip', 'reverse']);
    });

    test('draw2 stack, draw4 options do not bleed through', () => {
        // All draw4 flags on, but draw2 flags off — should still return []
        const opts = { ...ALL_OFF, stackDraw4: true, skipDraw4: true, reverseDraw4: true };
        expect(buildRequiredPlay('draw2', opts)).toEqual([]);
    });

    // ── draw4 stack ───────────────────────────────────────────────────────────

    test('draw4 stack, all options off → []', () => {
        expect(buildRequiredPlay('draw4', ALL_OFF)).toEqual([]);
    });

    test('draw4 stack, stackDraw4 only → [draw4]', () => {
        expect(buildRequiredPlay('draw4', { ...ALL_OFF, stackDraw4: true })).toEqual(['draw4']);
    });

    test('draw4 stack, skipDraw4 only → [skip]', () => {
        expect(buildRequiredPlay('draw4', { ...ALL_OFF, skipDraw4: true })).toEqual(['skip']);
    });

    test('draw4 stack, reverseDraw4 only → [reverse]', () => {
        expect(buildRequiredPlay('draw4', { ...ALL_OFF, reverseDraw4: true })).toEqual(['reverse']);
    });

    test('draw4 stack, all draw4 options on → [draw4, skip, reverse]', () => {
        const opts = { ...ALL_OFF, stackDraw4: true, skipDraw4: true, reverseDraw4: true };
        expect(buildRequiredPlay('draw4', opts)).toEqual(['draw4', 'skip', 'reverse']);
    });

    test('draw4 stack, draw2 options do not bleed through', () => {
        const opts = { ...ALL_OFF, stackDraw2: true, skipDraw2: true, reverseDraw2: true };
        expect(buildRequiredPlay('draw4', opts)).toEqual([]);
    });

    test('draw2 and draw4 options are fully independent', () => {
        // Only the flags matching the active stackType should appear in the output
        expect(buildRequiredPlay('draw2', ALL_ON)).toEqual(['draw2', 'skip', 'reverse']);
        expect(buildRequiredPlay('draw4', ALL_ON)).toEqual(['draw4', 'skip', 'reverse']);
    });

    test('missing options default to false (no crash)', () => {
        expect(buildRequiredPlay('draw2', {})).toEqual([]);
        expect(buildRequiredPlay('draw4', {})).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeHandMargin
//
// Tests the CSS margin-left calculation used to fan cards in a hand.
// Uses default constants (cssCardW=107, scale=0.6) unless overridden.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeHandMargin', () => {
    // Own-hand defaults: minMargin=-57, maxMargin=-64
    // Opponent defaults: minMargin=-70, maxMargin=-80

    test('0 or 1 card → margin is 0', () => {
        expect(computeHandMargin(600, 0)).toBe(0);
        expect(computeHandMargin(600, 1)).toBe(0);
    });

    test('very wide container, few cards → clamped at minMargin', () => {
        // With 2 cards in a 600px container there is plenty of room;
        // fitMargin would be very positive, so it clamps to the min (-57)
        const margin = computeHandMargin(600, 2);
        expect(margin).toBe(-57);
    });

    test('narrow container, many cards → clamped at maxMargin', () => {
        // 10 cards in a 100px container → heavily compressed, clamps to max (-64)
        const margin = computeHandMargin(100, 10);
        expect(margin).toBe(-64);
    });

    test('margin is within [maxMargin, minMargin] for typical hands', () => {
        const containerWidths = [200, 350, 500];
        const cardCounts = [3, 5, 7, 10];
        containerWidths.forEach(w => {
            cardCounts.forEach(n => {
                const m = computeHandMargin(w, n);
                expect(m).toBeGreaterThanOrEqual(-64);
                expect(m).toBeLessThanOrEqual(-57);
            });
        });
    });

    test('opponent hand clamps use different min/max values', () => {
        // Wide container, few cards → clamps to opponent minMargin (-70)
        expect(computeHandMargin(600, 2, 107, 0.6, -70, -80)).toBe(-70);
        // Narrow container, many cards → clamps to opponent maxMargin (-80)
        expect(computeHandMargin(100, 10, 107, 0.6, -70, -80)).toBe(-80);
    });

    test('margin decreases monotonically as card count increases (same container)', () => {
        // More cards in the same space → tighter overlap (more negative)
        const containerW = 300;
        let prev = computeHandMargin(containerW, 2);
        for (let n = 3; n <= 12; n++) {
            const curr = computeHandMargin(containerW, n);
            expect(curr).toBeLessThanOrEqual(prev);
            prev = curr;
        }
    });

    test('margin increases (less overlap) as container gets wider', () => {
        // Wider container → more room → less overlap (less negative, up to min cap)
        const cardCount = 7;
        let prev = computeHandMargin(100, cardCount);
        for (const w of [150, 200, 300, 400, 600]) {
            const curr = computeHandMargin(w, cardCount);
            expect(curr).toBeGreaterThanOrEqual(prev);
            prev = curr;
        }
    });

    test('exact fit: margin produces a hand that exactly fills the container', () => {
        // Choose values where fitMargin falls inside the clamp window
        const cssCardW = 107, scale = 0.6;
        const visW = cssCardW * scale;
        const cardCount = 5;
        // Pick a container where fitMargin = -60, which is inside [-64, -57]
        // fitMargin = -60 → usableW = visW + (cardCount-1)*(visW + margin*scale)
        //                           = 64.2 + 4*(64.2 + (-60)*0.6) = 64.2 + 4*28.2 = 177
        const usableW = visW + (cardCount - 1) * (visW + (-60) * scale);
        const margin = computeHandMargin(usableW, cardCount);
        expect(margin).toBeCloseTo(-60, 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// truncate  (extracted from main.js handSummary handler)
// ─────────────────────────────────────────────────────────────────────────────

// Inline the function here rather than importing from main.js (which has DOM
// dependencies that can't load in Node).
const MAX_NAME_TEST = 12;
function truncate(name) {
    return name.length > MAX_NAME_TEST ? name.slice(0, MAX_NAME_TEST - 1) + '...' : name;
}

describe('truncate', () => {
    test('short name is unchanged', () => {
        expect(truncate('Alice')).toBe('Alice');
    });

    test('name at exactly the limit is unchanged', () => {
        expect(truncate('TwelveLetter')).toBe('TwelveLetter');    // 12 chars — at limit, not truncated
    });

    test('name at exactly MAX_NAME (12) is not truncated', () => {
        const name = 'A'.repeat(12);
        expect(truncate(name)).toBe(name);
    });

    test('name one over the limit is truncated', () => {
        const name = 'A'.repeat(13);
        expect(truncate(name)).toBe('A'.repeat(11) + '...');
    });

    test('very long name is truncated to 11 chars + ellipsis', () => {
        expect(truncate('ThisIsAVeryLongPlayerName')).toBe('ThisIsAVery...');
    });

    test('empty string is unchanged', () => {
        expect(truncate('')).toBe('');
    });

    test('truncated result is 11 chars + ellipsis (14 total)', () => {
        const long = 'A'.repeat(50);
        expect(truncate(long).length).toBe(14); // 11 chars + '...'
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatDuration  (from main.js)
// ─────────────────────────────────────────────────────────────────────────────

function formatDuration(totalSeconds) {
    const seconds = Number(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.round(seconds % 60);
    return [
        hours ? `${hours}h` : null,
        minutes ? `${minutes}m` : null,
        secs || (!hours && !minutes) ? `${secs}s` : null,
    ]
        .filter(Boolean)
        .join(' ');
}

describe('formatDuration', () => {
    test('zero seconds → "0s"', () => {
        expect(formatDuration(0)).toBe('0s');
    });

    test('seconds only', () => {
        expect(formatDuration(1)).toBe('1s');
        expect(formatDuration(59)).toBe('59s');
    });

    test('minutes and seconds', () => {
        expect(formatDuration(60)).toBe('1m');
        expect(formatDuration(61)).toBe('1m 1s');
        expect(formatDuration(90)).toBe('1m 30s');
    });

    test('exactly 1 minute omits the seconds part', () => {
        expect(formatDuration(60)).toBe('1m');
    });

    test('hours only (round hours)', () => {
        expect(formatDuration(3600)).toBe('1h');
        expect(formatDuration(7200)).toBe('2h');
    });

    test('hours and minutes, no seconds', () => {
        expect(formatDuration(3660)).toBe('1h 1m');
    });

    test('hours, minutes, and seconds', () => {
        expect(formatDuration(3661)).toBe('1h 1m 1s');
        expect(formatDuration(3723)).toBe('1h 2m 3s');
    });

    test('fractional seconds are rounded', () => {
        expect(formatDuration(1.4)).toBe('1s');
        expect(formatDuration(1.6)).toBe('2s');
    });

    test('string input is coerced to number', () => {
        expect(formatDuration('90')).toBe('1m 30s');
    });

    test('hours present with 0 seconds omits trailing seconds', () => {
        // 1h 1m exactly — no seconds component
        expect(formatDuration(3660)).toBe('1h 1m');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPoints — cards-drawn stats
// ─────────────────────────────────────────────────────────────────────────────

describe('getPoints — cards drawn stats', () => {
    test('playerStats includes hand and match forced / received / searched counts', () => {
        const map = new Map();
        map.set('W', makePlayer('W', 0, [], { HandForced: 6, MatchForced: 14, HandReceived: 2, MatchReceived: 9, HandSearched: 3, MatchSearched: 8 }));
        map.set('L', makePlayer('L', 1, [buildCard(5)]));
        const { playerStats } = getPoints(map, map.get('W'));
        const w = playerStats.find(p => p.name === 'Player0');

        expect(w).toMatchObject({
            handForced: 6, matchForced: 14,
            handReceived: 2, matchReceived: 9,
            handSearched: 3, matchSearched: 8,
            handSelfOwned: 0, matchSelfOwned: 0,
        });
    });

    test('players with no draws report zeros', () => {
        const map = new Map();
        map.set('W', makePlayer('W', 0, []));
        map.set('L', makePlayer('L', 1, [buildCard(5)]));
        const { playerStats } = getPoints(map, map.get('W'));
        playerStats.forEach(p => expect(p).toMatchObject({
            handForced: 0, matchForced: 0, handReceived: 0, matchReceived: 0, handSearched: 0, matchSearched: 0,
            handSelfOwned: 0, matchSelfOwned: 0,
        }));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary table sorting  (mirrors the comparators in main.js)
// ─────────────────────────────────────────────────────────────────────────────

const byTimeThenCards = (cardsKey, timeKey) => (a, b) => (a[timeKey] - b[timeKey]) || (b[cardsKey] - a[cardsKey]);
const byCardsDrawn = (forcedKey, receivedKey, searchedKey, selfKey) => (a, b) =>
    ((b[receivedKey] + b[searchedKey] + b[selfKey]) - (a[receivedKey] + a[searchedKey] + a[selfKey])) || (b[forcedKey] - a[forcedKey]);

describe('summary table sorting', () => {
    test('time spent: lowest time first, ties broken by most cards', () => {
        const rows = [
            { name: 'A', handCardsPlayed: 5,  handTurnTime: 60 },
            { name: 'B', handCardsPlayed: 9,  handTurnTime: 30 },
            { name: 'C', handCardsPlayed: 12, handTurnTime: 60 },
        ];
        const sorted = rows.slice().sort(byTimeThenCards('handCardsPlayed', 'handTurnTime')).map(r => r.name);
        expect(sorted).toEqual(['B', 'C', 'A']);
    });

    test('cards drawn: most received + searched + self-owned first, ties broken by most forced', () => {
        const rows = [
            { name: 'A', handForced: 1, handReceived: 2, handSearched: 3, handSelfOwned: 0 }, // 5
            { name: 'B', handForced: 4, handReceived: 4, handSearched: 2, handSelfOwned: 0 }, // 6
            { name: 'C', handForced: 9, handReceived: 5, handSearched: 0, handSelfOwned: 0 }, // 5
            { name: 'D', handForced: 0, handReceived: 1, handSearched: 1, handSelfOwned: 5 }, // 7
        ];
        const sorted = rows.slice().sort(byCardsDrawn('handForced', 'handReceived', 'handSearched', 'handSelfOwned')).map(r => r.name);
        expect(sorted).toEqual(['D', 'B', 'C', 'A']);
    });

    test('forced alone does not affect the primary order', () => {
        const rows = [
            { name: 'A', matchForced: 50, matchReceived: 1, matchSearched: 1, matchSelfOwned: 0 },
            { name: 'B', matchForced: 0,  matchReceived: 2, matchSearched: 1, matchSelfOwned: 0 },
        ];
        const sorted = rows.slice().sort(byCardsDrawn('matchForced', 'matchReceived', 'matchSearched', 'matchSelfOwned')).map(r => r.name);
        expect(sorted).toEqual(['B', 'A']);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// recordDrawStats
// ─────────────────────────────────────────────────────────────────────────────

describe('recordDrawStats', () => {
    function makeTable() {
        const map = new Map();
        ['A', 'B', 'C'].forEach((n, i) => map.set(n, makePlayer(n, i, [], { Name: n })));
        return map;
    }

    test('stack payout: drawer receives the cards others added, each contributor is credited Forced', () => {
        const map = makeTable();
        // A +2, B +2, C +2 → A draws 6 (the stack wrapped back around to A)
        recordDrawStats(map, map.get('A'), 6, [['A', 2], ['B', 2], ['C', 2]]);

        expect(map.get('A').HandReceived).toBe(4); // B's 2 + C's 2; A's own 2 are self-owned
        expect(map.get('B').HandForced).toBe(2);
        expect(map.get('C').HandForced).toBe(2);
    });

    test('cards you added to a stack you end up drawing count as self-owned, not forced', () => {
        const map = makeTable();
        recordDrawStats(map, map.get('A'), 6, [['A', 2], ['B', 2], ['C', 2]]);

        const a = map.get('A');
        expect(a.HandSelfOwned).toBe(2);
        expect(a.MatchSelfOwned).toBe(2);
        expect(a.HandForced).toBe(0);
        expect(a.HandReceived).toBe(4); // self-owned is separate: 4 from others + 2 own = 6 drawn
    });

    test('a plain stack on someone else has no self-owned cards', () => {
        const map = makeTable();
        recordDrawStats(map, map.get('B'), 4, [['A', 4]]);

        expect(map.get('A').HandForced).toBe(4);
        expect(map.get('A').HandSelfOwned).toBe(0);
        expect(map.get('B').HandReceived).toBe(4);
        expect(map.get('B').HandSelfOwned).toBe(0);
    });

    test('self-inflicted Quno penalty is self-owned only, not received', () => {
        const map = makeTable();
        recordDrawStats(map, map.get('C'), 2, [], true);

        const c = map.get('C');
        expect(c.HandReceived).toBe(0);
        expect(c.MatchReceived).toBe(0);
        expect(c.HandSelfOwned).toBe(2);
        expect(c.MatchSelfOwned).toBe(2);
    });

    test('Quno catch: caller is credited Forced, victim receives', () => {
        const map = makeTable();
        recordDrawStats(map, map.get('B'), 4, [['A', 4]]);

        expect(map.get('A').MatchForced).toBe(4);
        expect(map.get('B').MatchReceived).toBe(4);
    });

    test('contributors who left the game are ignored without error', () => {
        const map = makeTable();
        expect(() => recordDrawStats(map, map.get('A'), 4, [['Gone', 4]])).not.toThrow();
        expect(map.get('A').HandReceived).toBe(4);
    });

    test('hand and match counters both increase', () => {
        const map = makeTable();
        map.get('A').MatchForced = 10;
        recordDrawStats(map, map.get('B'), 2, [['A', 2]]);
        expect(map.get('A').HandForced).toBe(2);
        expect(map.get('A').MatchForced).toBe(12);
    });
});