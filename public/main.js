const socket = io({autoConnect: false});

const cdWidth = 120;
const cdHeight = 180;
const cards = new Image();
const back = new Image();
var socketId = -1;
var playerId = -1;
var players = 0;
var playerName;

let isPlayerA = false;
let currentColor = null;

const sidePanel = document.getElementById('side-panel');
const collapseButton = document.getElementById('collapse-btn');

collapseButton.addEventListener('click', () => {
    sidePanel.classList.toggle('collapsed');
});

socket.on('connect', function() {
    // Try to join the game
    socketId = socket.id;
    socket.emit('requestJoin', playerName);
});

socket.on('isPlayerA', function() {
    // Show game controls to the first player to join
    isPlayerA = true;
    document.getElementById('btnStart').style.display="inline-block";
    document.getElementById('btnOptions').style.display="inline-block";
});

socket.on('gameStarted', function(players) {
    var audio = new Audio('audio/game-start.wav');
    audio.play();

    // Show/hide elements for in-game state
    document.getElementById("status").style.display="none";
    document.getElementById('btnDeal').style.display="none";
    document.getElementById('uno-buttons').style.display="flex";
    document.getElementById('discard').style.display="inline-block";

    // Get this player's ID
    for(var i = 0; i < players.length; i++) {
        if(players[i].SocketID == socketId) {
            playerId = players[i].PlayerID;
        }
    }

    // Display players
    createPlayersUI(players);
});

socket.on('newPlayer', function(playersInLobby) {
    // Update the list and count of players
    document.getElementById('playerList').innerHTML = "<strong>Players:</strong> " + playersInLobby.join(', ');
    players = playersInLobby.length;
});

socket.on('chooseColor', function() {
    // Display the buttons to let the player pick a color after wild
    document.getElementById('color-buttons').style.display="flex";
});

socket.on('colorChosen', function(color) {
    currentColor = color;
    // Display which color was selected after a wild
    document.getElementById('color-bar').style.background=color;
});

socket.on('hideColor', function() {
    // Hide the color bar now that we've moved past the wild
    document.getElementById('color-bar').style.background="rgb(184, 184, 184)";
});

socket.on('hideDraw', function() {
    document.getElementById('btnDraw').style.display="none";
});

socket.on('turnChange', function(PlayerID) {
    // Mark all players as inactive
    for(let i = 0; i < players; i++) {
        document.getElementById('player_' + i).classList.remove('active');
    }

    // Mark the player whose turn it is as active
    document.getElementById('player_' + PlayerID).classList.add('active');

    if(PlayerID == playerId) {
        document.getElementById('btnUnoMe').style.background="#222";
        var audio = new Audio('audio/turn-change.wav');
        audio.play();

        const topCard = {
            Color: document.getElementById('discard').getAttribute('dataCardColor'),
            Type: document.getElementById('discard').getAttribute('dataCardType')
        };
        
        updatePlayableCards(topCard, currentColor);
    } else {
        const hand = document.getElementById('hand_' + playerId);
        if (hand) {
            hand.querySelectorAll('.card').forEach(c => c.classList.add('unplayable'));
        }
    }
});

socket.on('canDrawCard', function() {
    // If the player needs to draw a card, display the draw button
    document.getElementById('btnDraw').style.display="inline-block";
});

socket.on('calledUnoMe', function() {
    // If the player has already called Uno, gray the Uno button out
    document.getElementById('btnUnoMe').style.background="gray";
});

socket.on('notCalledUnoMe', function() {
    // If the player hasn't already called Uno, make the button not grayed out
    document.getElementById('btnUnoMe').style.background="#222";
});

socket.on('updateScore', function(player, points) {
    // Update the points of the player who won the game
    document.getElementById('points_' + player).innerHTML = points;
});

socket.on('gameOver', function(playerName) {
    var audio = new Audio('audio/game-over.wav');
    audio.play();

    // Display a winner message
    document.getElementById('status').innerHTML = playerName + ' WON';
    document.getElementById("status").style.display="inline-block";

    // Display the deal button to the player in control of the game
    if(isPlayerA) {
        document.getElementById("btnDeal").style.display="inline-block";
    }
});

socket.on('renderCard', function(card, player) {
    // Display a card
    var hand = document.getElementById('hand_' + player.PlayerID);
    var cardObj = getCardUI(card, player);

    hand.appendChild(cardObj);

    repositionCards(player);

    if(player.SocketID == socketId) {
        const topCard = {
            Color: document.getElementById('discard').getAttribute('dataCardColor'),
            Type: document.getElementById('discard').getAttribute('dataCardType')
        };

        const activeColor = currentColor || topCard.Color;

        updatePlayableCards(topCard, activeColor);
    }
});

socket.on('logMessage', function(message) {
    const messageContainer = document.getElementById('message-container');
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    messageElement.textContent = message;
    messageContainer.insertBefore(messageElement, messageContainer.firstChild);
});

function getCardUI(card, player) {
    // Get card image
    var cardObj = document.createElement('div');

    cardObj.className = 'card';
    cardObj.id = 'card_' + card.ID;
    cardObj.setAttribute('dataCardColor', card.Color);
    cardObj.setAttribute('dataCardType', card.Type);
    
    // Discard pile or the player
    if(player == null || player.SocketID == socketId) {

        // Get card image from sprite sheet
        const offsetX = 2 + 1680 - cdWidth * (card.ID % 14);
        const offsetY = 1440 - cdHeight * Math.floor(card.ID / 14);
        cardObj.style.backgroundImage = 'url(' + cards.src + ')';
        cardObj.style.backgroundPosition = `${offsetX}px ${offsetY}px`;

        if(player != null) {
            // Make the card clickable if it's for the player
            cardObj.addEventListener('click', () => playCard(card, player));

            // Bump cards up on the screen when they're hovered over
            cardObj.addEventListener('mouseenter', function () {
                cardObj.style.transform = 'scale(0.6) translateY(-50px)';
            });

            cardObj.addEventListener('mouseleave', function () {
                cardObj.style.transform = 'scale(0.6) translateY(0)';
            });
        }
    } else {
        // Display back of card for opponent cards
        cardObj.style.backgroundImage = 'url(' + back.src + ')';
        cardObj.style.backgroundSize = '100%';
    }

    return cardObj;
}

function repositionCards(player) {
    // Adjust card positioning as new cards get added to a hand
    const hand = document.getElementById('hand_' + player.PlayerID);
    if (!hand) return;

    const cards = Array.from(hand.children);
    const cardCount = cards.length;

    if(player.SocketID == socketId) {
        cards.sort((a, b) => {
            const colorDiff = a.getAttribute('dataCardColor').localeCompare(b.getAttribute('dataCardColor'));
            if (colorDiff !== 0) return colorDiff;
            return a.getAttribute('dataCardType').localeCompare(b.getAttribute('dataCardType'));
        });

        hand.innerHTML = '';

        var i = 0;
        cards.forEach(card => {
            // As more cards as drawn, overlap them more
            var marginLeft = i === 0 ? '-20' : -5 * (cardCount - 1) + 5;
            if(marginLeft < -59){marginLeft = -59;}
            card.style.marginLeft = marginLeft + 'px';
            i++;

            hand.appendChild(card);
        });
    } else {
        // For opponent hands, just append in order
        hand.innerHTML = '';
        cards.forEach((card, i) => hand.appendChild(card));
    }
}

function updatePlayableCards(topCard, currentColor) {
    const hand = document.getElementById('hand_' + playerId);
    if (!hand) return;

    const cards = hand.querySelectorAll('.card');
    cards.forEach(card => {
        const cardColor = card.getAttribute('dataCardColor');
        const cardType = card.getAttribute('dataCardType');

        let playable = false;

        if (cardColor === currentColor) playable = true;
        if (cardType === topCard.Type) playable = true;
        if (cardColor === 'black') playable = true;

        if (playable) {
            card.classList.remove('unplayable');
        } else {
            card.classList.add('unplayable');
        }
    });
}

function playCard(card, player) {
    // Attempt to play a card
    socket.emit('playCard', card);

    repositionCards(player);
}

socket.on('discardCard', function(card, player) {
    currentColor = card.Color;

    // Add a card to the discard pile
    var cardObj = getCardUI(card);
    cardObj.id = 'discard';

    // If it's a real player
    // Basically just ignores the initial discard after a new deal
    if(player != null) {
        document.getElementById('card_' + card.ID).remove();
        repositionCards(player);
    }

    var discard = document.getElementById('discard');
    discard.parentNode.replaceChild(cardObj, discard);
});

function setCookie(name, value, seconds) {
    // Save a cookie with the player name
    let date = new Date();
    date.setTime(date.getTime() + (seconds * 1000));
    let expires = "expires=" + date.toUTCString();
    document.cookie = name + "=" + value + ";" + expires + ";path=/";
}

function getCookie(name) {
    // Get the player name from a cookie if it exists
    name += "=";
    let cookies = document.cookie.split(';');
    for(let i = 0; i < cookies.length; i++) {
        let cookie = cookies[i];
        while(cookie.charAt(0) === ' ') {
            cookie = cookie.substring(1);
        }
        if(cookie.indexOf(name) === 0) {
            return cookie.substring(name.length, cookie.length);
        }
    }
    return null;
}

function resetGame() {
    // Start a new match
    socket.emit('resetGame');
}

function newHand() {
    // Deal a new hand within the same match
    socket.emit('newHand');
}

function drawCard() {
    // Draw a card
    document.getElementById('btnDraw').style.display="none";
    socket.emit('drawCard');
}

function setColor(color) {
    // Set a new color after a color button has been clicked after a wild
    document.getElementById('color-buttons').style.display="none";
    socket.emit('colorChosen', color);
}

function createPlayersUI(players) {
    // Display the players
    document.getElementById('player0').innerHTML = '';
    document.getElementById('player1').innerHTML = '';
    document.getElementById('player2').innerHTML = '';
    document.getElementById('player3').innerHTML = '';
    document.getElementById('player4').innerHTML = '';
    document.getElementById('player5').innerHTML = '';
    document.getElementById('player6').innerHTML = '';
    document.getElementById('playerSelf').innerHTML = '';

    for(var i = 0; i < players.length; i++) {
        var div_player = document.createElement('div');
        var div_player_name = document.createElement('div');
        var div_hand = document.createElement('div');
        var div_points = document.createElement('div');

        div_player_name.className = 'name';
        div_points.className = 'points';
        div_points.id = 'points_' + players[i].PlayerID;
        div_player.className = 'player';
        div_player.id = 'player_' + players[i].PlayerID;
        div_hand.className = 'hand';
        div_hand.id = 'hand_' + players[i].PlayerID;

        div_player_name.innerHTML = players[i].Name;
        div_points.innerHTML = 'Points: ' + players[i].Points;
        div_player.appendChild(div_hand);
        div_player.appendChild(div_player_name);
        div_player.appendChild(div_points);

        if(players[i].SocketID == socketId) {
            // Add the player to the bottom of the screen
            document.getElementById('playerSelf').appendChild(div_player);
        } else {
            // Add opponents to spots around the table based on player order in the game
            let player_location = playerId - players[i].PlayerID;

            if(player_location < 0) {
                player_location += 8;
            }

            switch(player_location) {
                case 1:
                    player_location = 5;
                    break;
                case 2:
                    player_location = 3;
                    break;
                case 3:
                    player_location = 0;
                    break;
                case 4:
                    player_location = 1;
                    break;
                case 5:
                    player_location = 2;
                    break;
                case 6:
                    player_location = 4;
                    break;
                case 7:
                    player_location = 6;
                    break;
            }

            document.getElementById('player' + player_location).appendChild(div_player);
        }
    }
}

function unoMe() {
    // Send a message that the player called uno
    socket.emit('unoMe');
}

function unoYou() {
    // Send a message that the player called uno on someone else
    socket.emit('unoYou');
}

function showOptions() {
    // Display the game options
    document.getElementById('options').style.display = 'flex';
}

function saveOptions() {
    // Save the chosen game options and send to the server
    document.getElementById('options').style.display = 'none';
    let checkboxes = document.querySelectorAll('#options input[type="checkbox"]:checked');
    let selectedValues = Array.from(checkboxes).map(checkbox => checkbox.value);

    socket.emit('saveOptions', {options: selectedValues});
}

function init() {
    // Load initial state
    cards.src = 'images/deck_full.png';
    back.src = 'images/quno.png';
  
    // Get the player name
    playerName = getCookie('playerName');
    if(playerName == null) {
        // Default autogenerated name
        let defaultName = 'Player' + Math.floor(1000 + Math.random() * 9000);

        // Prompt player for a new name
        playerName = prompt('Enter your name: ', defaultName);

        if (playerName === null || playerName === "") {
            playerName = defaultName;
        } else {
            // Save the name in a cookie
            setCookie('playerName', playerName, 24 * 3600);
        }
    }
  
    // Connect to the server
    socket.connect();
}


init();
