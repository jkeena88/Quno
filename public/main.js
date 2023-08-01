const socket = io({autoConnect: false});

const cdWidth = 120;
const cdHeight = 180;
const cards = new Image();
const back = new Image();
var socketId = -1;
var playerId = -1;
var players = 0;

let isPlayerA = false;

socket.on('connect', requestJoin);

socket.on('isPlayerA', function() {
    isPlayerA = true;
    document.getElementById('btnStart').style.display="inline-block";
    document.getElementById('btnOptions').style.display="inline-block";
});

socket.on('gameStarted', function(players) {
    document.getElementById("status").style.display="none";
    document.getElementById('btnDeal').style.display="none";
    document.getElementById('uno-buttons').style.display="flex";
    document.getElementById('discard').style.display="inline-block";

    for(var i = 0; i < players.length; i++) {
        if(players[i].SocketID == socketId) {
            playerId = players[i].PlayerID;
        }
    }

    console.log(players);
    createPlayersUI(players);
});

socket.on('newPlayer', function(playersInLobby) {
    document.getElementById('playerList').innerHTML = "<strong>Players:</strong> " + playersInLobby.join(', ');
    players = playersInLobby.length;
});

socket.on('chooseColor', function() {
    document.getElementById('color-buttons').style.display="flex";
});

socket.on('colorChosen', function(color) {
    document.getElementById('discard').style.background=color;
});

socket.on('hideColor', function() {
    document.getElementById('discard').style.background="white";
});

socket.on('turnChange', function(PlayerID) {
    for(let i = 0; i < players; i++) {
        document.getElementById('player_' + i).classList.remove('active');
    }
    document.getElementById('player_' + PlayerID).classList.add('active');
});

socket.on('canDrawCard', function() {
    document.getElementById('btnDraw').style.display="inline-block";
});

socket.on('calledUnoMe', function() {
    document.getElementById('btnUnoMe').style.background="gray";
});

socket.on('notCalledUnoMe', function() {
    document.getElementById('btnUnoMe').style.background="#222";
});

socket.on('updateScore', function(player, points) {
    document.getElementById('points_' + player).innerHTML = points;
});

socket.on('gameOver', function(playerName) {
    document.getElementById('status').innerHTML = playerName + ' WON';
    document.getElementById("status").style.display="inline-block";

    if(isPlayerA) {
        console.log(isPlayerA);
        document.getElementById("btnDeal").style.display="inline-block";
    }
});

socket.on('renderCard', function(card, player) {
    var hand = document.getElementById('hand_' + player.PlayerID);
    var cardObj = getCardUI(card, player);

    hand.appendChild(cardObj);

    repositionCards(player);
});

function getCardUI(card, player) {
    var cardObj = document.createElement('div');

    cardObj.className = 'card';
    cardObj.id = 'card_' + card;
    
    if(player == null || player.SocketID == socketId) {
        const offsetX = 2 + 1680 - cdWidth * (card % 14);
        const offsetY = 1440 - cdHeight * Math.floor(card / 14);
        cardObj.style.backgroundImage = 'url(' + cards.src + ')';
        cardObj.style.backgroundPosition = `${offsetX}px ${offsetY}px`;

        if(player != null) {
            cardObj.addEventListener('click', () => playCard(card, player));

            cardObj.addEventListener('mouseenter', function () {
            cardObj.style.transform = 'translateY(-50px)';
            });

            cardObj.addEventListener('mouseleave', function () {
            cardObj.style.transform = 'translateY(0)';
            });
        }
    } else {
        cardObj.style.backgroundImage = 'url(' + back.src + ')';
        cardObj.style.backgroundSize = '100%';
    }

    return cardObj;
}

function repositionCards(player) {
    var hand = document.getElementById('hand_' + player.PlayerID);
    var cardCount = hand.children.length;

    for(var i = 0; i < cardCount; i++) {
        var cardElement = hand.children[i];
        var marginLeft = i === 0 ? '-20' : -5 * (cardCount - 1) + 5;
        if(marginLeft < -59){marginLeft = -59;}
        cardElement.style.marginLeft = marginLeft + 'px';
    }
}

function playCard(card, player) {
    socket.emit('playCard', card);

    repositionCards(player);
}

socket.on('discardCard', function(card, player) {
    var cardObj = getCardUI(card);
    cardObj.id = 'discard-top';

    if(player != null) {
        document.getElementById('card_' + card).remove();
        repositionCards(player);
    }

    var discard = document.getElementById('discard-top');
    discard.parentNode.replaceChild(cardObj, discard);
});

function init() {
    cards.src = 'images/deck_full.png';
    back.src = 'images/quno.png';
  
    playerName = getCookie('playerName');
    if(playerName == null) {
        let defaultName = 'Player' + Math.floor(1000 + Math.random() * 9000);
        playerName = prompt('Enter your name: ', defaultName);
        if (playerName === null || playerName === "") {
            playerName = defaultName;
        } else {
            setCookie('playerName', playerName, 24 * 3600);
        }
    }
  
    socket.connect();
}

function setCookie(name, value, seconds) {
    let date = new Date();
    date.setTime(date.getTime() + (seconds * 1000));
    let expires = "expires=" + date.toUTCString();
    document.cookie = name + "=" + value + ";" + expires + ";path=/";
}

function getCookie(name) {
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

function requestJoin() {
    socketId = socket.id;
    socket.emit('requestJoin', playerName);
}

function resetGame() {
    socket.emit('resetGame');
}

function newHand() {
    socket.emit('newHand');
}

function drawCard() {
    document.getElementById('btnDraw').style.display="none";
    socket.emit('drawCard');
}

function setColor(color) {
    document.getElementById('color-buttons').style.display="none";
    socket.emit('colorChosen', color);
}

function createPlayersUI(players) {
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
            document.getElementById('playerSelf').appendChild(div_player);
        } else {
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
    socket.emit('unoMe');
}

function unoYou() {
    socket.emit('unoYou');
}

function showOptions() {
    document.getElementById('options').style.display = 'flex';
}

function saveOptions() {
    document.getElementById('options').style.display = 'none';
    let checkboxes = document.querySelectorAll('#options input[type="checkbox"]:checked');
    let selectedValues = Array.from(checkboxes).map(checkbox => checkbox.value);

    socket.emit('saveOptions', {options: selectedValues});
}


init();
