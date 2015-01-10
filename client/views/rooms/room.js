var playerContext;
var last; // time of last update
var requestId; // id returned by setInterval

var direction = 0;
var startedMoving;

// TODO: clear out players that disconnect
var players = {}; // local copy of player positions
var map;

var MOVE_TIME = 500; // 500 ms to travel 1 cell
var UPDATE_STEP = 50; // ms per update

var options; // default options for creating new player

function Player (options) {
  var image = new Image();
  image.src = options.image;
  this.image = image;

  this.context = options.context;
  this.width = options.width;
  this.height = options.height;
  this.position = options.position;
  this.direction = options.direction;

  this.frameIndex = 0; // current frame in spritesheet
  this.stepsSinceLast = 0; // steps since last frame change
  this.numFrames = options.numFrames || 1; // how many frames
  this.stepsPerFrame = 2; // how many steps before frame change
}

Player.prototype.move = function (dir, offset) {
  this.direction = dir;
  this.moving = true;

  this.position = nextPosition(this.position, dir, offset);
};

Player.prototype.render = function () {
  if (this.moving) {
    this.stepsSinceLast++;

    if (this.stepsSinceLast > this.stepsPerFrame) {
      this.frameIndex = this.frameIndex >= this.numFrames - 1 ? 0 : this.frameIndex + 1;
      this.stepsSinceLast = 0;
    }
  } else {
    this.frameIndex = 0;
    this.stepsSinceLast = 0;
  }

  var width = Math.max(1, this.width);
  var height = Math.max(1, this.height / this.numFrames);

  this.context.drawImage(
    this.image,
    (this.direction % 4) * width, // source x in spritesheet
    this.frameIndex * height + 1, // source y in spritesheet
    width,
    height,
    this.position.x,
    this.position.y,
    width,
    height
  );
};

function Map (options) {
  var self = this;
  self.background = {
    data: options.background,
    images: _.keys(options.background)
  };
  self.foreground = {
    data: options.foreground,
    images: _.keys(options.foreground)
  };
  self.images = {};
  self.bgContext = options.bgContext;
  self.fgContext = options.fgContext;

  var bgSrcs = self.background.images;
  var fgSrcs = self.foreground.images;
  var imageSrcs = bgSrcs.concat(fgSrcs);

  _.each(imageSrcs, function (src) {
    if (_.has(self.images, src)) return;

    self.images[src] = new Image();
    self.images[src].src = '/' + src + '.png';
  });
}

Map.prototype.render = function (context, options) {
  var self = this;
  var srcs = options.images;
  _.each(srcs, function (src) {
    var image = self.images[src];
    var origin = options.data[src];
    context.drawImage(image, origin.x, origin.y);
  });
};
Map.prototype.renderBg = function () {
  this.render(this.bgContext, this.background);
};
Map.prototype.renderFg = function () {
  this.render(this.fgContext, this.foreground);
};

Template.room.rendered = function () {
  var user = Meteor.user();
  if (!user) return;

  Meteor.call('enterRoom', Session.get('currentRoom'));

  var fgCanvas = this.find('#canvas-foreground');
  var bgCanvas = this.find('#canvas-background');
  var playerCanvas = this.find('#canvas-players');

  var fgContext = fgCanvas.getContext('2d');
  var bgContext = bgCanvas.getContext('2d');
  playerContext = playerCanvas.getContext('2d');

  map = new Map({
    bgContext: bgContext,
    fgContext: fgContext,
    background: this.data.background,
    foreground: this.data.foreground
  });
  map.renderBg();
  map.renderFg();

  // init player
  options = {
    context: playerContext,
    image: '/player.png',
    width: PX_PER_CELL,
    height: 66,
    position: user.game.position,
    numFrames: 3,
    direction: 0
  };

  players[user._id] = new Player(options);
  players[user._id].render();

  var boundKeyDown = keyDown.bind(this.data);
  $(window).on('keydown', boundKeyDown);

  start();
};

Template.room.helpers({
  canvasWidth: CANVAS_WIDTH,
  canvasHeight: CANVAS_HEIGHT,
  nearbyPlayers: function () {
    var user = Meteor.user();
    if (!user) return;

    // retrieve players in vicinity
    return (function (u) {
      var minX = u.position.x - PX_PER_CELL;
      var maxX = u.position.x + PX_PER_CELL;
      var minY = u.position.y - PX_PER_CELL;
      var maxY = u.position.y + PX_PER_CELL;

      var res = Meteor.users.find({ 'game.roomId': u.roomId, $and: [
        { 'game.position.x': { $gte: minX } },
        { 'game.position.x': { $lte: maxX } },
        { 'game.position.y': { $gte: minY } },
        { 'game.position.y': { $lte: maxY } }
      ]}, { fields: { '_id': 1, 'username': 1 } }).fetch();

      return res;
    })(user.game);
  }
});
Template.room.destroyed = function () {
  stop();
};

var start = function () {
  // initialize time of last update
  last = Date.now();

  stop();
  requestId = Meteor.setInterval(main, UPDATE_STEP);
};

var stop = function () {
  if (requestId) {
    Meteor.clearInterval(requestId);
    requestId = null;
  }
};

// update positions of players
var update = function (dt) {
  playerContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  var users = Meteor.users.find({ 'game.roomId': Session.get('currentRoom') }, {
    fields: { 'game': 1 }, sort: { 'game.position.y': 1 }
  });

  // render each player to canvas
  users.forEach(function (user) {
    if (!players[user._id]) {
      options.position = user.game.position;
      players[user._id] = new Player(options);
    }

    (function (player, dir, start, pos) {
      var now = Date.now();
      var moveDone = now > start + MOVE_TIME;

      if (dir && !moveDone) {
        var offset = (dt / MOVE_TIME) * PX_PER_CELL; // fraction of time * total dist

        player.move(dir, offset);
      } else if (!dir) {
        player.moving = false;
        player.position = pos;
      }

      player.render();
    })(players[user._id], user.game.direction, user.game.startTime, user.game.position);
  });
};

// main game loop
function main () {
  var now = Date.now();
  var dt = now - last; // time since last update

  // make sure previous move completed before updating position
  var moveDone = now >= startedMoving + MOVE_TIME;
  if (startedMoving && moveDone) {
    var user = Meteor.user();
    var newPos = nextPosition(user.game.position, direction);

    Meteor.call('setPosition', newPos);
    startedMoving = null;
    direction = 0;
  }

  update(dt);
  last = now;
}

function keyDown (event) {
  event.preventDefault();

  var user = Meteor.user();
  var key = event.keyCode || event.which;
  var move = { 38: 1, 39: 3, 40: 4, 37: 2 }[key];

  // if moving already or invalid key
  if (!user || user.game.direction || !move) return;

  // TODO: only if valid move (e.g no wall), update direction
  var newPos = nextPosition(user.game.position, move);
  if (_.some(this.walls, function (wall) {
    return (
      newPos.x < wall.x + wall.w &&
      newPos.x >= wall.x &&
      newPos.y < wall.y + wall.h - PX_PER_CELL &&
      newPos.y >= wall.y - PX_PER_CELL
    );
  })) return;

  direction = move;
  startedMoving = last;
  Meteor.call('setDirection', direction, startedMoving);
}








