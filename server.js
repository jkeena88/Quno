const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
const port = process.env.PORT || 3000;

app.use(express.static(__dirname + '/public', { 'Content-Type': 'application/javascript' }));
io.on('connection', onConnection);
server.listen(port, () => console.log('listening on port ' + port));

const maxPlayers = 8;
var playDirection = 1;
var currentPlayer;
var currentColor;
var currentType;
var cardsToDraw = 0;
var discardPile = new Array();
let players = new Map();
let playersInLobby = new Array();
let deck = new Array();
let playerA = null;
let playWildDraw4 = false;
let stackDraw2 = false;
let skipDraw2 = false;
let reverseDraw2 = false;
let stackDraw4 = false;
let gameIsOver = false;
let cardList = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'skip', 'reverse', 'draw2', 'wild', 'draw4']
let requiredPlay = new Array();


/**
 * Whenever a client connects
 * @function
 * @param {Socket} socket Client socket
 */
function onConnection(socket) {

    // If there's no primary player, make the new player primary
    if(playerA == null) {
        playerA = socket.id;
        io.to(socket.id).emit('isPlayerA');
    }

    // Remove a player if they leave
    socket.on('disconnect', () => {
        if(socket.id == playerA) {
            playerA = null;
        }
        playersInLobby = playersInLobby.filter(player => player !== socket.playerName);
        io.emit('newPlayer', playersInLobby);
    });

    /**
     * Whenever a room is requested, looks for a slot for the player,
     * up to 8 players in a room
     * @method
     * @param {String} playerName Player name
     * @return responseRoom and # of players if there's an open slot, otherwise error.
     */
    socket.on('requestJoin', function(playerName) {
        socket.playerName = playerName;
        let people;
        try {
            people = io.engine.clientsCount;
        } catch (e) {
            people = 0;
        }

        // Add the player to the game if there's enough room
        if(people < maxPlayers) {
            socket.join();
            playersInLobby.push(playerName);
            io.to(socket.id).emit('responseRoom', [people + 1, maxPlayers]);
            io.emit('newPlayer', playersInLobby);
            io.emit('logMessage', playerName + ' joined the game');

            return;
        } else {
            // Room is full, send an error
            io.to(socket.id).emit('responseRoom', 'error');
        }
    });

    socket.on('resetGame', function() {
        // Start a new match if there's more than 1 player
        var playerCount = io.engine.clientsCount;

        if(playerCount > 1) {
            io.emit('logMessage', 'A new match was started');
            createPlayers();
            startGame();
        }
    });

    socket.on('newHand', function() {
        // Deal a new hand without resetting the players
        io.emit('logMessage', 'A new hand was dealt');
        startGame();
    });

    socket.on('playCard', function(card) {
        // Attempt to play a card
        let playColor = card.Color;
        let playType = card.Type;

        // Only let someone play if it's their turn
        if(socket.id == currentPlayer) {

            let colorMatch = (playColor == currentColor && playColor != 'black');
            let typeMatch = (playType == currentType && playColor != 'black');
            let wild = (playType == 'wild');

            if(playWildDraw4) {
                // If 'play draw 4 any time' is enabled, let them play it
                var draw4wild = (playType == 'draw4');
            } else {
                // If 'play draw 4 any time' is disabled, make sure it's their only playable card first
                var draw4wild = (playType == 'draw4' && !canPlay(currentPlayer, ['draw4']));
            }

            // Let them play if they have the right color or card value, or if it's a wild
            // In some scenarios, like stacking draw 2s, there's another check to see if there's a certain requirement for the next play
            if((colorMatch || typeMatch || wild || draw4wild) && (requiredPlay.length == 0 || requiredPlay.includes(playType))) {
                requiredPlay = new Array();
                discardCard(card, socket.id);
                io.emit('hideColor');
                io.emit('logMessage', socket.playerName + ' played a ' + playColor + ' ' + playType);

                // See if the player won after playing their card
                checkForWin(socket.id);

                if(playType == 'wild') {
                    // Wild - have the player choose a new color
                    io.to(socket.id).emit('chooseColor');
                } else if(playType == 'draw4') {
                    // Wild draw 4 - queue up 4 more cards to be drawn, then have the player choose a new color
                    cardsToDraw += 4;
                    io.to(socket.id).emit('chooseColor');
                } else if(playType == 'skip') {
                    // Skip - jump over the next player
                    nextTurn();

                    // If there are cards remaining to be drawn (e.g. a skip was played on a draw 2) then draw those cards
                    drawCard(currentPlayer, cardsToDraw);
                    nextTurn();
                } else if(playType == 'reverse') {
                    // Reverse - change the direction of play
                    playDirection = -playDirection;
                    nextTurn();

                    // If there are cards remaining to be drawn (e.g. a reverse was played on a draw 2) then draw those cards
                    if(cardsToDraw > 0) {
                        drawCard(currentPlayer, cardsToDraw);
                        nextTurn();
                    }
                } else if(playType == 'draw2') {
                    // Draw 2 - queue up 2 more cards to be drawn
                    cardsToDraw += 2;
                    nextTurn();

                    // Check all the game options for playing on draw 2s
                    if(stackDraw2) {
                        requiredPlay.push('draw2');
                    }

                    if(skipDraw2) {
                        requiredPlay.push('skip');
                    }

                    if(reverseDraw2) {
                        requiredPlay.push('reverse');
                    }

                    // See whether the next player has any cards they can stack
                    let tempArray = cardList.filter(item => !requiredPlay.includes(item));

                    if(!canPlay(currentPlayer, tempArray)) {
                        drawCard(currentPlayer, cardsToDraw);
                        nextTurn();
                    }
                } else {
                    // Any numbered card - just move to the next turn
                    nextTurn();
                }
            }
        }
    });

    socket.on('drawCard', function() {
        // Draw a card
        drawCard(socket.id, 1);
    });

    socket.on('colorChosen', function(color) {
        // A new color was chosen
        io.emit('colorChosen', color);
        currentColor = color;
        io.emit('logMessage', 'The color was changed to ' + color);
        nextTurn();
        
        // For handling wild draw 4
        if(cardsToDraw > 0) {

            // Let the player stack a draw 4 if they can
            if(stackDraw4) {
                requiredPlay.push('draw4');
            }

            let tempArray = cardList.filter(item => !requiredPlay.includes(item));

            if(!canPlay(currentPlayer, tempArray)) {
                drawCard(currentPlayer, cardsToDraw);
                nextTurn();
            }
        }
    });

    socket.on('unoMe', function() {
        // Player called Uno
        let player = players.get(socket.id);

        // Only let them call it if it's their turn and they have 2 cards, or if it's not their turn and they have 1 card
        if((player.Hand.length <= 2 && socket.id == currentPlayer) || player.Hand.length == 1) {
            player.HasCalledUno = true;
            io.to(socket.id).emit('calledUnoMe');
            io.emit('logMessage', socket.playerName + ' called Uno');
        }
    });

    socket.on('unoYou', function() {
        // Player called Uno on someone else

        // Iterate through all players and see if they have 1 card + haven't called Uno
        players.forEach((player) => {
            if(player.Hand.length == 1 && player.HasCalledUno == false) {
                // Draw cards if they're caught
                io.emit('logMessage', player.Name + ' had Uno called on them');
                drawCard(player.SocketID, 4);
            };
        });
    });

    socket.on('saveOptions', (data) => {
        // Save the selected game options
        let selectedOptions = data.options;

        if(selectedOptions.includes('playWildDraw4')) {
            playWildDraw4 = true;
        } else {
            playWildDraw4 = false;
        }

        if(selectedOptions.includes('stackDraw2')) {
            stackDraw2 = true;
        } else {
            stackDraw2 = false;
        }

        if(selectedOptions.includes('skipDraw2')) {
            skipDraw2 = true;
        } else {
            skipDraw2 = false;
        }

        if(selectedOptions.includes('reverseDraw2')) {
            reverseDraw2 = true;
        } else {
            reverseDraw2 = false;
        }

        if(selectedOptions.includes('stackDraw4')) {
            stackDraw4 = true;
        } else {
            stackDraw4 = false;
        }
    });
}

function cardColor(card) {
    // Look up the card's color based on position in the sprite sheet
    let color;

    if(card % 14 === 13) {
        return 'black';
    }

    switch(Math.floor(card / 14)) {
        case 0:
        case 4:
            color = 'red';
            break;
        case 1:
        case 5:
            color = 'yellow';
            break;
        case 2:
        case 6:
            color = 'green';
            break;
        case 3:
        case 7:
            color = 'blue';
            break;
    }

    return color;
}

function cardType(card) {
    // Look up the card's type based on position in the sprite sheet
    switch(card % 14) {
        case 10: // Skip
            return 'skip';
        case 11: // Reverse
            return 'reverse';
        case 12: // Draw 2
            return 'draw2';
        case 13: // Wild or Wild Draw 4
            if(Math.floor(card / 14) >= 4) {
                return 'draw4';
            } else {
                return 'wild';
            }
        default:
            return card % 14;
    }
}

function cardValue(card) {
    // Look up the card's point value (for end-game scoring) based on position in the sprite sheet
    let points;
    switch(card % 14) {
        case 10: // Skip
        case 11: // Reverse
        case 12: // Draw 2
            points = 20;
            break;
        case 13: // Wild or Wild Draw 4
            points = 50;
            break;
        default:
            points = card % 14;
            break;
    }
    return points;
}

function createPlayers() {
    // Create new players
    players.clear();
    var i = 0;

    io.sockets.sockets.forEach((socket) => {
        var hand = new Array();
        var player = {Name: socket.playerName, PlayerID: i, Points: 0, Hand: hand, SocketID: socket.id, HasCalledUno: false};
        players.set(socket.id, player);
        i++;
    });
};

function createDeck() {
    // Create a new deck
    deck = new Array();

    for(var i = 0; i < 112; i++) {
        var color = cardColor(i);
        var type = cardType(i);
        var value = cardValue(i);

        var card = {'ID': i, 'Color': color, 'Type': type, 'Value': value};
        deck.push(card);
    }

    shuffle(deck);
}

function shuffle(deck) {
    // Shuffle the deck
    let i, j, temp;
    for(i = deck.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        temp = deck[i];
        deck[i] = deck[j];
        deck[j] = temp;
    }
}

function dealHands() {
    // Deal new cards to every player
    for(var i = 0; i < 7; i++) {
        players.forEach((player) => {
            var card = deck.pop();
            player.Hand.push(card);
            io.emit('renderCard', card, player);
        });
    }

    do {
        // Discard 1 card to start the game until we start on something other than a wild
        card = deck.pop();
        discardCard(card, -1);
    } while(currentColor == 'black')
}

function drawCard(SocketID, num) {
    // Draw card(s)
    let player = players.get(SocketID);

    // After drawing reset their Uno status
    player.HasCalledUno = false;
    io.to(SocketID).emit('notCalledUnoMe');

    var numRemaining = num;

    // Keep drawing as many cards as required
    while(numRemaining > 0) {
        if(deck.length < 1) { 
            // Reshuffle deck/dicard pile if the deck runs out
            var tempCard = discardPile.pop();
            deck = discardPile;
            discardPile = new Array();
            discardPile.push(tempCard);
            shuffle(deck);
        }

        if(players.has(SocketID)) {
            var card = deck.pop();
            let player = players.get(SocketID);
            
            player.Hand.push(card);
            numRemaining--;
            io.emit('renderCard', card, player);
        }
    }

    if(num > 0) {
        var label = ' cards';
        if(num == 1){
            label = ' card'
        }

        io.emit('logMessage', player.Name + ' drew ' + num + label);
        io.to(SocketID).emit('hideDraw');
    }

    // If the original # of cards to be drawn was 1 that means it was the player's turn and they had nothing to play
    // If they still can't play, draw another card
    if(num == 1) {
        let hasCard = canPlay(currentPlayer, ['none']);
        if(!hasCard) {
            io.to(currentPlayer).emit('canDrawCard');
        }
    }

    cardsToDraw = 0;
}

function checkForWin(SocketID) {
    // Check if the player won
    let player = players.get(SocketID);

    if(player.Hand.length == 0) {
        // They win if they have 0 cards left
        let player = players.get(currentPlayer);

        // Tally up points
        getPoints(players);

        // Let everyone know the game's over
        gameIsOver = true;
        io.emit('turnChange', -1);
        io.emit('gameOver', player.Name);
        io.emit('logMessage', player.Name + ' won the game');
    }
}

function getPoints(players) {
    // Tally up points
    var points = 0;

    // Count value of cards in each player's hand
    players.forEach((player) => {
        player.Hand.forEach((card) => {
            points += card.Value;
        });
    });

    // Update the scores
    var player = players.get(currentPlayer);
    player.Points += points;
    io.emit('updateScore', player.PlayerID, player.Points);
}

function discardCard(card, SocketID) {
    // Add a card to the discard pile

    let player;

    if(SocketID != -1) {
        // If it's a real player (e.g. not dealing a card to the discard pile) then remove the card from their hand
        player = players.get(SocketID);
        let cardIndex = player.Hand.findIndex(item => item.ID == card.ID);
        player.Hand.splice(cardIndex, 1);
    }

    // Add the card to the discard pile and update the game's current color/card type
    discardPile.push(card);
    currentColor = card.Color;
    currentType = card.Type;
    io.emit('discardCard', card, player);
}

function nextTurn() {
    if(!gameIsOver) {
        // Switch to the next player's turn
        let player = players.get(currentPlayer);
        var currentPlayerID = player.PlayerID;

        currentPlayerID += playDirection;

        // Players are numbered from 0 to n. Loop around if we iterate outside of the 0 to n range.
        if(currentPlayerID < 0) {
            currentPlayerID += players.size;
        } else if(currentPlayerID >= players.size) {
            currentPlayerID -= players.size;
        }

        players.forEach((nextPlayer) => {
            if(nextPlayer.PlayerID == currentPlayerID) {
                currentPlayer = nextPlayer.SocketID;
            }
        });

        // Draw a card if the next player can't play anything
        let hasCard = canPlay(currentPlayer, ['none']);
        if(!hasCard) {
            io.to(currentPlayer).emit('canDrawCard');
        }

        player = players.get(currentPlayer);

        // If the next player has 2 or fewer cards, let them call Uno
        if(player.Hand.length <= 2) {
            io.to(currentPlayer).emit('notCalledUnoMe');
        }

        requiredPlay = new Array();
        io.emit('turnChange', currentPlayerID);
    }
}

function canPlay(currentPlayer, invalidCards) {
    // Check if the player is able to play a card, excluding some invalidCards
    let player = players.get(currentPlayer);
    let hasCard = false;
    
    player.Hand.forEach((card) => {
        // Check every card in the hand
        let playColor = card.Color;
        let playType = card.Type;

        if(!invalidCards.includes(playType)) {
            // Make sure card isn't in the invalid list
            // If the card is wild or matches the current color or type, it's playable
            if(playColor == currentColor || playColor == 'black' || playType == currentType) {
                hasCard = true;
                return hasCard;
            }
        }
    })

    return hasCard;
}

function startGame() {
    // Start a new game

    // Reset some game variables
    gameIsOver = false;
    playDirection = 1;
    cardsToDraw = 0;
    discardPile = new Array();
    requiredPlay = new Array();
    io.emit('notCalledUnoMe');
    io.emit('colorChosen', 'red');
    io.emit('hideColor');
    io.emit('hideDraw');

    // Randomly select a new player to play first
    var currentPlayerID = Math.floor(Math.random() * players.size);

    // Reset each player's hand
    players.forEach((player) => {
        player.Hand = [];
        if(player.PlayerID == currentPlayerID) {
            currentPlayer = player.SocketID;
        }
    });

    // Tell everyone a new game is started, make a new deck, and deal new hands
    io.emit('gameStarted', Array.from(players.values()));
    createDeck();
    dealHands();

    // Check that the first player can play a card, or have them draw 1
    let hasCard = canPlay(currentPlayer, ['none']);
    if(!hasCard) {
        io.to(currentPlayer).emit('canDrawCard');
    }
    
    // Mark the first player as active
    io.emit('turnChange', currentPlayerID);
}
