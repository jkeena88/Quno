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
let cardList = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'skip', 'reverse', 'draw2', 'wild', 'draw4']
let requiredPlay = new Array();


/**
 * Whenever a client connects
 * @function
 * @param {Socket} socket Client socket
 */
function onConnection(socket) {

    if(playerA == null) {
        playerA = socket.id;
        io.to(socket.id).emit('isPlayerA');
    }

    socket.on('disconnect', () => {
        if(socket.id == playerA) {
            playerA = null;
        }
        playersInLobby = playersInLobby.filter(player => player !== socket.playerName);
        io.emit('newPlayer', playersInLobby);
    });

    /**
     * Whenever a room is requested, looks for a slot for the player,
     * up to 10 players in a room, maxRooms and started games are respected.
     * @method
     * @param {String} playerName Player name
     * @return responseRoom with name of the room, otherwise error.
     */
    socket.on('requestJoin', function(playerName) {
        socket.playerName = playerName;
        let people;
        try {
            people = io.engine.clientsCount;
        } catch (e) {
            people = 0;
        }

        if(people < maxPlayers) {
            socket.join();
            playersInLobby.push(playerName);
            io.to(socket.id).emit('responseRoom', [people + 1, maxPlayers]);
            io.emit('newPlayer', playersInLobby);

            return;
        } else {
            io.to(socket.id).emit('responseRoom', 'error');
        }
    });

    socket.on('resetGame', function() {
        var playerCount = io.engine.clientsCount;

        if(playerCount > 1) {
            createPlayers();
            startGame();
        }
    });

    socket.on('newHand', function() {
        startGame();
    });

    socket.on('playCard', function(card) {
        let playColor = cardColor(card);
        let playType = cardType(card);

        if(socket.id == currentPlayer) {

            let colorMatch = (playColor == currentColor && playColor != 'black');
            let typeMatch = (playType == currentType && playColor != 'black');
            let wild = (playType == 'wild');

            if(playWildDraw4) {
                var draw4wild = (playType == 'draw4');
            } else {
                var draw4wild = (playType == 'draw4' && !canPlay(currentPlayer, ['draw4']));
            }

            if((colorMatch || typeMatch || wild || draw4wild) && (requiredPlay.length == 0 || requiredPlay.includes(playType))) {
                requiredPlay = new Array();
                discardCard(card, socket.id);

                checkForWin(socket.id);

                io.emit('hideColor');
                
                if(playType == 'wild') {
                    io.to(socket.id).emit('chooseColor');
                } else if(playType == 'draw4') {
                    cardsToDraw += 4;
                    io.to(socket.id).emit('chooseColor');
                } else if(playType == 'skip') {
                    nextTurn();
                    drawCard(currentPlayer, cardsToDraw);
                    nextTurn();
                } else if(playType == 'reverse') {
                    playDirection = -playDirection;
                    nextTurn();

                    if(cardsToDraw > 0) {
                        drawCard(currentPlayer, cardsToDraw);
                        nextTurn();
                    }
                } else if(playType == 'draw2') {
                    cardsToDraw += 2;
                    nextTurn();

                    if(stackDraw2) {
                        requiredPlay.push('draw2');
                    }

                    if(skipDraw2) {
                        requiredPlay.push('skip');
                    }

                    if(reverseDraw2) {
                        requiredPlay.push('reverse');
                    }

                    let tempArray = cardList.filter(item => !requiredPlay.includes(item));

                    if(!canPlay(currentPlayer, tempArray)) {
                        drawCard(currentPlayer, cardsToDraw);
                        nextTurn();
                    }
                } else {
                    nextTurn();
                }
            }
        }
    });

    socket.on('drawCard', function() {
        drawCard(socket.id, 1);
    });

    socket.on('colorChosen', function(color) {
        io.emit('colorChosen', color);
        currentColor = color;
        nextTurn();
        
        if(cardsToDraw > 0) {

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
        let player = players.get(socket.id);

        if((player.Hand.length <= 2 && socket.id == currentPlayer) || player.Hand.length == 1) {
            player.HasCalledUno = true;
            io.to(socket.id).emit('calledUnoMe');
        }
    });

    socket.on('unoYou', function() {
        players.forEach((player) => {
            if(player.Hand.length == 1 && player.HasCalledUno == false) {
                drawCard(player.SocketID, 4);
            };
        });
    });

    socket.on('saveOptions', (data) => {
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
    deck = Array.from(Array(112), (_, i) => i);
    shuffle(deck);
}

function shuffle(deck) {
    let i, j, temp;
    for(i = deck.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        temp = deck[i];
        deck[i] = deck[j];
        deck[j] = temp;
    }
}

function dealHands() {
    for(var i = 0; i < 7; i++) {
        players.forEach((player) => {
            var card = deck.pop();
            player.Hand.push(card);
            io.emit('renderCard', card, player);
        });
    }

    do {
        card = deck.pop();
        discardCard(card, -1);
    } while(currentColor == 'black')
}

function drawCard(SocketID, num) {
    let player = players.get(SocketID);
    player.HasCalledUno = false;
    io.to(SocketID).emit('notCalledUnoMe');

    var numRemaining = num;

    while(numRemaining > 0) {
        if(deck.length < 1) { 
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

    if(num == 1) {
        let hasCard = canPlay(currentPlayer, ['none']);
        if(!hasCard) {
            io.to(currentPlayer).emit('canDrawCard');
        }
    }

    cardsToDraw = 0;
}

function checkForWin(SocketID) {
    let player = players.get(SocketID);

    if(player.Hand.length == 0) {
        let player = players.get(currentPlayer);
        var currentPlayerID = player.PlayerID;
        getPoints(players);
        io.emit('gameOver', player.Name);
        io.emit('notYourTurn', currentPlayerID);
    }
}

function getPoints(players) {
    var points = 0;

    players.forEach((player) => {
        player.Hand.forEach((card) => {
            points += cardValue(card);
        });
    });

    var player = players.get(currentPlayer);
    player.Points += points;
    io.emit('updateScore', player.PlayerID, player.Points);
}

function discardCard(card, SocketID) {

    let player;

    if(SocketID != -1) {
        player = players.get(SocketID);
        let cardIndex = player.Hand.indexOf(card);
        player.Hand.splice(cardIndex, 1);
    }

    discardPile.push(card);
    currentColor = cardColor(card);
    currentType = cardType(card);
    io.emit('discardCard', card, player);
}

function nextTurn() {
    let player = players.get(currentPlayer);
    var currentPlayerID = player.PlayerID;

    io.to(currentPlayer).emit('notYourTurn', currentPlayerID);
    currentPlayerID += playDirection;

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

    let hasCard = canPlay(currentPlayer, ['none']);
    if(!hasCard) {
        io.to(currentPlayer).emit('canDrawCard');
    }

    player = players.get(currentPlayer);

    if(player.Hand.length <= 2) {
        io.to(currentPlayer).emit('notCalledUnoMe');
    }

    io.to(currentPlayer).emit('yourTurn', currentPlayerID);
}

function canPlay(currentPlayer, invalidCards) {
    let player = players.get(currentPlayer);
    let hasCard = false;
    
    player.Hand.forEach((card) => {
        let playColor = cardColor(card);
        let playType = cardType(card);

        if(!invalidCards.includes(playType)) {
            if(playColor == currentColor || playColor == 'black' || playType == currentType) {
                hasCard = true;
                return hasCard;
            }
        }
    })

    return hasCard;
}

function startGame() {

    var currentPlayerID = Math.floor(Math.random() * players.size);

    players.forEach((player) => {
        player.Hand = [];
        if(player.PlayerID == currentPlayerID) {
            currentPlayer = player.SocketID;
        }
    });

    io.emit('gameStarted', Array.from(players.values()));
    createDeck();
    dealHands();

    let hasCard = canPlay(currentPlayer, ['none']);
    if(!hasCard) {
        io.to(currentPlayer).emit('canDrawCard');
    }
    
    io.to(currentPlayer).emit('yourTurn', currentPlayerID);
}
