const socket = io({autoConnect: false});

const cdWidth = 120;
const cdHeight = 180;
const cards = new Image();
const back = new Image();

let isPlayerA = false;

socket.on('connect', requestJoin);

socket.on('isPlayerA', function() {
    isPlayerA = true;
    document.getElementById('btnStart').style.display="inline-block";
});

socket.on('gameStarted', function(players) {
    document.getElementById("status").style.display="none";
    document.getElementById('btnStart').style.display="none";
    createPlayersUI(players);
});

socket.on('yourTurn', function(PlayerID) {
    document.getElementById('player_' + PlayerID).classList.add('active');
});

socket.on('chooseColor', function() {
    document.getElementById('color-buttons').style.display="inline-block";
});

socket.on('notYourTurn', function(PlayerID) {
    document.getElementById('player_' + PlayerID).classList.remove('active');
    document.getElementById('btnDraw').style.display="none";
});

socket.on('canDrawCard', function() {
    document.getElementById('btnDraw').style.display="inline-block";
});

socket.on('updateScore', function(player, points) {
    document.getElementById('points_' + player).innerHTML = points;
});

socket.on('gameOver', function(playerName) {
    document.getElementById('status').innerHTML = playerName + ' WON';
    document.getElementById("status").style.display="inline-block";
    document.getElementById("btnDeal").style.display="inline-block";
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
    
    const offsetX = 1680 - cdWidth * (card % 14); // X-coordinate of the top-left corner of the portion
    const offsetY = 1440 - cdHeight * Math.floor(card / 14); // Y-coordinate of the top-left corner of the portion
    cardObj.style.backgroundImage = 'url(' + cards.src + ')';
    //cardObj.style.backgroundSize = '300%';
    cardObj.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
    cardObj.addEventListener('click', () => playCard(card, player));

    cardObj.addEventListener('mouseenter', function () {
      cardObj.style.transform = 'translateY(-50px)';
    });

    cardObj.addEventListener('mouseleave', function () {
      cardObj.style.transform = 'translateY(0)';
    });

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
    back.src = 'images/uno.svg';
  
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
    socket.emit('requestJoin', playerName);
}

function resetGame() {
    socket.emit('resetGame');
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
    document.getElementById('players').innerHTML = '';
    for(var i = 0; i < players.length; i++) {
        var div_player = document.createElement('div');
        var div_player_name = document.createElement('div');
        var div_hand = document.createElement('div');
        var div_points = document.createElement('div');

        div_points.className = 'points';
        div_points.id = 'points_' + players[i].PlayerID;
        div_player.className = 'player';
        div_player.id = 'player_' + players[i].PlayerID;
        div_hand.className = 'hand';
        div_hand.id = 'hand_' + players[i].PlayerID;

        div_player_name.innerHTML = players[i].Name;
        div_points.innerHTML = 'Points: ' + players[i].Points;
        div_player.appendChild(div_player_name);
        div_player.appendChild(div_hand);
        div_player.appendChild(div_points);
        document.getElementById('players').appendChild(div_player);
    }
}


init();