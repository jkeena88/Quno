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
var cardsToDraw;
var discardPile = new Array();
let players = new Map();
let deck = new Array();


/**
 * Whenever a client connects
 * @function
 * @param {Socket} socket Client socket
 */
function onConnection(socket) {

    if(io.engine.clientsCount == 1) {
        io.emit('isPlayerA');
    }

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
            io.to(socket.id).emit('responseRoom', [people + 1, maxPlayers]);

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

    socket.on('playCard', function(card) {
        let playColor = cardColor(card);
        let playType = cardType(card);

        if(socket.id == currentPlayer) {
            if(playColor == currentColor || playColor == 'black' || playType == currentType) {
                let player = players.get(socket.id);
                discardCard(card, socket.id);

                checkForWin(socket.id);

                /*
                if(player.Hand.length == 1) {
                    player.NeedsCallUno = true;
                } else {
                    player.NeedsCallUno = false;
                }
                */
                io.emit('hideColor');
                
                if(playType == 'wild') {
                    io.to(socket.id).emit('chooseColor');
                } else if(playType == 'draw4') {
                    cardsToDraw = 4;
                    io.to(socket.id).emit('chooseColor');
                } else if(playType == 'skip') {
                    nextTurn();
                    nextTurn();
                } else if(playType == 'reverse') {
                    playDirection = -playDirection;
                    nextTurn();
                } else if(playType == 'draw2') {
                    nextTurn();
                    drawCard(currentPlayer, 2);
                    nextTurn();
                } else {
                    nextTurn();
                }
            }
        }
    });

    socket.on('drawCard', function() {
        let player = players.get(socket.id);
        player.HasCalledUno = false;
        io.to(socket.id).emit('notCalledUnoMe');
        drawCard(socket.id, 1);
    });

    socket.on('colorChosen', function(color) {
        io.emit('colorChosen', color);
        currentColor = color;
        nextTurn();
        
        if(cardsToDraw > 0) {
            drawCard(currentPlayer, cardsToDraw);
            nextTurn();
        }
        cardsToDraw = 0;
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

function createPlayers(num) {
    players.clear();
    var i = 0;

    io.sockets.sockets.forEach((socket) => {
        var hand = new Array();
        var player = {Name: socket.playerName, PlayerID: i, Points: 0, Hand: hand, SocketID: socket.id, NeedsCallUno: false, HasCalledUno: false};
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

    card = deck.pop();
    discardCard(card, -1);
}

function drawCard(SocketID, num) {
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
        canPlay(currentPlayer);
    }
}

function checkForWin(SocketID) {
    let player = players.get(SocketID);

    if(player.Hand.length == 0) {
        getPoints(players);
        io.emit('gameOver', player.Name);
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
    var currentPlayerID = players.get(currentPlayer).PlayerID;

    io.to(currentPlayer).emit('notYourTurn', currentPlayerID);
    currentPlayerID += playDirection;

    if(currentPlayerID < 0) {
        currentPlayerID += players.size;
    } else if(currentPlayerID >= players.size) {
        currentPlayerID -= players.size;
    }

    players.forEach((player) => {
        if(player.PlayerID == currentPlayerID) {
            currentPlayer = player.SocketID;
        }
    });

    canPlay(currentPlayer);
    io.to(currentPlayer).emit('yourTurn', currentPlayerID);
}

function canPlay(currentPlayer) {
    let player = players.get(currentPlayer);
    let hasCard = false;
    
    player.Hand.forEach((card) => {
        let playColor = cardColor(card);
        let playType = cardType(card);

        if(playColor == currentColor || playColor == 'black' || playType == currentType) {
            hasCard = true;
            return;
        }
    })

    if(!hasCard) {
        io.to(player.SocketID).emit('canDrawCard');
    }
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
    canPlay(currentPlayer);
    io.to(currentPlayer).emit('yourTurn', currentPlayerID);
}
